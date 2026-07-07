import type { GitHubPRFile } from '../types/github';
import type { Env } from '../types/env';
import type { ReviewFinding } from '../types/review';
import { cachedGitHubFetch, CACHE_TTLS } from './cache';
import { createProgressiveChunks } from './progressive-chunking';
import { runStaticPlugins } from './plugins/index';
import {
    MAX_FILE_SIZE_BYTES,
    MAX_TOTAL_FILES,
    TIER1_MAX_FILES,
    NOISE_EXTENSIONS,
    NOISE_FILENAMES,
    NOISE_DIRECTORIES,
    PRIORITY_EXTENSIONS,
    GLOBAL_CONTEXT_BUDGET_CHARS,
} from '../config/constants';
import { retryWithBackoff, circuitBreakers } from './retry';
import { logger } from './logger';
import { RateLimitError } from './errors';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub limits comment/check-run text to 65,535 characters.
 * This constant leaves room for the truncation notice we append.
 */
const GITHUB_MAX_BODY_CHARS = 64_000;

/**
 * Structure-aware markdown truncation.
 *
 * Instead of slicing mid-sentence or mid-code-block, finds the last
 * clean section boundary (`---`, `## `, or `### `) within the limit
 * and appends a truncation notice.
 */
function truncateMarkdown(text: string, maxChars: number = GITHUB_MAX_BODY_CHARS): string {
    if (text.length <= maxChars) return text;

    // Search for the last section boundary within the limit
    const searchRegion = text.slice(0, maxChars);

    // Try progressively less granular boundaries
    let cutPoint = searchRegion.lastIndexOf('\n---');
    if (cutPoint < maxChars * 0.5) cutPoint = searchRegion.lastIndexOf('\n## ');
    if (cutPoint < maxChars * 0.5) cutPoint = searchRegion.lastIndexOf('\n### ');
    if (cutPoint < maxChars * 0.5) cutPoint = searchRegion.lastIndexOf('\n\n');
    if (cutPoint < maxChars * 0.3) cutPoint = maxChars; // Fallback: hard cut

    const truncated = text.slice(0, cutPoint);

    // Close any unclosed code fences
    const openFences = (truncated.match(/```/g) || []).length;
    const needsClose = openFences % 2 !== 0;

    return truncated
        + (needsClose ? '\n```' : '')
        + '\n\n---\n\n'
        + '> ⚠️ **Review truncated** — the full review exceeded GitHub\'s character limit. '
        + `Showing ${Math.round(cutPoint / text.length * 100)}% of the review. `
        + 'Lower-priority findings may be omitted.\n';
}

function githubHeaders(token: string): HeadersInit {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-reviewer-agent/1.0',
    };
}

// ---------------------------------------------------------------------------
// PR Data Fetching (with pagination)
// ---------------------------------------------------------------------------

/**
 * Fetches ALL files changed in a Pull Request, handling GitHub pagination.
 * GitHub returns max 100 files per page and max 3000 total.
 * We cap at MAX_TOTAL_FILES to stay practical.
 * Includes retry logic and circuit breaker protection.
 */
export async function fetchChangedFiles(
    repoFullName: string,
    prNumber: number,
    token: string,
    env: Env,
    headSha?: string
): Promise<GitHubPRFile[]> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        throw new Error('GitHub API circuit breaker is OPEN - too many failures');
    }

    const executeFetch = async (): Promise<GitHubPRFile[]> => {
        const allFiles: GitHubPRFile[] = [];
        let page = 1;

        while (allFiles.length < MAX_TOTAL_FILES) {
            const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100&page=${page}`;

            // Note: cachedGitHubFetch handles the 429 extraction automatically inside cache.ts
            const files = await cachedGitHubFetch<GitHubPRFile[]>(
                env.CACHE_KV,
                url,
                { headers: githubHeaders(token) },
                { ttlSeconds: CACHE_TTLS.PR_FILES, staleWhileRevalidate: false },
                async (u, i) => fetch(u, i),
                'json',
                headSha  // SHA-keyed cache: different commits produce different cache keys
            );

            if (files.length === 0) break; // No more pages

            allFiles.push(...files);
            page++;

            // GitHub caps at 3000 files; stop if we got fewer than 100 (last page)
            if (files.length < 100) break;
        }

        // Filter out deleted files (they have no content to review)
        return allFiles
            .filter((f) => f.status !== 'removed')
            .slice(0, MAX_TOTAL_FILES);
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeFetch,
            'GitHub fetch changed files',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`GitHub API call succeeded after ${attempts} attempts`, {
                operation: 'fetchChangedFiles',
                attempts,
                totalDelayMs,
            });
        }

        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Smart File Classification
// ---------------------------------------------------------------------------

/** The result of classifying PR files into review tiers. */
export interface ClassifiedFiles {
    /** Top priority files — get full content + diff patch */
    tier1: GitHubPRFile[];
    /** Remaining files — get diff patch only (no subrequest) */
    tier2: GitHubPRFile[];
    /** Filenames that were auto-skipped (noise) */
    skipped: string[];
}

/**
 * Returns true if the file should be auto-skipped (noise, generated, vendor, etc.)
 */
function isNoiseFile(file: GitHubPRFile): boolean {
    const filename = file.filename;
    const basename = filename.split('/').pop() ?? '';
    const ext = basename.includes('.') ? basename.split('.').pop()?.toLowerCase() ?? '' : '';

    // Check exact filename matches
    if (NOISE_FILENAMES.has(basename)) return true;

    // Check extension matches
    if (NOISE_EXTENSIONS.has(ext)) return true;

    // Check for compound extensions like .min.js, .chunk.css
    const lastTwoParts = basename.split('.').slice(-2).join('.');
    if (NOISE_EXTENSIONS.has(lastTwoParts)) return true;

    // Check directory prefix matches
    for (const dir of NOISE_DIRECTORIES) {
        if (filename.startsWith(dir) || filename.includes(`/${dir}`)) return true;
    }

    // Skip files with no patch AND no meaningful content (binary files)
    if (!file.patch && file.changes === 0) return true;

    return false;
}

/**
 * Calculates a priority score for a file.
 * Higher score = more important to review deeply.
 */
function filePriorityScore(file: GitHubPRFile): number {
    const ext = file.filename.split('.').pop()?.toLowerCase() ?? '';
    let score = file.additions + file.deletions; // Raw change volume

    // Bonus for source code files (business logic)
    if (PRIORITY_EXTENSIONS.has(ext)) {
        score *= 2;
    }

    // Bonus for new files (they need careful review)
    if (file.status === 'added') {
        score *= 1.5;
    }

    // Bonus for files in src/ or app/ directories (likely core code)
    if (file.filename.startsWith('src/') || file.filename.startsWith('app/')) {
        score *= 1.3;
    }

    return score;
}

/**
 * Classifies PR files into review tiers:
 * - **Tier 1** (top TIER1_MAX_FILES by priority): Full content + diff patch
 * - **Tier 2** (remaining reviewable files): Diff patch only
 * - **Skipped**: Noise files excluded from review entirely
 */
export function classifyFiles(files: GitHubPRFile[]): ClassifiedFiles {
    const skipped: string[] = [];
    const reviewable: GitHubPRFile[] = [];

    // Step 1: Separate noise from reviewable
    for (const file of files) {
        if (isNoiseFile(file)) {
            skipped.push(file.filename);
        } else {
            reviewable.push(file);
        }
    }

    // Step 2: Sort reviewable files by priority score (highest first)
    reviewable.sort((a, b) => filePriorityScore(b) - filePriorityScore(a));

    // Step 3: Split into Tier 1 (full context) and Tier 2 (diff only)
    const tier1 = reviewable.slice(0, TIER1_MAX_FILES);
    const tier2 = reviewable.slice(TIER1_MAX_FILES);

    return { tier1, tier2, skipped };
}

// ---------------------------------------------------------------------------
// File Content Fetching
// ---------------------------------------------------------------------------

/**
 * Fetches the raw content of a file from its raw_url.
 * Returns null if the file is too large or the request fails.
 * Includes retry logic for transient failures.
 */
export async function fetchFileContent(rawUrl: string, token: string, env: Env): Promise<string | null> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping file content fetch');
        return null;
    }

    const executeFetch = async (): Promise<string | null> => {
        const text = await cachedGitHubFetch<string>(
            env.CACHE_KV,
            rawUrl,
            { headers: githubHeaders(token) },
            { ttlSeconds: CACHE_TTLS.FILE_CONTENT, staleWhileRevalidate: true },
            async (u, i) => {
                const response = await fetch(u, i);

                // Extra safety check during fetch before reading body
                const contentLength = response.headers.get('Content-Length');
                if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_BYTES) {
                    // Fast abort for huge files
                    throw new Error(`FILE_TOO_LARGE:${contentLength}`);
                }
                return response;
            },
            'text'
        ).catch(err => {
            if (err.message.startsWith('FILE_TOO_LARGE:')) {
                const size = err.message.split(':')[1];
                return `[File too large to include — ${size} bytes. Review diff only.]`;
            }
            throw err;
        });

        // If it was already caught for size in the fast path, return it directly
        if (text && text.startsWith('[File too large to include')) {
            return text;
        }

        // Secondary size check on the body itself (sometimes Content-Length is missing)
        if (text.length > MAX_FILE_SIZE_BYTES) {
            return `[File too large to include — ${text.length} chars. Review diff only.]`;
        }

        return text;
    };

    try {
        const { result } = await retryWithBackoff(
            executeFetch,
            'GitHub fetch file content',
            {
                maxAttempts: 2, // Fewer retries for file content (not critical)
                initialDelayMs: 500,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();
        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        return null; // Fail gracefully - return null to use diff only
    }
}

// ---------------------------------------------------------------------------
// Global PR Context (prepended to EVERY chunk)
// ---------------------------------------------------------------------------

/**
 * Builds a global context string that gets prepended to every chunk.
 * This ensures every LLM call knows the full scope of the PR,
 * even if it only sees a subset of the files.
 */
export function buildGlobalContext(
    classified: ClassifiedFiles,
    importGraph?: Map<string, string[]>
): string {
    const { tier1, tier2, skipped } = classified;
    const allReviewable = [...tier1, ...tier2];

    let ctx = `# Global PR Context\n\n`;
    ctx += `> This context appears in every review chunk so you understand the full PR scope.\n\n`;
    ctx += `## Files in This PR (${allReviewable.length} reviewable, ${skipped.length} skipped)\n\n`;

    // Table header
    ctx += `| Tier | File | Status | +/- |\n|---|---|---|---|\n`;

    for (const f of tier1) {
        ctx += `| 🔍 T1 | \`${f.filename}\` | ${f.status} | +${f.additions}/-${f.deletions} |\n`;
    }
    for (const f of tier2) {
        ctx += `| 📄 T2 | \`${f.filename}\` | ${f.status} | +${f.additions}/-${f.deletions} |\n`;
    }

    if (skipped.length > 0) {
        const preview = skipped.slice(0, 15).join(', ');
        ctx += `\n> _Skipped (noise):_ ${preview}${skipped.length > 15 ? ` ... +${skipped.length - 15} more` : ''}\n`;
    }

    // Import dependency graph — gives the LLM cross-file awareness
    if (importGraph && importGraph.size > 0) {
        ctx += `\n## Import Dependencies (files in this PR)\n\n`;
        for (const [file, imports] of importGraph) {
            if (imports.length > 0) {
                ctx += `- \`${file}\` imports from: ${imports.map(i => `\`${i}\``).join(', ')}\n`;
            }
        }
    }

    ctx += `\n---\n\n`;

    // If the global context is too large (huge PRs), truncate the file list
    if (ctx.length > GLOBAL_CONTEXT_BUDGET_CHARS) {
        ctx = ctx.slice(0, GLOBAL_CONTEXT_BUDGET_CHARS - 100);
        ctx += `\n\n_[... file list truncated — ${allReviewable.length} total files]_\n\n---\n\n`;
    }

    return ctx;
}

// ---------------------------------------------------------------------------
// Safe File Splitting
// ---------------------------------------------------------------------------

/**
 * Splits a large file block into multiple parts at line boundaries.
 * Unlike the old approach, NO data is permanently lost.
 *
 * Each part is labeled: "Part 1 of N", "Part 2 of N", etc.
 * so the LLM knows a file continues across chunks.
 */
function splitLargeFileBlock(
    filename: string,
    fileBlock: string,
    maxChars: number
): string[] {
    const parts: string[] = [];
    let remaining = fileBlock;

    while (remaining.length > 0) {
        if (remaining.length <= maxChars) {
            parts.push(remaining);
            break;
        }

        // Find the last newline before maxChars to avoid cutting mid-line
        let splitPoint = remaining.lastIndexOf('\n', maxChars);
        if (splitPoint <= 0) {
            // No newline found? Force split at maxChars (extremely rare — binary or minified)
            splitPoint = maxChars;
        }

        parts.push(remaining.slice(0, splitPoint));
        remaining = remaining.slice(splitPoint);
    }

    // If we split, label each part
    if (parts.length > 1) {
        return parts.map((part, i) =>
            `## ⚠️ FILE: \`${filename}\` — Part ${i + 1} of ${parts.length}\n\n${part}\n\n---\n\n`
        );
    }

    return parts;
}

// ---------------------------------------------------------------------------
// Diff Parsing Utilities
// ---------------------------------------------------------------------------

/**
 * Parses a unified diff patch and returns the set of line numbers (1-indexed)
 * that correspond to ADDED or MODIFIED lines in the new file.
 *
 * Used by the plugin system to only flag findings on changed lines,
 * eliminating false positives from pre-existing code.
 *
 * Handles standard unified diff format:
 *   @@ -oldStart,oldCount +newStart,newCount @@
 */
export function parseDiffAddedLines(patch: string): Set<number> {
    const addedLines = new Set<number>();
    const lines = patch.split('\n');
    let currentLine = 0;

    for (const line of lines) {
        // Parse hunk headers: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentLine = parseInt(hunkMatch[1], 10);
            continue;
        }

        if (currentLine === 0) continue; // Before first hunk

        if (line.startsWith('+') && !line.startsWith('+++')) {
            // Added line — this is a changed line in the new file
            addedLines.add(currentLine);
            currentLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            // Deleted line — doesn't advance the new file line counter
            // (this line exists only in the old version)
        } else {
            // Context line (unchanged) or empty — advances counter
            currentLine++;
        }
    }

    return addedLines;
}

// ---------------------------------------------------------------------------
// Semantic Diff Markers
// ---------------------------------------------------------------------------

/**
 * Annotates full file content with `+>` markers on changed lines.
 * This gives the LLM clear visual cues about which lines are new/modified,
 * dramatically reducing false positives on pre-existing code.
 */
function annotateWithDiffMarkers(content: string, addedLines: Set<number>): string {
    if (addedLines.size === 0) return content;

    const lines = content.split('\n');
    return lines.map((line, i) => {
        const lineNum = i + 1;
        return addedLines.has(lineNum) ? `+> ${line}` : `   ${line}`;
    }).join('\n');
}

/**
 * Compresses a sorted array of line numbers into human-readable ranges.
 * e.g., [1, 2, 3, 5, 6, 8] → "1-3, 5-6, 8"
 */
function compressLineNumbers(sorted: number[]): string {
    if (sorted.length === 0) return '';

    const ranges: string[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? `${start}` : `${start}-${end}`);
            start = sorted[i];
            end = sorted[i];
        }
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);

    return ranges.join(', ');
}

// ---------------------------------------------------------------------------
// Tiered Chunk Building (Fixed)
// ---------------------------------------------------------------------------

/**
 * Builds a file block for a Tier 1 file (full content + diff patch).
 * Uses progressive-chunking to safely split large files along AST boundaries
 * before formatting as markdown, ensuring code fences remain intact.
 */
async function buildTier1Block(
    file: GitHubPRFile,
    token: string,
    env: Env,
    prContext: { title: string; repoFullName: string; prNumber: number },
    effectiveMax: number
): Promise<{ blocks: string[]; findings: ReviewFinding[] }> {
    const findings: ReviewFinding[] = [];
    const content = await fetchFileContent(file.raw_url, token, env);

    // Determine how to chunk the file content
    const ext = file.filename.split('.').pop() ?? '';
    let contentChunks = [content || ''];

    if (content && !content.startsWith('[File too large')) {
        // Estimate the overhead of the wrapper (diff patch, headers, fences)
        const wrapperOverhead = (file.patch?.length || 0) + 500;
        const maxCodeChars = effectiveMax - wrapperOverhead;

        if (content.length > maxCodeChars && maxCodeChars > 1000) {
            // Use advanced progressive chunking
            contentChunks = createProgressiveChunks(content, maxCodeChars);
        }
    }

    // Parse changed line numbers for semantic diff markers
    const addedLines = file.patch ? parseDiffAddedLines(file.patch) : new Set<number>();

    // Wrap each content chunk in markdown
    const blocks: string[] = [];
    const isMultiPart = contentChunks.length > 1;

    for (let i = 0; i < contentChunks.length; i++) {
        const chunkContent = contentChunks[i];
        const partLabel = isMultiPart ? ` — Part ${i + 1} of ${contentChunks.length}` : '';
        let block = `## 🔍 FILE CHANGED: \`${file.filename}\` (${file.status})${partLabel} — *Full Review*\n`;

        // Inject changed-line summary for LLM focus
        if (addedLines.size > 0) {
            const lineNumbers = [...addedLines].sort((a, b) => a - b);
            const ranges = compressLineNumbers(lineNumbers);
            block += `### CHANGED LINES: ${ranges}\n`;
            block += `> Lines marked with \`+>\` below are ADDED/MODIFIED in this PR. Focus your review on these.\n\n`;
        }

        if (file.patch) {
            block += `### DIFF PATCH\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
        } else {
            block += `_(No diff patch available)_\n`;
        }

        if (chunkContent && !chunkContent.startsWith('[File too large')) {
            // Annotate full file content with diff markers on changed lines
            const annotatedContent = annotateWithDiffMarkers(chunkContent, addedLines);
            block += `\n### FULL FILE CONTENT${partLabel}\n\`\`\`${ext}\n${annotatedContent}\n\`\`\`\n`;
        } else if (chunkContent) {
            block += `\n${chunkContent}\n`;
        }

        block += `\n---\n\n`;
        blocks.push(block);
    }

    return { blocks, findings };
}

/**
 * Builds a file block for a Tier 2 file (diff patch only — no subrequest).
 */
function buildTier2Block(file: GitHubPRFile): string {
    let block = `## 📄 FILE CHANGED: \`${file.filename}\` (${file.status}) — *Diff Only*\n`;

    if (file.patch) {
        block += `### DIFF PATCH\n\`\`\`diff\n${file.patch}\n\`\`\`\n`;
    } else {
        block += `_(No diff patch available — binary or empty change)_\n`;
    }

    block += `\n---\n\n`;
    return block;
}

/** Return type for buildReviewChunks — includes global context for the synthesizer. */
export interface ReviewChunksResult {
    /** The code chunks to send to chunk reviewers (Map phase) */
    chunks: string[];
    /** Per-chunk file metadata: chunkFileMap[i] = filenames in chunks[i].
     *  Replaces fragile regex extraction with structured data. */
    chunkFileMap: string[][];
    /** The global PR context string (for use in the Reduce phase) */
    globalContext: string;
    /** All reviewable filenames (for the synthesizer payload) */
    allFiles: string[];
    /** Findings generated by local plugins */
    pluginFindings: ReviewFinding[];
}

// Removed obsolete regex-based buildImportGraph and resolveImportPath functions.
// Context extraction is now handled by the Cloudflare Container utilizing tree-sitter.

/**
 * Builds review chunks using the tiered classification system.
 *
 * Key improvements over the old implementation:
 * 1. Global context is prepended to EVERY chunk (not just the first)
 * 2. Large files are split at line boundaries (never permanently truncated)
 * 3. Returns structured metadata alongside chunks
 *
 * Chunks are split when they exceed `maxChunkChars`.
 */
export async function buildReviewChunks(
    classified: ClassifiedFiles,
    token: string,
    maxChunkChars: number,
    env: Env,
    prContext: { title: string; repoFullName: string; prNumber: number },
    containerBlastRadiusText?: string
): Promise<ReviewChunksResult> {
    const { tier1, tier2, skipped } = classified;

    // Provide empty map for fallback pipeline (AST context mapping runs in container now)
    const importGraph = new Map<string, string[]>();
    let globalContext = buildGlobalContext(classified, importGraph);
    if (containerBlastRadiusText) {
        globalContext += containerBlastRadiusText;
    }

    const allFiles = [...tier1, ...tier2].map(f => f.filename);
    const pluginFindings: ReviewFinding[] = runStaticPlugins([...tier1, ...tier2]);

    const chunks: string[] = [];
    const chunkFileMap: string[][] = []; // parallel array: chunkFileMap[i] = files in chunks[i]
    let currentChunkText = '';
    let currentChunkFiles: string[] = []; // files in the chunk being built

    // Helper: flush current chunk text into the chunks array with global context
    const flushChunk = () => {
        if (currentChunkText) {
            chunks.push(globalContext + currentChunkText);
            chunkFileMap.push([...currentChunkFiles]);
            currentChunkText = '';
            currentChunkFiles = [];
        }
    };

    // Effective max for content (after global context is prepended)
    const effectiveMax = maxChunkChars - globalContext.length;
    if (effectiveMax < 10_000) {
        logger.warn('Global context is very large, reducing effective chunk size', {
            globalContextLength: globalContext.length,
            effectiveMax,
        });
    }

    // ── Process Tier 1 files (full content, uses subrequests) ──
    for (const file of tier1) {
        const { blocks, findings } = await buildTier1Block(file, token, env, prContext, effectiveMax);
        pluginFindings.push(...findings);

        for (const fileBlock of blocks) {
            if (fileBlock.length > effectiveMax) {
                // Failsafe: if still too large, flush current and put it alone
                flushChunk();
                chunks.push(globalContext + fileBlock);
                chunkFileMap.push([file.filename]);
            } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
                // Adding this file would exceed the chunk limit — start a new chunk
                flushChunk();
                currentChunkText = fileBlock;
                currentChunkFiles = [file.filename];
            } else {
                currentChunkText += fileBlock;
                if (!currentChunkFiles.includes(file.filename)) {
                    currentChunkFiles.push(file.filename);
                }
            }
        }
    }

    // ── Process Tier 2 files (diff only unless small patch → deep fetch) ──
    const TIER2_DEEP_FETCH_LINE_LIMIT = 500;
    for (const file of tier2) {
        // Deep fetch: if the patch is small, fetch full content anyway
        // This dramatically improves review quality on 80%+ of files
        const patchLineCount = file.patch ? file.patch.split('\n').length : 0;
        if (patchLineCount > 0 && patchLineCount < TIER2_DEEP_FETCH_LINE_LIMIT) {
            // Upgrade this Tier 2 file to full-content review (costs 1 subrequest)
            const { blocks, findings } = await buildTier1Block(file, token, env, prContext, effectiveMax);
            pluginFindings.push(...findings);

            for (const fileBlock of blocks) {
                if (fileBlock.length > effectiveMax) {
                    flushChunk();
                    chunks.push(globalContext + fileBlock);
                    chunkFileMap.push([file.filename]);
                } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
                    flushChunk();
                    currentChunkText = fileBlock;
                    currentChunkFiles = [file.filename];
                } else {
                    currentChunkText += fileBlock;
                    if (!currentChunkFiles.includes(file.filename)) {
                        currentChunkFiles.push(file.filename);
                    }
                }
            }
            continue;
        }

        // Fallback: diff-only block (no subrequest cost)
        const fileBlock = buildTier2Block(file);

        if (fileBlock.length > effectiveMax) {
            flushChunk();
            const parts = splitLargeFileBlock(file.filename, fileBlock, effectiveMax);
            for (const part of parts) {
                chunks.push(globalContext + part);
                chunkFileMap.push([file.filename]);
            }
        } else if (currentChunkText.length + fileBlock.length > effectiveMax) {
            flushChunk();
            currentChunkText = fileBlock;
            currentChunkFiles = [file.filename];
        } else {
            currentChunkText += fileBlock;
            if (!currentChunkFiles.includes(file.filename)) {
                currentChunkFiles.push(file.filename);
            }
        }
    }

    // Flush any remaining content
    flushChunk();

    const finalChunks = chunks.length > 0 ? chunks : [globalContext + 'No verifiable file changes found.'];
    const finalFileMap = chunkFileMap.length > 0 ? chunkFileMap : [allFiles];

    return {
        chunks: finalChunks,
        chunkFileMap: finalFileMap,
        globalContext,
        allFiles,
        pluginFindings,
    };
}

// ---------------------------------------------------------------------------
// PR Comments
// ---------------------------------------------------------------------------

/**
 * Posts a review comment on a GitHub Pull Request.
 * Includes retry logic for transient failures.
 */
export async function postPRComment(
    repoFullName: string,
    prNumber: number,
    body: string,
    token: string
): Promise<void> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping PR comment');
        throw new Error('GitHub API circuit breaker is OPEN');
    }

    const executePost = async (): Promise<void> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/issues/${prNumber}/comments`;

        const truncatedBody = truncateMarkdown(body);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ body: truncatedBody }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to post PR comment: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }
    };

    try {
        const { attempts, totalDelayMs } = await retryWithBackoff(
            executePost,
            'GitHub post PR comment',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`PR comment posted after ${attempts} attempts`, {
                attempts,
                totalDelayMs,
            });
        }
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Check Runs API (requires GitHub App authentication)
// ---------------------------------------------------------------------------

type CheckRunConclusion =
    | 'action_required'
    | 'cancelled'
    | 'failure'
    | 'neutral'
    | 'success'
    | 'skipped'
    | 'timed_out';

interface CheckRunResponse {
    id: number;
    status: string;
    conclusion: string | null;
}

/**
 * Creates a new Check Run on a commit.
 * Returns the check run ID for later updates.
 * Includes retry logic and circuit breaker protection.
 */
export async function createCheckRun(
    repoFullName: string,
    headSha: string,
    token: string,
    options: {
        status: 'queued' | 'in_progress' | 'completed';
        conclusion?: CheckRunConclusion;
        summary?: string;
    }
): Promise<number> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        throw new Error('GitHub API circuit breaker is OPEN - too many failures');
    }

    const executeCreate = async (): Promise<number> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/check-runs`;

        const body: Record<string, unknown> = {
            name: 'AI Code Reviewer',
            head_sha: headSha,
            status: options.status,
        };

        if (options.conclusion) {
            body.conclusion = options.conclusion;
        }

        if (options.summary || options.conclusion) {
            body.output = {
                title: options.conclusion === 'skipped'
                    ? 'Review Skipped'
                    : options.conclusion === 'success'
                        ? 'Review Approved'
                        : options.conclusion === 'failure'
                            ? 'Changes Requested'
                            : 'AI Code Review',
                summary: options.summary ?? 'AI Code Review in progress...',
            };
        }

        // If completed, record the completion timestamp
        if (options.status === 'completed') {
            body.completed_at = new Date().toISOString();
        }
        body.started_at = new Date().toISOString();

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to create check run: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }

        const data: CheckRunResponse = await response.json() as any;
        return data.id;
    };

    try {
        const { result, attempts } = await retryWithBackoff(
            executeCreate,
            'GitHub create check run',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`Check run created after ${attempts} attempts`, {
                checkRunId: result,
                attempts,
            });
        }

        return result;
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}

/**
 * Updates an existing Check Run with the final conclusion and summary.
 * Includes retry logic for transient failures.
 */
export async function updateCheckRun(
    repoFullName: string,
    checkRunId: number,
    token: string,
    conclusion: CheckRunConclusion,
    summary: string,
): Promise<void> {
    // Check circuit breaker before attempting
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping check run update');
        return; // Non-critical: don't throw
    }

    const executeUpdate = async (): Promise<void> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/check-runs/${checkRunId}`;

        const title = conclusion === 'success'
            ? 'Review Approved'
            : conclusion === 'failure'
                ? 'Changes Requested'
                : 'AI Code Review';

        const truncatedSummary = truncateMarkdown(summary);

        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'AI Code Reviewer',
                status: 'completed',
                conclusion,
                completed_at: new Date().toISOString(),
                output: {
                    title,
                    summary: truncatedSummary,
                },
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            // Extract retry-after header for rate limit errors
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to update check run: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }
    };

    try {
        const { attempts } = await retryWithBackoff(
            executeUpdate,
            'GitHub update check run',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`Check run updated after ${attempts} attempts`, {
                checkRunId,
                attempts,
            });
        }
    } catch (error) {
        circuitBreakers.github.recordFailure();
        logger.error('Failed to update check run', error instanceof Error ? error : undefined, {
            checkRunId,
        });
        // Non-critical: don't throw
    }
}

// ---------------------------------------------------------------------------
// Pull Request Reviews API (Inline Comments)
// ---------------------------------------------------------------------------

/**
 * A single inline review comment to post on a specific line of a file.
 */
export interface InlineReviewComment {
    /** Relative path to the file */
    path: string;
    /** The line number in the NEW file (right side of diff) */
    line: number;
    /** Comment body in Markdown */
    body: string;
}

/**
 * Maps a file line number to the corresponding position in the diff patch.
 *
 * GitHub's Reviews API requires a `position` parameter which is the
 * 1-indexed line number within the diff hunk (counting from the first @@).
 * This is NOT the same as the file line number.
 */
function mapLineToDiffPosition(
    patch: string | undefined,
    targetLine: number
): number | null {
    if (!patch) return null;

    const lines = patch.split('\n');
    let diffPosition = 0;
    let currentFileLine = 0;

    for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            currentFileLine = parseInt(hunkMatch[1], 10);
            diffPosition++;
            continue;
        }

        if (currentFileLine === 0) continue;

        diffPosition++;

        if (line.startsWith('-') && !line.startsWith('---')) {
            // Deleted line — doesn't map to new file
            continue;
        }

        if (currentFileLine === targetLine) {
            return diffPosition;
        }

        // Both added and context lines advance the new file counter
        currentFileLine++;
    }

    return null;
}

/**
 * Posts a Pull Request Review with inline comments via the GitHub Reviews API.
 *
 * This produces native GitHub review comments that appear inline next to the
 * code, not as a wall of text in an issue comment. The review can also set
 * an overall approval status (APPROVE, REQUEST_CHANGES, COMMENT).
 *
 * GitHub limits: max 50 inline comments per review. Excess findings get
 * included in the review body instead.
 *
 * @param repoFullName  e.g. "owner/repo"
 * @param prNumber      PR number
 * @param token         Installation access token
 * @param event         Review event: APPROVE, REQUEST_CHANGES, or COMMENT
 * @param body          Review summary body (Markdown)
 * @param comments      Inline review comments mapped to specific file+line
 * @param filePatches   Map of filename → diff patch for position mapping
 */
export async function postPRReview(
    repoFullName: string,
    prNumber: number,
    token: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
    comments: InlineReviewComment[],
    filePatches: Map<string, string>
): Promise<void> {
    // Check circuit breaker
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub API circuit breaker is OPEN, skipping PR review');
        throw new Error('GitHub API circuit breaker is OPEN');
    }

    // GitHub caps at 50 inline comments per review
    const MAX_INLINE_COMMENTS = 50;

    // Map line numbers to diff positions and filter out unmappable comments
    const mappedComments: Array<{ path: string; position: number; body: string }> = [];
    const unmapped: InlineReviewComment[] = [];

    for (const comment of comments) {
        const patch = filePatches.get(comment.path);
        const position = mapLineToDiffPosition(patch, comment.line);

        if (position !== null) {
            mappedComments.push({
                path: comment.path,
                position,
                body: comment.body,
            });
        } else {
            unmapped.push(comment);
        }
    }

    // Enforce GitHub's 50-comment limit — overflow goes into review body
    const inlineToPost = mappedComments.slice(0, MAX_INLINE_COMMENTS);
    const overflowMapped = mappedComments.slice(MAX_INLINE_COMMENTS);

    // Build overflow section for the review body
    let reviewBody = body;
    const overflow = [...unmapped, ...overflowMapped.map(c => ({
        path: c.path,
        line: 0,
        body: c.body,
    }))];

    if (overflow.length > 0) {
        reviewBody += '\n\n---\n\n' +
            `> ℹ️ **${overflow.length} additional finding(s)** could not be posted as inline comments ` +
            `(line not in diff or GitHub's 50-comment limit exceeded):\n\n`;
        for (const item of overflow.slice(0, 20)) { // Cap at 20 to avoid massive body
            reviewBody += `- **\`${item.path}\`**: ${item.body.split('\n')[0]}\n`;
        }
        if (overflow.length > 20) {
            reviewBody += `\n_...and ${overflow.length - 20} more._\n`;
        }
    }

    logger.info('Posting PR review with inline comments', {
        prNumber,
        inlineComments: inlineToPost.length,
        unmapped: unmapped.length,
        overflow: overflowMapped.length,
        event,
    });

    const executeReview = async (): Promise<void> => {
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/reviews`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...githubHeaders(token),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                event,
                body: truncateMarkdown(reviewBody),
                comments: inlineToPost,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;
            const errorMessage = `Failed to post PR review: ${response.status} — ${errorText}`;
            if (response.status === 429 && retryAfter) {
                const retryAfterMs = parseInt(retryAfter, 10) * 1000;
                if (!isNaN(retryAfterMs)) {
                    throw new RateLimitError(errorMessage, undefined, retryAfterMs);
                }
            }
            throw new Error(errorMessage);
        }
    };

    try {
        const { attempts } = await retryWithBackoff(
            executeReview,
            'GitHub post PR review',
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        circuitBreakers.github.recordSuccess();

        if (attempts > 1) {
            logger.info(`PR review posted after ${attempts} attempts`, {
                prNumber,
                attempts,
            });
        }
    } catch (error) {
        circuitBreakers.github.recordFailure();
        throw error;
    }
}
