/**
 * Unit tests for the deterministic verdict engine.
 */

import { describe, it, expect } from 'vitest';
import {
    deriveVerdict,
    verdictToConclusion,
    countBySeverity,
} from '../src/lib/verdict';
import type { ReviewFinding } from '../src/types/review';

// ---------------------------------------------------------------------------
// Helper: create a minimal finding with the given severity
// ---------------------------------------------------------------------------

function makeFinding(severity: ReviewFinding['severity'], file = 'a.ts'): ReviewFinding {
    return {
        severity,
        file,
        title: `Test ${severity} finding`,
        issue: `A ${severity} issue`,
        category: 'typescript',
    };
}

// ---------------------------------------------------------------------------
// countBySeverity
// ---------------------------------------------------------------------------

describe('countBySeverity', () => {
    it('returns zero counts for empty array', () => {
        const counts = countBySeverity([]);
        expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it('counts each severity correctly', () => {
        const findings = [
            makeFinding('critical'),
            makeFinding('critical'),
            makeFinding('high'),
            makeFinding('medium'),
            makeFinding('medium'),
            makeFinding('medium'),
            makeFinding('low'),
        ];
        const counts = countBySeverity(findings);
        expect(counts).toEqual({ critical: 2, high: 1, medium: 3, low: 1 });
    });

    it('handles single finding', () => {
        const counts = countBySeverity([makeFinding('high')]);
        expect(counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    });
});

// ---------------------------------------------------------------------------
// deriveVerdict
// ---------------------------------------------------------------------------

describe('deriveVerdict', () => {
    it('returns approve for empty findings', () => {
        expect(deriveVerdict([], false)).toBe('approve');
    });

    it('returns approve for only low/medium findings', () => {
        const findings = [makeFinding('low'), makeFinding('medium')];
        expect(deriveVerdict(findings, false)).toBe('approve');
    });

    it('returns request_changes for critical findings', () => {
        const findings = [makeFinding('critical'), makeFinding('low')];
        expect(deriveVerdict(findings, false)).toBe('request_changes');
    });

    it('returns request_changes for high findings', () => {
        const findings = [makeFinding('high')];
        expect(deriveVerdict(findings, false)).toBe('request_changes');
    });

    it('returns request_changes when all chunks failed with no findings', () => {
        expect(deriveVerdict([], true)).toBe('request_changes');
    });

    it('returns request_changes when all chunks failed but has critical findings from plugins', () => {
        const findings = [makeFinding('critical')];
        expect(deriveVerdict(findings, true)).toBe('request_changes');
    });

    it('returns approve when all chunks failed but has only low findings from plugins', () => {
        // allChunksFailed=true but findings exist → verdict based on severity, not chunk failure
        const findings = [makeFinding('low')];
        expect(deriveVerdict(findings, true)).toBe('approve');
    });
});

// ---------------------------------------------------------------------------
// verdictToConclusion
// ---------------------------------------------------------------------------

describe('verdictToConclusion', () => {
    it('maps approve to success', () => {
        expect(verdictToConclusion('approve')).toBe('success');
    });

    it('maps request_changes to failure', () => {
        expect(verdictToConclusion('request_changes')).toBe('failure');
    });

    it('maps needs_discussion to neutral', () => {
        expect(verdictToConclusion('needs_discussion')).toBe('neutral');
    });
});
