/**
 * Unit tests for the three-phase finding clustering engine.
 */

import { describe, it, expect } from 'vitest';
import { clusterFindings, flattenClusters } from '../src/lib/finding-clusters';
import type { ReviewFinding } from '../src/types/review';

// ---------------------------------------------------------------------------
// Helper: create findings with controllable properties
// ---------------------------------------------------------------------------

function makeFinding(opts: Partial<ReviewFinding> & { file: string; category: ReviewFinding['category'] }): ReviewFinding {
    return {
        severity: 'medium',
        title: 'Default title',
        issue: 'Default issue',
        ...opts,
    };
}

// ---------------------------------------------------------------------------
// Phase 1: Category-File Grouping
// ---------------------------------------------------------------------------

describe('Phase 1: Category-File grouping', () => {
    it('groups findings with same category and file', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/App.tsx', category: 'react', title: 'Missing key' }),
            makeFinding({ file: 'src/App.tsx', category: 'react', title: 'Unused effect' }),
            makeFinding({ file: 'src/utils.ts', category: 'typescript', title: 'Any usage' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters).toHaveLength(2);

        const appCluster = clusters.find(c => c.findings.some(f => f.file === 'src/App.tsx'));
        expect(appCluster).toBeDefined();
        expect(appCluster!.findings).toHaveLength(2);
    });

    it('separates different categories in same file', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/App.tsx', category: 'react', title: 'React issue' }),
            makeFinding({ file: 'src/App.tsx', category: 'typescript', title: 'TS issue' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters).toHaveLength(2);
    });

    it('returns empty array for no findings', () => {
        expect(clusterFindings([])).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Phase 2: Similarity Detection
// ---------------------------------------------------------------------------

describe('Phase 2: Similarity detection', () => {
    it('merges clusters with similar titles across files in same category', () => {
        // Use different directories to avoid shared-symbol dep overriding groupReason
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/components/A.tsx', category: 'react', title: 'Missing error boundary component' }),
            makeFinding({ file: 'src/pages/B.tsx', category: 'react', title: 'Missing error boundary wrapper' }),
        ];

        const clusters = clusterFindings(findings);
        // Should be merged due to high Jaccard similarity on title
        expect(clusters).toHaveLength(1);
        expect(clusters[0].findings).toHaveLength(2);
        expect(clusters[0].groupReason).toBe('similar-pattern');
    });

    it('does NOT merge dissimilar titles', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/A.tsx', category: 'react', title: 'Missing error boundary' }),
            makeFinding({ file: 'src/B.tsx', category: 'react', title: 'Unused state variable hook' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters).toHaveLength(2);
    });

    it('does NOT merge across different categories', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/A.tsx', category: 'react', title: 'Missing validation check' }),
            makeFinding({ file: 'src/B.tsx', category: 'security', title: 'Missing validation check' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters).toHaveLength(2);
    });
});


// ---------------------------------------------------------------------------
// Cluster Sorting & Severity
// ---------------------------------------------------------------------------

describe('Cluster sorting', () => {
    it('sorts clusters by highest severity (critical first)', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', severity: 'low', title: 'Low issue' }),
            makeFinding({ file: 'b.ts', category: 'security', severity: 'critical', title: 'Critical issue' }),
            makeFinding({ file: 'c.ts', category: 'react', severity: 'medium', title: 'Medium issue' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters[0].severity).toBe('critical');
        expect(clusters[clusters.length - 1].severity).toBe('low');
    });

    it('uses highest severity within a cluster', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'src/App.tsx', category: 'react', severity: 'low', title: 'Minor' }),
            makeFinding({ file: 'src/App.tsx', category: 'react', severity: 'critical', title: 'Major' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters[0].severity).toBe('critical');
    });
});

// ---------------------------------------------------------------------------
// flattenClusters
// ---------------------------------------------------------------------------

describe('flattenClusters', () => {
    it('returns all findings from all clusters', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue 1' }),
            makeFinding({ file: 'b.ts', category: 'react', title: 'Issue 2' }),
            makeFinding({ file: 'c.ts', category: 'security', title: 'Issue 3' }),
        ];

        const clusters = clusterFindings(findings);
        const flat = flattenClusters(clusters);
        expect(flat).toHaveLength(3);
    });

    it('returns empty array for empty clusters', () => {
        expect(flattenClusters([])).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Singleton clusters
// ---------------------------------------------------------------------------

describe('Singleton clusters', () => {
    it('wraps solo findings in a cluster of size 1', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'unique.ts', category: 'performance', title: 'Unique issue' }),
        ];

        const clusters = clusterFindings(findings);
        expect(clusters).toHaveLength(1);
        expect(clusters[0].findings).toHaveLength(1);
    });
});
