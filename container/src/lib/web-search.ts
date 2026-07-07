/**
 * Web Search Integration Module
 *
 * Provides web search grounding for LLM-based code reviews.
 * Both Gemini (Google Search grounding) and Claude (web_search server tool)
 * support native web search — zero extra subrequests from the Worker.
 *
 * This module handles:
 * - Configuration parsing from env vars
 * - Response metadata extraction (grounding sources, citations)
 * - Source formatting for PR review output
 */

import type { Env } from '../types/env';
import { logger } from './logger';
import type { KvCache } from './cache.js';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** A web source returned by the LLM's search grounding. */
export interface WebSearchSource {
    url: string;
    title: string;
}

/** Maps a text segment to the sources that ground it (inline citation). */
export interface InlineCitation {
    /** The text segment that is grounded by these sources. */
    text: string;
    /** Sources that support this text segment. */
    sources: WebSearchSource[];
}

/** Aggregated web search metadata from an LLM response. */
export interface WebSearchMetadata {
    /** Search queries the LLM executed. */
    searchQueries: string[];
    /** Sources cited in the response. */
    sources: WebSearchSource[];
    /** Number of search requests made (for billing tracking). */
    searchRequestCount: number;
    /** Segment-level inline citations (when available from groundingSupports or Claude citations). */
    inlineCitations?: InlineCitation[];
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Check if web search is enabled for this environment.
 * Controlled by the ENABLE_WEB_SEARCH env var (default: false).
 */
export function isWebSearchEnabled(env: Env): boolean {
    const val = env.ENABLE_WEB_SEARCH;
    if (!val) return false;
    return val.toLowerCase() === 'true' || val === '1';
}

// ---------------------------------------------------------------------------
// Smart Gating — PR-aware search decision
// ---------------------------------------------------------------------------

/** File extensions that indicate reviewable source code (worth searching for). */
const SOURCE_CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.rb',
    '.php', '.cs', '.swift', '.dart', '.c', '.cpp', '.h',
]);

/**
 * Patterns for security-sensitive paths (always warrant search).
 * Uses word boundaries or path-segment matching to avoid false positives
 * like 'authors.ts' matching /auth/ or 'TokenDisplay.tsx' matching /token/.
 */
const SECURITY_SENSITIVE_PATTERNS = [
    /\bauth\b/i, /\/auth\//i,       // auth as word or directory
    /\bcrypto\b/i, /\/crypto\//i,   // crypto as word or directory
    /\bsecurity\b/i, /\/security\//i,
    /\bpermissions?\b/i,             // permission/permissions as word
    /\bsecrets?\b/i,                // secret/secrets as word
    /\boauth\b/i, /\bjwt\b/i,
    /\bpassword\b/i, /\bpasswd\b/i,
    /\bsession\b/i, /\/session\//i,
    /\bcsrf\b/i, /\bcors\b/i,
    /\bsanitiz/i, /\bencrypt/i,
];

/** Patterns for docs/config files that don't need search. */
const NON_SEARCHABLE_PATTERNS = [
    /\.md$/i, /\.txt$/i, /\.rst$/i,                        // docs
    /changelog/i, /readme/i, /license/i, /contributing/i,  // standard docs
    /\.ya?ml$/i, /\.toml$/i, /\.ini$/i, /\.env/i,          // config
    /package\.json$/i, /package-lock\.json$/i,              // package configs
    /tsconfig[^/]*\.json$/i, /\.eslintrc\.json$/i,          // tool configs
    /\.prettierrc\.json$/i, /jest\.config\.json$/i,         // tool configs
    /\.css$/i, /\.scss$/i, /\.less$/i,                      // styles
    /\.svg$/i, /\.png$/i, /\.jpg$/i, /\.gif$/i,             // assets
    /\.lock$/i,                                             // lockfiles
];

/**
 * Smart gating: Determine whether web search should be activated for this PR.
 *
 * Returns true only if:
 * 1. Web search is globally enabled via env var
 * 2. The PR contains source code files (not docs-only, config-only, or test-only)
 *
 * Automatically enables search for PRs touching security-sensitive paths,
 * and skips search for trivial changes (docs, configs, lockfiles).
 *
 * @param reviewableFiles - All filenames being reviewed (from classified.tier1 + tier2)
 * @param env - Environment with ENABLE_WEB_SEARCH toggle
 * @returns Whether to enable web search for this PR's LLM calls
 */
export function shouldEnableWebSearch(reviewableFiles: string[], env: Env): boolean {
    // Gate 1: Global kill switch
    if (!isWebSearchEnabled(env)) return false;

    // Gate 2: Must have at least one source code file
    const hasSourceCode = reviewableFiles.some(f => {
        const ext = f.slice(f.lastIndexOf('.'));
        return SOURCE_CODE_EXTENSIONS.has(ext);
    });

    if (!hasSourceCode) {
        return false; // docs-only, config-only, or assets-only PR
    }

    // Check if any security-sensitive files are touched (prioritize search)
    const hasSecurityFiles = reviewableFiles.some(f =>
        SECURITY_SENSITIVE_PATTERNS.some(p => p.test(f))
    );

    if (hasSecurityFiles) {
        return true; // Always search for security-related changes
    }

    // Check the ratio of searchable vs non-searchable files
    const searchableFiles = reviewableFiles.filter(f =>
        !NON_SEARCHABLE_PATTERNS.some(p => p.test(f))
    );

    // If less than 20% of files are searchable source code, skip search
    // Guard: avoid division by zero on empty file lists
    if (reviewableFiles.length === 0 || searchableFiles.length / reviewableFiles.length < 0.2) {
        return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// KV-based Search Cache — Cross-PR deduplication
// ---------------------------------------------------------------------------

/** KV key prefix for cached web search sources. */
const SEARCH_CACHE_PREFIX = 'ws:';

/** Cache TTL: 24 hours (in seconds). */
const SEARCH_CACHE_TTL_SECONDS = 86_400;

/**
 * Retrieve cached web search sources for a repo.
 * Used to inject previously-found authoritative sources as context,
 * reducing redundant searches across consecutive PRs.
 */
export async function getCachedSearchSources(
    repoFullName: string,
    kv?: KvCache
): Promise<WebSearchSource[]> {
    if (!kv) return [];
    try {
        const key = `${SEARCH_CACHE_PREFIX}${repoFullName}`;
        const cached = await kv.get<WebSearchSource[]>(key, 'json');
        return cached ?? [];
    } catch (e) {
        logger.warn('Failed to read cached search sources from KV', { repoFullName, error: String(e) });
        return []; // KV failure is non-fatal
    }
}

/**
 * Cache web search sources for a repo after a review completes.
 * Merges new sources with any existing cached sources (deduplicates by URL).
 * Capped at 30 sources per repo.
 */
export async function cacheSearchSources(
    repoFullName: string,
    newSources: WebSearchSource[],
    kv?: KvCache
): Promise<void> {
    if (!kv || newSources.length === 0) return;
    try {
        const key = `${SEARCH_CACHE_PREFIX}${repoFullName}`;
        const existing = await kv.get<WebSearchSource[]>(key, 'json') ?? [];

        // Merge + deduplicate by URL, cap at 30
        const seen = new Set<string>();
        const merged: WebSearchSource[] = [];
        for (const source of [...newSources, ...existing]) {
            if (!seen.has(source.url) && merged.length < 30) {
                seen.add(source.url);
                merged.push(source);
            }
        }

        await kv.put(key, JSON.stringify(merged), { expirationTtl: SEARCH_CACHE_TTL_SECONDS });
    } catch (e) {
        // KV failure is non-fatal — log and skip
        logger.warn('Failed to write search sources to KV cache', { repoFullName, error: String(e) });
    }
}

/**
 * Format cached search sources as a prompt context section.
 * Injected into the system prompt to reduce redundant searches.
 */
export function formatCachedSourcesContext(sources: WebSearchSource[]): string {
    if (sources.length === 0) return '';
    const lines = sources
        .slice(0, 10) // Only inject top 10 to avoid prompt bloat
        .map(s => `- ${s.title}: ${s.url}`)
        .join('\n');
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PREVIOUSLY VERIFIED SOURCES (from recent reviews of this repo)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following authoritative sources were found in recent reviews.
You may reference them without re-searching if relevant:
${lines}
`.trim();
}

/** Max web searches Claude can execute per API call (controls cost). */
export const CLAUDE_WEB_SEARCH_MAX_USES = 3;

/** Claude web search tool version.
 * Updated to 20260209 which supports dynamic filtering for reduced token consumption.
 */
export const CLAUDE_WEB_SEARCH_TOOL_VERSION = 'web_search_20260209';

/**
 * Authoritative domains for Claude web search.
 * Focuses searches on official docs, security advisories, and package registries
 * instead of random blog posts. Omit to search the entire web.
 */
export const CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS: string[] = [
    // Security advisories
    'nvd.nist.gov',
    'github.com',              // GitHub Advisory Database
    'cve.mitre.org',
    // Official documentation
    'developer.mozilla.org',   // MDN Web Docs
    'react.dev',
    'nextjs.org',
    'vuejs.org',
    'angular.dev',
    'typescriptlang.org',
    'nodejs.org',
    'docs.python.org',
    'go.dev',
    'docs.rs',
    // Package registries
    'npmjs.com',
    'pypi.org',
    'crates.io',
    // Cloud/platform docs
    'developers.cloudflare.com',
    'cloud.google.com',
    'docs.aws.amazon.com',
];

/**
 * Token budget multiplier when web search is active.
 * Search results inflate actual input tokens beyond our estimate.
 * 1.5x buffer accounts for ~50% more tokens from ingested search content.
 */
export const SEARCH_TOKEN_BUDGET_MULTIPLIER = 1.5;

/** Max continuation turns when Claude returns pause_turn during web search. */
export const CLAUDE_MAX_SEARCH_CONTINUATIONS = 2;

// ---------------------------------------------------------------------------
// Gemini Grounding Metadata Extraction
// ---------------------------------------------------------------------------

/** Gemini groundingMetadata shape from the generateContent response. */
export interface GeminiGroundingMetadata {
    webSearchQueries?: string[];
    searchEntryPoint?: { renderedContent: string };
    groundingChunks?: Array<{
        web?: { uri: string; title: string };
    }>;
    groundingSupports?: Array<{
        segment?: { startIndex: number; endIndex: number; text: string };
        groundingChunkIndices?: number[];
    }>;
}

/**
 * Extract web search metadata from a Gemini grounding response.
 * Uses groundingChunks for sources and groundingSupports for segment-level
 * inline citation mapping (maps text ranges to source indices).
 */
export function extractGeminiGroundingMetadata(
    groundingMetadata?: GeminiGroundingMetadata
): WebSearchMetadata {
    if (!groundingMetadata) {
        return { searchQueries: [], sources: [], searchRequestCount: 0 };
    }

    const sources: WebSearchSource[] = (groundingMetadata.groundingChunks ?? [])
        .filter((chunk): chunk is { web: { uri: string; title: string } } => !!chunk.web)
        .map(chunk => ({
            url: chunk.web.uri,
            title: chunk.web.title,
        }));

    // Extract inline citation mapping from groundingSupports
    // Each support maps a text segment to one or more grounding chunk indices
    const inlineCitations: InlineCitation[] = [];
    if (groundingMetadata.groundingSupports) {
        for (const support of groundingMetadata.groundingSupports) {
            if (support.segment?.text && support.groundingChunkIndices?.length) {
                const citedSources = support.groundingChunkIndices
                    .filter(idx => idx < sources.length)
                    .map(idx => sources[idx]);
                if (citedSources.length > 0) {
                    inlineCitations.push({
                        text: support.segment.text,
                        sources: citedSources,
                    });
                }
            }
        }
    }

    return {
        searchQueries: groundingMetadata.webSearchQueries ?? [],
        sources,
        searchRequestCount: groundingMetadata.webSearchQueries?.length ?? 0,
        inlineCitations: inlineCitations.length > 0 ? inlineCitations : undefined,
    };
}

// ---------------------------------------------------------------------------
// Claude Web Search Metadata Extraction
// ---------------------------------------------------------------------------

/** Claude content block types when web search is active. */
export interface ClaudeContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: { query?: string };
    tool_use_id?: string;
    content?: Array<{
        type: string;
        url?: string;
        title?: string;
        encrypted_content?: string;
        page_age?: string;
    }>;
    citations?: Array<{
        type: string;
        url: string;
        title: string;
        cited_text?: string;
    }>;
}

/**
 * Extract web search metadata from Claude's response content blocks.
 */
export function extractClaudeSearchMetadata(
    contentBlocks: ClaudeContentBlock[]
): WebSearchMetadata {
    const searchQueries: string[] = [];
    const sources: WebSearchSource[] = [];
    let searchRequestCount = 0;
    const inlineCitations: InlineCitation[] = [];

    for (const block of contentBlocks) {
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
            if (block.input?.query) searchQueries.push(block.input.query);
            searchRequestCount++;
        }

        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
            for (const result of block.content) {
                if (result.type === 'web_search_result' && result.url) {
                    sources.push({
                        url: result.url,
                        title: result.title ?? '',
                    });
                }
            }
        }

        // Extract inline citations from text blocks (Claude attaches citations
        // to specific text segments when it references search results)
        if (block.type === 'text' && block.citations && block.citations.length > 0) {
            for (const citation of block.citations) {
                if (citation.url && citation.cited_text) {
                    inlineCitations.push({
                        text: citation.cited_text,
                        sources: [{ url: citation.url, title: citation.title ?? '' }],
                    });
                }
            }
        }
    }

    return {
        searchQueries,
        sources,
        searchRequestCount,
        inlineCitations: inlineCitations.length > 0 ? inlineCitations : undefined,
    };
}

/**
 * Extract the text content from Claude's response when web search is active.
 * With web search, multiple text blocks are interspersed with search blocks.
 * We concatenate only the text blocks to get the final output.
 */
export function extractClaudeTextContent(contentBlocks: ClaudeContentBlock[]): string {
    return contentBlocks
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n');
}

// ---------------------------------------------------------------------------
// Formatting for PR Output
// ---------------------------------------------------------------------------

/**
 * Format web search sources as a collapsible markdown section.
 * Appended to the final review when web search was used.
 *
 * When inline citations are available (from Gemini groundingSupports or Claude
 * text block citations), also renders a "Key Claims Verified" sub-section
 * mapping specific claims to their backing sources.
 */
export function formatSearchSources(metadata: WebSearchMetadata): string {
    if (metadata.sources.length === 0) return '';

    const unique = deduplicateSources(metadata.sources);
    const displayed = unique.slice(0, 10); // Cap at 10 to avoid noise
    const sourceLinks = displayed
        .map((s, i) => `${i + 1}. [${sanitizeMarkdownLinkText(s.title || 'Source')}](${sanitizeUrl(s.url)})`)
        .join('\n');

    const countLabel = unique.length > 10
        ? `showing 10 of ${unique.length}`
        : `${unique.length}`;

    // Build inline citations section if segment-level data is available
    let citationsSection = '';
    if (metadata.inlineCitations && metadata.inlineCitations.length > 0) {
        const citationLines = metadata.inlineCitations
            .slice(0, 5) // Cap at 5 inline citations to avoid bloat
            .map(c => {
                const sourceRefs = c.sources
                    .map(s => `[${sanitizeMarkdownLinkText(s.title || 'source')}](${sanitizeUrl(s.url)})`)
                    .join(', ');
                // Truncate cited text to 120 chars for readability
                const shortText = c.text.length > 120 ? c.text.slice(0, 117) + '...' : c.text;
                return `- _"${shortText}"_ → ${sourceRefs}`;
            })
            .join('\n');
        citationsSection = `\n\n**Key Claims Verified:**\n${citationLines}`;
    }

    return (
        `\n\n<details>\n<summary>🌐 <b>Web Sources Referenced (${countLabel})</b></summary>\n\n` +
        `${sourceLinks}${citationsSection}\n\n</details>`
    );
}

function deduplicateSources(sources: WebSearchSource[]): WebSearchSource[] {
    const seen = new Set<string>();
    return sources.filter(s => {
        if (seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
    });
}

/** Sanitize text for use in markdown link text — escape []() characters. */
function sanitizeMarkdownLinkText(text: string): string {
    return text.replace(/[\[\]()]/g, (c) => `\\${c}`);
}

/** Validate and sanitize a URL for markdown output. Only allow https:// URLs. */
function sanitizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            return parsed.href;
        }
        return '#invalid-url';
    } catch {
        return '#invalid-url';
    }
}
