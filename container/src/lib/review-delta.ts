/**
 * Review Delta Filter — Last Line of Defense Against Circular Reviews
 *
 * Filters out findings that were already raised in a previous review,
 * preventing the LLM from re-raising resolved issues even when it
 * ignores the anti-contradiction prompt rules.
 *
 * CRITICAL SAFETY RULES:
 *   1. Only suppresses findings on files IN THE CURRENT DIFF (modified by developer).
 *      If a file was NOT modified, the finding is unfixed and MUST be re-raised.
 *   2. NEVER suppresses critical findings — security issues always surface.
 *   3. High severity: only suppressed on EXACT title match (no fuzzy).
 *   4. Medium/Low: suppressed on fuzzy title match (Jaccard > 0.6).
 */

import type { ReviewFinding } from '../types/review';
import type { PreviousReviewSummary } from './previous-review';
import { logger } from './logger';

/**
 * Filters findings already raised in a previous review.
 *
 * @param currentFindings - Findings from the current review pipeline
 * @param previousReview - Summary of the bot's prior reviews on this PR
 * @param modifiedFiles - Set of files modified in the current PR diff.
 *                        Only findings on these files are eligible for suppression.
 * @returns Filtered findings and count of suppressed items
 */
export function filterPreviouslyRaisedFindings(
    currentFindings: ReviewFinding[],
    previousReview: PreviousReviewSummary,
    modifiedFiles: Set<string>
): { filtered: ReviewFinding[]; suppressed: number } {
    if (previousReview.findings.length === 0) {
        return { filtered: currentFindings, suppressed: 0 };
    }

    // Build lookup structures from previous findings
    const previousExact = new Set<string>();
    const previousByFile = new Map<string, string[]>();

    for (const f of previousReview.findings) {
        const normalizedTitle = f.title.toLowerCase().trim().replace(/\s+/g, ' ');
        previousExact.add(`${f.file}::${normalizedTitle}`);

        const titles = previousByFile.get(f.file) || [];
        titles.push(normalizedTitle);
        previousByFile.set(f.file, titles);
    }

    let suppressed = 0;
    const filtered = currentFindings.filter(finding => {
        // RULE 1: NEVER suppress critical findings
        if (finding.severity === 'critical') return true;

        // RULE 2: NEVER suppress findings on files the developer DIDN'T modify.
        // If the file isn't in the current diff, the issue is unfixed — must re-raise.
        if (!modifiedFiles.has(finding.file)) return true;

        const normalizedTitle = finding.title.toLowerCase().trim().replace(/\s+/g, ' ');
        const exactKey = `${finding.file}::${normalizedTitle}`;

        // RULE 3: HIGH severity — only suppress on exact title match
        if (finding.severity === 'high') {
            if (previousExact.has(exactKey)) {
                suppressed++;
                return false;
            }
            return true;
        }

        // RULE 4: MEDIUM/LOW — suppress on exact OR fuzzy match
        if (previousExact.has(exactKey)) {
            suppressed++;
            return false;
        }

        const prevTitles = previousByFile.get(finding.file);
        if (prevTitles) {
            for (const prevTitle of prevTitles) {
                if (titleSimilarity(normalizedTitle, prevTitle) > 0.6) {
                    suppressed++;
                    return false;
                }
            }
        }

        return true;
    });

    if (suppressed > 0) {
        logger.info('Delta filter suppressed previously-raised findings', {
            suppressed,
            remaining: filtered.length,
            total: currentFindings.length,
        });
    }

    return { filtered, suppressed };
}

/**
 * Simple word-overlap similarity using Jaccard index on tokens.
 * Filters tokens shorter than 3 chars to reduce noise from articles/prepositions.
 *
 * @returns Similarity score between 0 and 1
 */
export function titleSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.split(/\s+/).filter(t => t.length > 2));
    const tokensB = new Set(b.split(/\s+/).filter(t => t.length > 2));
    if (tokensA.size === 0 && tokensB.size === 0) return 1;
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
    }
    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
