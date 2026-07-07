/**
 * Previous Review Context Module
 *
 * Fetches the bot's prior review findings from THREE GitHub API sources
 * to provide the LLM with context about what was already flagged.
 * This prevents circular reviews where the LLM contradicts its own advice.
 *
 * Sources (all fetched in parallel via Promise.allSettled):
 *   1. GET /pulls/{pr}/comments       — inline review comments (PRIMARY, structured)
 *   2. GET /pulls/{pr}/reviews         — review body markdown (SECONDARY, regex-parsed)
 *   3. GET /issues/{pr}/comments       — issue comments (FALLBACK for postPRComment path)
 *
 * Design decisions:
 *   - Triple-source extraction ensures findings are captured regardless of how they were posted
 *   - Inline comments are the primary source because they have structured `path` + `body` fields
 *   - Review body parsing is regex-based and serves as a fallback
 *   - Issue comments catch the postPRComment fallback path (when postPRReview fails)
 *   - Dismissed reviews are excluded to respect maintainer actions
 *   - Graceful degradation: any single source failure is non-fatal
 *   - Circuit breaker check prevents wasted subrequests when GitHub is down
 */

import { logger } from './logger';
import { circuitBreakers } from './retry';

const GITHUB_API_BASE = 'https://api.github.com';
const BOT_LOGIN_SUFFIX = '[bot]';
const MAX_PREVIOUS_FINDINGS = 30;

// ─── Types ───────────────────────────────────────────────────

export interface PreviousReviewSummary {
    /** Condensed list of previously flagged issues */
    findings: PreviousFinding[];
    /** Number of prior bot reviews found */
    reviewCount: number;
    /** Whether the last review approved or requested changes */
    lastVerdict: 'approved' | 'changes_requested' | 'commented' | 'unknown';
}

export interface PreviousFinding {
    /** File path the finding was raised on */
    file: string;
    /** Short title/summary of the finding */
    title: string;
    /** Severity if extractable from the comment format */
    severity?: string;
}

interface GitHubReview {
    id: number;
    user: { login: string; type: string };
    body: string;
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
    submitted_at: string;
}

interface GitHubReviewComment {
    id: number;
    user: { login: string; type: string };
    path: string;
    body: string;
    created_at: string;
}

interface GitHubIssueComment {
    id: number;
    user: { login: string; type: string };
    body: string;
    created_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function githubHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'code-reviewer-agent/1.0',
    };
}

function isBotUser(user: { login: string; type: string }): boolean {
    return user.type === 'Bot' || user.login.endsWith(BOT_LOGIN_SUFFIX);
}

// ─── Main Fetch Function ─────────────────────────────────────

/**
 * Fetches the bot's previous review findings from THREE GitHub API sources.
 *
 * Triple-source approach ensures we capture findings regardless of whether
 * they were posted as inline annotations, in the review body, or via the
 * postPRComment fallback path.
 *
 * Graceful degradation: on any failure, returns empty (review proceeds normally).
 */
export async function fetchPreviousReviewFindings(
    repoFullName: string,
    prNumber: number,
    token: string,
): Promise<PreviousReviewSummary> {
    const empty: PreviousReviewSummary = {
        findings: [], reviewCount: 0, lastVerdict: 'unknown'
    };

    // Check circuit breaker before making GitHub calls
    if (!circuitBreakers.github.canExecute()) {
        logger.warn('GitHub circuit breaker OPEN, skipping previous review fetch');
        return empty;
    }

    try {
        // Triple-source fetch in parallel — any single failure is non-fatal
        const [reviewsResult, inlineResult, issueResult] = await Promise.allSettled([
            fetchBotReviews(repoFullName, prNumber, token),
            fetchBotInlineComments(repoFullName, prNumber, token),
            fetchBotIssueComments(repoFullName, prNumber, token),
        ]);

        const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : [];
        const inlineComments = inlineResult.status === 'fulfilled' ? inlineResult.value : [];
        const issueComments = issueResult.status === 'fulfilled' ? issueResult.value : [];

        // Log individual source failures for observability
        if (reviewsResult.status === 'rejected') {
            logger.debug('Failed to fetch bot reviews (non-fatal)', { error: String(reviewsResult.reason) });
        }
        if (inlineResult.status === 'rejected') {
            logger.debug('Failed to fetch inline comments (non-fatal)', { error: String(inlineResult.reason) });
        }
        if (issueResult.status === 'rejected') {
            logger.debug('Failed to fetch issue comments (non-fatal)', { error: String(issueResult.reason) });
        }

        if (reviews.length === 0 && inlineComments.length === 0 && issueComments.length === 0) {
            return empty;
        }

        // Source 1 (PRIMARY): Inline review comments — structured, no regex fragility
        const fromInline = extractFromInlineComments(inlineComments);

        // Source 2 (SECONDARY): Review body markdown — regex-based fallback
        const fromBody = extractFromReviewBodies(reviews);

        // Source 3 (FALLBACK): Issue comments — catches postPRComment fallback path
        const fromIssue = extractFromIssueComments(issueComments);

        // Log fragility signal: if body parsing finds nothing but inline did
        if (fromBody.length === 0 && fromInline.length > 0) {
            logger.debug('Review body parsing returned 0 but inline had findings — format may have changed', {
                prNumber, inlineCount: fromInline.length,
            });
        }

        // Deduplicate across all sources (same file+title = one entry)
        const deduped = deduplicatePreviousFindings([...fromInline, ...fromBody, ...fromIssue]);
        const findings = deduped.slice(0, MAX_PREVIOUS_FINDINGS);

        const lastVerdict = reviews.length > 0
            ? reviews[0].state === 'APPROVED' ? 'approved' as const
                : reviews[0].state === 'CHANGES_REQUESTED' ? 'changes_requested' as const
                : 'commented' as const
            : 'unknown' as const;

        return { findings, reviewCount: reviews.length, lastVerdict };
    } catch (error) {
        logger.warn('Failed to fetch previous review findings (non-fatal)', {
            prNumber, error: String(error),
        });
        return empty;
    }
}

// ─── Source 1: Inline Review Comments (PRIMARY) ──────────────

async function fetchBotInlineComments(
    repoFullName: string, prNumber: number, token: string
): Promise<GitHubReviewComment[]> {
    const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/comments?per_page=100`;
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) {
        logger.debug('Failed to fetch PR inline comments', { status: response.status });
        return [];
    }
    const comments: GitHubReviewComment[] = await response.json() as any;
    return comments.filter(c => isBotUser(c.user));
}

/**
 * Extract findings from inline review comments.
 * These have structured `path` (file) and `body` fields — no regex fragility.
 * Comment format: "🔴 **CRITICAL** — Title\n\nIssue description..."
 */
function extractFromInlineComments(comments: GitHubReviewComment[]): PreviousFinding[] {
    const findings: PreviousFinding[] = [];
    for (const comment of comments) {
        const firstLine = comment.body.split('\n')[0];
        // Match: "🔴 **CRITICAL** — Title" or "🟠 **HIGH** — Title"
        const match = firstLine.match(/\*\*(CRITICAL|HIGH|MEDIUM|LOW)\*\*\s*[—–-]\s*(.+)/i);
        if (match) {
            findings.push({
                file: comment.path,
                title: match[2].trim(),
                severity: match[1].toLowerCase(),
            });
        } else {
            // Fallback: use first line as title (strip markdown formatting)
            const cleanTitle = firstLine.replace(/[*#`]/g, '').trim().slice(0, 150);
            if (cleanTitle.length > 5) { // Skip trivially short comments
                findings.push({
                    file: comment.path,
                    title: cleanTitle,
                });
            }
        }
    }
    return findings;
}

// ─── Source 2: Review Body Markdown (SECONDARY) ──────────────

async function fetchBotReviews(
    repoFullName: string, prNumber: number, token: string
): Promise<GitHubReview[]> {
    const url = `${GITHUB_API_BASE}/repos/${repoFullName}/pulls/${prNumber}/reviews?per_page=100`;
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) {
        logger.debug('Failed to fetch PR reviews', { status: response.status });
        return [];
    }
    const reviews: GitHubReview[] = await response.json() as any;
    return reviews
        .filter(r =>
            isBotUser(r.user)
            && r.state !== 'DISMISSED' // Exclude dismissed reviews (GAP 6)
        )
        .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
}

/**
 * Extract findings from review body markdown.
 * Matches the synthesizer's output format patterns.
 * This is the FALLBACK source — regex-based, coupled to synthesizer format.
 */
function extractFromReviewBodies(reviews: GitHubReview[]): PreviousFinding[] {
    const findings: PreviousFinding[] = [];
    // Only parse the last 3 reviews to stay within budget
    for (const review of reviews.slice(0, 3)) {
        if (!review.body) continue;
        for (const line of review.body.split('\n')) {
            // Match critical/high format: #### File: `path/to/file.tsx:123` — Short title
            const headerMatch = line.match(/^####\s+File:\s*`([^`]+)`\s*[—–-]\s*(.+)/);
            if (headerMatch) {
                findings.push({
                    file: headerMatch[1].replace(/:\d+$/, '').trim(),
                    title: headerMatch[2].trim(),
                });
                continue;
            }
            // Match medium/low format: * **File: `path`** — **[Title]**: desc
            const bulletMatch = line.match(/^\*\s+\*\*File:\s*`([^`]+)`\*\*\s*[—–-]\s*\*\*\[?([^\]*]+)\]?\*\*/);
            if (bulletMatch) {
                findings.push({
                    file: bulletMatch[1].replace(/:\d+$/, '').trim(),
                    title: bulletMatch[2].trim(),
                });
            }
        }
    }
    return findings;
}

// ─── Source 3: Issue Comments (FALLBACK for postPRComment) ───

async function fetchBotIssueComments(
    repoFullName: string, prNumber: number, token: string
): Promise<GitHubIssueComment[]> {
    const url = `${GITHUB_API_BASE}/repos/${repoFullName}/issues/${prNumber}/comments?per_page=50`;
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) {
        logger.debug('Failed to fetch issue comments', { status: response.status });
        return [];
    }
    const comments: GitHubIssueComment[] = await response.json() as any;
    // Only include bot comments that look like reviews (not error messages)
    return comments.filter(c =>
        isBotUser(c.user) && c.body.includes('Code Review Report')
    );
}

/**
 * Extract findings from issue comments posted via the postPRComment fallback.
 * Reuses the same markdown parsing as review bodies.
 */
function extractFromIssueComments(comments: GitHubIssueComment[]): PreviousFinding[] {
    return extractFromReviewBodies(
        comments.map(c => ({
            id: c.id,
            user: c.user,
            body: c.body,
            state: 'COMMENTED' as const,
            submitted_at: c.created_at,
        }))
    );
}

// ─── Deduplication ───────────────────────────────────────────

/**
 * Deduplicate findings across all sources.
 * Same file + normalized title = one entry.
 * Keeps the first occurrence (inline comments are prepended, so they take priority).
 */
function deduplicatePreviousFindings(findings: PreviousFinding[]): PreviousFinding[] {
    const seen = new Set<string>();
    return findings.filter(f => {
        const key = `${f.file}::${f.title.toLowerCase().trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ─── Prompt Formatting ──────────────────────────────────────

/**
 * Formats previous findings for injection into a chunk's system prompt.
 *
 * Key features:
 *   - Filters to chunk-relevant findings only (GAP 4: avoid token explosion)
 *   - Includes force-push disclaimer (GAP 5)
 *   - Returns empty string if no relevant findings exist
 *
 * @param summary - Previously extracted review summary
 * @param chunkFiles - If provided, only include findings for these files
 */
export function formatPreviousReviewContext(
    summary: PreviousReviewSummary,
    chunkFiles?: string[]
): string {
    let relevant = summary.findings;

    // GAP 4: Only inject findings relevant to this chunk's files
    if (chunkFiles && chunkFiles.length > 0) {
        const fileSet = new Set(chunkFiles);
        relevant = relevant.filter(f => fileSet.has(f.file));
    }

    if (relevant.length === 0) return '';

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PREVIOUS REVIEW CONTEXT (${summary.reviewCount} prior review(s))
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following issues were flagged in PRIOR reviews on this PR.
The developer has pushed new commits to address them.

RULES:
- Do NOT re-raise these if the developer has fixed them.
- DO re-raise ONLY if the fix introduced a NEW regression or is incomplete.
- If a previously-flagged file or line no longer exists in the current
  diff, ignore that finding entirely (code may have been restructured).

Previously flagged:
${relevant.map(f => `• ${f.file}: ${f.title}`).join('\n')}

Last verdict: ${summary.lastVerdict}
`.trim();
}
