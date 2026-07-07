/**
 * Deterministic verdict engine.
 *
 * Derives the Check Run conclusion from structured findings data —
 * never from parsing LLM free-text output. This is immune to
 * LLM formatting variations and hallucinated verdicts.
 */

import type { ReviewFinding, FindingSeverity } from '../types/review';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** The semantic review verdict derived from findings. */
export type Verdict = 'approve' | 'request_changes' | 'needs_discussion';

/** GitHub Check Run conclusion mapped from the verdict. */
export type CheckConclusion = 'success' | 'failure' | 'neutral';

/** Severity counts for reporting. */
export type SeverityCounts = Record<FindingSeverity, number>;

// ---------------------------------------------------------------------------
// Severity Counting
// ---------------------------------------------------------------------------

/**
 * Count findings by severity level.
 * Returns a complete record with zero-initialized counts.
 */
export function countBySeverity(findings: ReadonlyArray<ReviewFinding>): SeverityCounts {
    const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
        if (f.severity in counts) {
            counts[f.severity]++;
        }
    }
    return counts;
}

// ---------------------------------------------------------------------------
// Verdict Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the review verdict from structured findings.
 *
 * Rules:
 *  - Any `critical` or `high` finding → `request_changes`
 *  - All chunks failed with no findings → `request_changes` (can't approve unreviewed code)
 *  - Only `medium`/`low` findings → `approve`
 *  - No findings at all → `approve`
 */
export function deriveVerdict(
    findings: ReadonlyArray<ReviewFinding>,
    allChunksFailed: boolean
): Verdict {
    // Guard: all chunks failed = we can't approve code we never reviewed
    if (allChunksFailed && findings.length === 0) {
        return 'request_changes';
    }

    const counts = countBySeverity(findings);

    if (counts.critical > 0 || counts.high > 0) {
        return 'request_changes';
    }

    // Medium-severity threshold: ≥3 medium findings warrant discussion,
    // not an outright block. This prevents false merge-blocks from
    // speculative or style-based medium findings.
    if (counts.medium >= 3) {
        return 'needs_discussion';
    }

    return 'approve';
}

// ---------------------------------------------------------------------------
// Verdict → Check Run Conclusion
// ---------------------------------------------------------------------------

/**
 * Map a semantic verdict to a GitHub Check Run conclusion.
 *
 *  - `approve`         → `success`  (green badge)
 *  - `request_changes` → `failure`  (red badge, blocks merge)
 *  - `needs_discussion` → `neutral` (grey badge)
 */
export function verdictToConclusion(verdict: Verdict): CheckConclusion {
    switch (verdict) {
        case 'approve':
            return 'success';
        case 'request_changes':
            return 'failure';
        case 'needs_discussion':
            return 'neutral';
    }
}
