import { describe, it, expect } from 'vitest';
import { filterPreviouslyRaisedFindings, titleSimilarity } from '../src/lib/review-delta';
import type { ReviewFinding } from '../src/types/review';
import type { PreviousReviewSummary } from '../src/lib/previous-review';

// ---------------------------------------------------------------------------
// titleSimilarity — Jaccard Index on Word Tokens
// ---------------------------------------------------------------------------

describe('titleSimilarity', () => {
    it('returns 1 for identical strings', () => {
        expect(titleSimilarity('missing error handling', 'missing error handling')).toBe(1);
    });

    it('returns 1 for both empty strings', () => {
        expect(titleSimilarity('', '')).toBe(1);
    });

    it('returns 0 for completely different strings', () => {
        expect(titleSimilarity('missing error handling', 'unused variable declared')).toBe(0);
    });

    it('returns >0.6 for substantially similar titles', () => {
        const score = titleSimilarity(
            'missing error handling in fetch handler',
            'missing error handling in fetch function'
        );
        expect(score).toBeGreaterThan(0.6);
    });

    it('returns <0.6 for moderately different titles', () => {
        const score = titleSimilarity(
            'missing error handling in fetch',
            'unused variable in render loop'
        );
        expect(score).toBeLessThan(0.6);
    });

    it('filters tokens shorter than 3 chars', () => {
        // "an" and "in" should be filtered, leaving only significant words
        const score = titleSimilarity(
            'an error in the code',
            'an error in the test'
        );
        // Only "error", "code" vs "error", "test" → 1 overlap / 3 union ≈ 0.33
        expect(score).toBeLessThanOrEqual(0.5);
    });
});

// ---------------------------------------------------------------------------
// filterPreviouslyRaisedFindings — Severity-Aware, File-Conditional
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
    return {
        severity: 'medium',
        file: 'src/utils.ts',
        title: 'Missing error handling',
        issue: 'No try-catch around fetch call.',
        category: 'error-handling',
        ...overrides,
    };
}

function makePreviousReview(overrides: Partial<PreviousReviewSummary> = {}): PreviousReviewSummary {
    return {
        findings: [],
        reviewCount: 0,
        lastVerdict: 'unknown',
        ...overrides,
    };
}

describe('filterPreviouslyRaisedFindings', () => {
    it('returns all findings when no previous review exists', () => {
        const findings = [makeFinding()];
        const previous = makePreviousReview();
        const modified = new Set(['src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(1);
        expect(result.suppressed).toBe(0);
    });

    it('suppresses exact match on modified files (medium severity)', () => {
        const findings = [makeFinding({ severity: 'medium', file: 'src/utils.ts', title: 'Missing error handling' })];
        const previous = makePreviousReview({
            findings: [{ file: 'src/utils.ts', title: 'Missing error handling' }],
            reviewCount: 1,
        });
        const modified = new Set(['src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(0);
        expect(result.suppressed).toBe(1);
    });

    it('suppresses fuzzy match on modified files (medium severity)', () => {
        const findings = [makeFinding({
            severity: 'medium',
            file: 'src/utils.ts',
            title: 'Missing error handling in fetch handler',
        })];
        const previous = makePreviousReview({
            findings: [{ file: 'src/utils.ts', title: 'Missing error handling in fetch function' }],
            reviewCount: 1,
        });
        const modified = new Set(['src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(0);
        expect(result.suppressed).toBe(1);
    });

    it('NEVER suppresses critical findings', () => {
        const findings = [makeFinding({ severity: 'critical', file: 'src/utils.ts', title: 'Missing error handling' })];
        const previous = makePreviousReview({
            findings: [{ file: 'src/utils.ts', title: 'Missing error handling' }],
            reviewCount: 1,
        });
        const modified = new Set(['src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(1);
        expect(result.suppressed).toBe(0);
    });

    it('suppresses high severity only on EXACT title match', () => {
        const findings = [
            makeFinding({ severity: 'high', file: 'src/utils.ts', title: 'Missing error handling' }),
            makeFinding({ severity: 'high', file: 'src/utils.ts', title: 'Missing error handling in fetch handler' }),
        ];
        const previous = makePreviousReview({
            findings: [{ file: 'src/utils.ts', title: 'Missing error handling' }],
            reviewCount: 1,
        });
        const modified = new Set(['src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        // First: exact match → suppressed. Second: fuzzy match but high severity → NOT suppressed.
        expect(result.filtered).toHaveLength(1);
        expect(result.filtered[0].title).toBe('Missing error handling in fetch handler');
        expect(result.suppressed).toBe(1);
    });

    it('NEVER suppresses findings on UNMODIFIED files (unfixed issues)', () => {
        const findings = [makeFinding({ severity: 'medium', file: 'src/untouched.ts', title: 'Missing error handling' })];
        const previous = makePreviousReview({
            findings: [{ file: 'src/untouched.ts', title: 'Missing error handling' }],
            reviewCount: 1,
        });
        // src/untouched.ts is NOT in the modified set → developer didn't touch it
        const modified = new Set(['src/other-file.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(1);
        expect(result.suppressed).toBe(0);
    });

    it('does not suppress when file differs', () => {
        const findings = [makeFinding({ file: 'src/different.ts', title: 'Missing error handling' })];
        const previous = makePreviousReview({
            findings: [{ file: 'src/utils.ts', title: 'Missing error handling' }],
            reviewCount: 1,
        });
        const modified = new Set(['src/different.ts', 'src/utils.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        expect(result.filtered).toHaveLength(1);
        expect(result.suppressed).toBe(0);
    });

    it('handles mixed scenario: some suppressed, some kept', () => {
        const findings = [
            makeFinding({ severity: 'critical', file: 'src/a.ts', title: 'SQL Injection' }),
            makeFinding({ severity: 'medium', file: 'src/b.ts', title: 'Unused variable' }),
            makeFinding({ severity: 'low', file: 'src/c.ts', title: 'Magic number' }),
        ];
        const previous = makePreviousReview({
            findings: [
                { file: 'src/a.ts', title: 'SQL Injection' },
                { file: 'src/b.ts', title: 'Unused variable' },
            ],
            reviewCount: 1,
        });
        const modified = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);

        const result = filterPreviouslyRaisedFindings(findings, previous, modified);
        // critical: never suppressed → kept (SQL Injection)
        // medium: exact match + modified file → suppressed (Unused variable)
        // low: no match → kept (Magic number)
        expect(result.filtered).toHaveLength(2);
        expect(result.suppressed).toBe(1);
        expect(result.filtered.map(f => f.title)).toContain('SQL Injection');
        expect(result.filtered.map(f => f.title)).toContain('Magic number');
    });
});
