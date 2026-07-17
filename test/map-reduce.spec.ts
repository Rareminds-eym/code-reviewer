import { describe, it, expect } from 'vitest';
import { parseFindings } from '../container/src/lib/llm/parse-findings';
import { buildGlobalContext, classifyFiles } from '../src/lib/github';
import type { GitHubPRFile } from '../src/types/github';

// ---------------------------------------------------------------------------
// parseFindings — Defensive JSON Parsing
// ---------------------------------------------------------------------------

describe('parseFindings', () => {
    it('parses clean JSON with valid findings', () => {
        const raw = JSON.stringify({
            findings: [
                {
                    severity: 'critical',
                    file: 'src/App.tsx',
                    title: 'Missing error boundary',
                    issue: 'No error boundary wraps the main component.',
                    category: 'react',
                },
            ],
        });

        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('critical');
        expect(result[0].file).toBe('src/App.tsx');
        expect(result[0].category).toBe('react');
    });

    it('parses JSON wrapped in markdown code fences', () => {
        const raw = '```json\n{"findings":[{"severity":"low","file":"a.ts","title":"t","issue":"i","category":"clean-code"}]}\n```';
        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('low');
    });

    it('handles JSON with leading prose from the LLM', () => {
        const raw = 'Here are my findings:\n\n{"findings":[{"severity":"medium","file":"b.ts","title":"unused var","issue":"x is unused","category":"typescript"}]}';
        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].title).toBe('unused var');
    });

    it('returns empty array for completely invalid input', () => {
        const result = parseFindings('This is not JSON at all, just a text response.');
        expect(result).toHaveLength(0);
    });

    it('returns empty array for empty findings', () => {
        const result = parseFindings('{"findings":[]}');
        expect(result).toHaveLength(0);
    });

    it('skips findings with missing required fields', () => {
        const raw = JSON.stringify({
            findings: [
                { severity: 'high', file: 'a.ts' }, // missing title, issue, category
                { severity: 'low', file: 'b.ts', title: 'ok', issue: 'fine', category: 'react' },
            ],
        });
        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].file).toBe('b.ts');
    });

    it('normalizes unknown categories to clean-code', () => {
        const raw = JSON.stringify({
            findings: [
                { severity: 'low', file: 'a.ts', title: 't', issue: 'i', category: 'unknown-category' },
            ],
        });
        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].category).toBe('clean-code');
    });

    it('handles a raw array (no wrapping object)', () => {
        const raw = JSON.stringify([
            { severity: 'high', file: 'x.ts', title: 'bad', issue: 'very bad', category: 'security' },
        ]);
        const result = parseFindings(raw);
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('high');
    });

    it('truncates absurdly long titles and issues', () => {
        const raw = JSON.stringify({
            findings: [
                {
                    severity: 'low',
                    file: 'a.ts',
                    title: 'x'.repeat(500),
                    issue: 'y'.repeat(2000),
                    category: 'react',
                },
            ],
        });
        const result = parseFindings(raw);
        expect(result[0].title.length).toBeLessThanOrEqual(200);
        expect(result[0].issue.length).toBeLessThanOrEqual(1000);
    });
});

// ---------------------------------------------------------------------------
// buildGlobalContext — Every Chunk Gets PR Scope
// ---------------------------------------------------------------------------

describe('buildGlobalContext', () => {
    const mockFiles: GitHubPRFile[] = [
        {
            filename: 'src/App.tsx',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
            raw_url: 'https://example.com/raw',
            blob_url: 'https://example.com/blob',
            contents_url: 'https://example.com/contents',
        },
        {
            filename: 'src/utils.ts',
            status: 'added',
            additions: 50,
            deletions: 0,
            changes: 50,
            raw_url: 'https://example.com/raw2',
            blob_url: 'https://example.com/blob2',
            contents_url: 'https://example.com/contents2',
        },
    ];

    it('includes all reviewable files in the context', () => {
        const classified = classifyFiles(mockFiles);
        const ctx = buildGlobalContext(classified);

        expect(ctx).toContain('src/App.tsx');
        expect(ctx).toContain('src/utils.ts');
        expect(ctx).toContain('Global PR Context');
    });

    it('includes tier labels for classified files', () => {
        const classified = classifyFiles(mockFiles);
        const ctx = buildGlobalContext(classified);

        // Both should be Tier 1 (only 2 files, well under TIER1_MAX_FILES)
        expect(ctx).toContain('T1');
    });

    it('produces output within budget', () => {
        const classified = classifyFiles(mockFiles);
        const ctx = buildGlobalContext(classified);

        expect(ctx.length).toBeLessThan(10_000);
    });
});

// ---------------------------------------------------------------------------
// classifyFiles — Smart Prioritization
// ---------------------------------------------------------------------------

describe('classifyFiles', () => {
    it('skips noise files', () => {
        const files: GitHubPRFile[] = [
            {
                filename: 'package-lock.json',
                status: 'modified',
                additions: 500,
                deletions: 200,
                changes: 700,
                raw_url: 'https://example.com/raw',
                blob_url: 'https://example.com/blob',
                contents_url: 'https://example.com/contents',
            },
            {
                filename: 'src/index.tsx',
                status: 'modified',
                additions: 5,
                deletions: 2,
                changes: 7,
                raw_url: 'https://example.com/raw2',
                blob_url: 'https://example.com/blob2',
                contents_url: 'https://example.com/contents2',
            },
        ];

        const classified = classifyFiles(files);

        expect(classified.skipped).toContain('package-lock.json');
        expect(classified.tier1).toHaveLength(1);
        expect(classified.tier1[0].filename).toBe('src/index.tsx');
    });

    it('prioritizes source code over config files', () => {
        const files: GitHubPRFile[] = [
            {
                filename: 'README.md',
                status: 'modified',
                additions: 100,
                deletions: 50,
                changes: 150,
                raw_url: 'https://example.com/raw',
                blob_url: 'https://example.com/blob',
                contents_url: 'https://example.com/contents',
            },
            {
                filename: 'src/auth/LoginForm.tsx',
                status: 'added',
                additions: 60,
                deletions: 0,
                changes: 60,
                raw_url: 'https://example.com/raw2',
                blob_url: 'https://example.com/blob2',
                contents_url: 'https://example.com/contents2',
            },
        ];

        const classified = classifyFiles(files);
        // LoginForm.tsx: 60 × 2 (tsx) × 1.5 (added) × 1.3 (src/) = 234 > README.md: 150 × 1 = 150
        expect(classified.tier1[0].filename).toBe('src/auth/LoginForm.tsx');
    });
});
