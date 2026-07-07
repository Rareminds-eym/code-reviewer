/**
 * Unit tests for the fallback markdown formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatFindingsAsMarkdown } from '../src/lib/review-formatter';
import { clusterFindings } from '../src/lib/finding-clusters';
import type { ReviewFinding } from '../src/types/review';
import type { FormatterOptions } from '../src/lib/review-formatter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(opts: Partial<ReviewFinding> & { file: string; category: ReviewFinding['category'] }): ReviewFinding {
    return {
        severity: 'medium',
        title: 'Default title',
        issue: 'Default issue',
        ...opts,
    };
}

const defaultOptions: FormatterOptions = {
    allFiles: ['src/App.tsx', 'src/utils.ts'],
    prTitle: 'Test PR',
    totalChunks: 2,
    failedChunks: 0,
    droppedFindingsCount: 0,
    failedChunkFiles: [],
    isFallback: false,
};

// ---------------------------------------------------------------------------
// Basic formatting
// ---------------------------------------------------------------------------

describe('formatFindingsAsMarkdown', () => {
    it('produces a complete review for findings', () => {
        const findings: ReviewFinding[] = [
            makeFinding({
                file: 'src/App.tsx',
                category: 'react',
                severity: 'high',
                title: 'Missing error boundary',
                issue: 'Main component lacks error boundary.',
                currentCode: '<App />',
                suggestedCode: '<ErrorBoundary><App /></ErrorBoundary>',
            }),
            makeFinding({
                file: 'src/utils.ts',
                category: 'typescript',
                severity: 'low',
                title: 'Unused variable',
                issue: 'Variable x is never used.',
            }),
        ];

        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('## 📊 Code Review Report');
        expect(md).toContain('## 🐛 Findings');
        expect(md).toContain('Missing error boundary');
        expect(md).toContain('Unused variable');
        expect(md).toContain('🔴 0 Critical');
        expect(md).toContain('🟠 1 High');
        expect(md).toContain('🟢 1 Low');
        expect(md).toContain('**Request Changes**');
    });

    it('produces approval message for empty findings', () => {
        const clusters = clusterFindings([]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('No Issues Found');
        expect(md).toContain('**Approve**');
    });

    it('includes fallback banner when isFallback is true', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ];
        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, { ...defaultOptions, isFallback: true });

        expect(md).toContain('Fallback Mode');
        expect(md).toContain('Both AI providers were unavailable');
    });

    it('does NOT include fallback banner when isFallback is false', () => {
        const findings: ReviewFinding[] = [
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ];
        const clusters = clusterFindings(findings);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).not.toContain('Fallback Mode');
    });
});

// ---------------------------------------------------------------------------
// Truncation & coverage metadata
// ---------------------------------------------------------------------------

describe('Metadata reporting', () => {
    it('reports dropped findings count', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, {
            ...defaultOptions,
            droppedFindingsCount: 5,
        });

        expect(md).toContain('⚠️ 5 lower-priority findings omitted');
    });

    it('reports failed chunk files', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', title: 'Issue' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, {
            ...defaultOptions,
            failedChunkFiles: ['src/broken.ts', 'src/missing.ts'],
        });

        expect(md).toContain('Incomplete Coverage Details');
        expect(md).toContain('src/broken.ts');
        expect(md).toContain('src/missing.ts');
    });

    // Removed obsolete check for `totalChunks` metadata, as we now only report `failedChunkFiles` for coverage.
});

// ---------------------------------------------------------------------------
// Verdict derivation
// ---------------------------------------------------------------------------

describe('Verdict in output', () => {
    it('includes Request Changes for critical findings', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'security', severity: 'critical', title: 'SQL injection' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('**Request Changes**');
    });

    it('includes Approve for only low/medium findings', () => {
        const clusters = clusterFindings([
            makeFinding({ file: 'a.ts', category: 'typescript', severity: 'low', title: 'Minor' }),
        ]);
        const md = formatFindingsAsMarkdown(clusters, defaultOptions);

        expect(md).toContain('**Approve**');
    });
});
