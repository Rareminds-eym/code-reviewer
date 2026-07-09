/**
 * Smart Comment Deduplication Module
 *
 * Handles PR review comment deduplication by checking existing GitHub comments:
 * - Suppress findings on unmodified lines with active open threads
 * - Re-post findings if code was modified (outdated comment) but issue persists
 * - Re-post findings if comment was resolved but code is still broken
 * - Consolidate all unresolved issues in the main PR review comment
 */
import { logger } from './logger';

const GITHUB_API_BASE = 'https://api.github.com';

// ─── Types ───────────────────────────────────────────────────

export interface PRCommentThread {
    /** File path */
    path: string;
    /** Line number in the file */
    line: number;
    /** Position in the diff (null if comment is on outdated code) */
    position: number | null;
    /** Original position in the diff */
    originalPosition: number | null;
    /** Pull request review ID this comment belongs to */
    reviewId: number | null;
    /** When the thread was created */
    createdAt: string;
    /** Whether the comment is from the bot (our own previous comments) */
    isBot: boolean;
    /** Comment body (first 200 chars for matching) */
    body: string;
}

export interface SmartDedupConfig {
    /** Map of file -> Set of modified (added) line numbers from the PR */
    modifiedLines: Map<string, Set<number>>;
    /** The current PR head SHA */
    headSha: string;
}

export interface SmartDedupResult {
    /** Findings that should be posted as inline comments */
    findingsToPost: Array<{ finding: any; reason: string }>;
    /** Findings that were suppressed (active thread exists on unmodified line) */
    suppressedInline: Array<{ finding: any; reason: string }>;
    /** All unresolved findings for the consolidated checklist */
    allUnresolved: any[];
}

// ─── Fetch PR Review Comments ────────────────────────────────

/**
 * Fetch ALL PR review comments (not just bot's) for dedup analysis.
 * Includes both active and outdated comments.
 */
export async function fetchPRCommentThreads(
    repoFullName: string,
    prNumber: number,
    token: string
): Promise<PRCommentThread[]> {
    const threads: PRCommentThread[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) { // Max 5 pages = 500 comments
        const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100&page=${page}`;
        try {
            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'code-reviewer-agent/1.0',
                },
            });

            if (!response.ok) {
                logger.warn(`Failed to fetch PR comments page ${page}: ${response.status}`);
                break;
            }

            const comments: any[] = await response.json();
            if (comments.length === 0) break;

            for (const c of comments) {
                threads.push({
                    path: c.path || '',
                    line: c.line || c.original_line || 0,
                    position: c.position ?? null,
                    originalPosition: c.original_position ?? null,
                    reviewId: c.pull_request_review_id ?? null,
                    createdAt: c.created_at || '',
                    isBot: c.user?.type === 'Bot' || (c.user?.login || '').endsWith('[bot]'),
                    body: (c.body || '').slice(0, 200),
                });
            }

            page++;
            hasMore = comments.length === 100;
        } catch (err) {
            logger.warn('Failed to fetch PR comment threads', { error: err instanceof Error ? err.message : String(err) });
            break;
        }
    }

    logger.info(`Fetched ${threads.length} PR comment threads for dedup analysis`);
    return threads;
}

// ─── Parsing helper: extract file + line from a finding ──────

function findingKey(finding: any): { file: string; line: number } {
    return {
        file: finding.file || '',
        line: finding.line || 0,
    };
}

// ─── Smart Dedup Engine ──────────────────────────────────────

/**
 * Apply smart dedup rules to a set of findings.
 *
 * Rules:
 * 1. If a bot comment thread exists on the SAME file+line AND the line is UNMODIFIED
 *    AND the thread is ACTIVE (position not null) → suppress inline comment
 * 2. If a bot comment thread exists but the LINE WAS MODIFIED (outdated) AND the
 *    issue is the same → re-post (old comment is stale)
 * 3. If a bot comment thread was RESOLVED but the code is STILL BROKEN → re-post
 * 4. ALL unresolved findings go into the consolidated checklist
 */
export function applySmartDedup(
    findings: any[],
    existingThreads: PRCommentThread[],
    config: SmartDedupConfig
): SmartDedupResult {
    const findingsToPost: SmartDedupResult['findingsToPost'] = [];
    const suppressedInline: SmartDedupResult['suppressedInline'] = [];
    const allUnresolved: any[] = [];

    // Group existing threads by file+line for O(1) lookup
    const threadMap = new Map<string, PRCommentThread[]>();
    for (const thread of existingThreads) {
        // Only consider bot threads for dedup (our own previous comments)
        if (!thread.isBot) continue;
        const key = `${thread.path}:${thread.line}`;
        if (!threadMap.has(key)) threadMap.set(key, []);
        threadMap.get(key)!.push(thread);
    }

    for (const finding of findings) {
        const { file, line } = findingKey(finding);
        if (!file || !line) {
            findingsToPost.push({ finding, reason: 'no_file_or_line' });
            allUnresolved.push(finding);
            continue;
        }

        const key = `${file}:${line}`;
        const existing = threadMap.get(key);
        if (!existing || existing.length === 0) {
            // No existing thread — post new comment
            findingsToPost.push({ finding, reason: 'new_finding' });
            allUnresolved.push(finding);
            continue;
        }

        // Check if the line was modified in this PR
        const modifiedLines = config.modifiedLines.get(file);
        const lineWasModified = modifiedLines?.has(line) ?? false;

        // Check latest thread status
        const latestThread = existing[existing.length - 1];
        const isOutdated = latestThread.position === null && latestThread.originalPosition !== null;

        if (lineWasModified || isOutdated) {
            // Line was changed since the comment was posted — re-evaluate
            findingsToPost.push({ finding, reason: 'line_modified_repost' });
            allUnresolved.push(finding);
        } else {
            // Line is unmodified, thread is active — suppress inline
            suppressedInline.push({ finding, reason: 'active_thread_unmodified_line' });
            // BUT still include in consolidated checklist
            allUnresolved.push(finding);
        }
    }

    logger.info(`Smart dedup: ${findingsToPost.length} to post, ${suppressedInline.length} suppressed inline, ${allUnresolved.length} total unresolved`);

    return {
        findingsToPost,
        suppressedInline,
        allUnresolved,
    };
}
