import { describe, it, expect } from 'vitest';
import { applySmartDedup, type PRCommentThread } from '../src/lib/smart-dedup';

describe('applySmartDedup', () => {
    const makeFinding = (file: string, line: number, title = 'Test issue') => ({
        file,
        line,
        title,
        severity: 'high',
        issue: 'Something is wrong here',
    });

    const makeThread = (
        path: string,
        line: number,
        isBot: boolean,
        position: number | null,
        originalPosition: number | null = null
    ): PRCommentThread => ({
        path,
        line,
        position,
        originalPosition,
        isBot,
        reviewId: 1,
        createdAt: '2026-01-01T00:00:00Z',
        body: 'Test comment',
    });

    it('posts new findings with no existing threads', () => {
        const findings = [makeFinding('src/index.ts', 10)];
        const result = applySmartDedup(findings, [], { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(1);
        expect(result.findingsToPost[0].reason).toBe('new_finding');
        expect(result.suppressedInline).toHaveLength(0);
        expect(result.allUnresolved).toHaveLength(1);
    });

    it('suppresses findings on unmodified lines with active bot threads', () => {
        const findings = [makeFinding('src/index.ts', 10)];
        const threads = [makeThread('src/index.ts', 10, true, 5)]; // position=5 means active (not outdated)
        const result = applySmartDedup(findings, threads, { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(0);
        expect(result.suppressedInline).toHaveLength(1);
        expect(result.suppressedInline[0].reason).toBe('active_thread_unmodified_line');
        expect(result.allUnresolved).toHaveLength(1); // Still in checklist
    });

    it('re-posts findings when thread is on outdated (modified) code', () => {
        const findings = [makeFinding('src/index.ts', 10)];
        // position=null + original_position set = comment is on outdated diff
        const threads = [makeThread('src/index.ts', 10, true, null, 5)];
        const result = applySmartDedup(findings, threads, { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(1);
        expect(result.findingsToPost[0].reason).toBe('line_modified_repost');
        expect(result.suppressedInline).toHaveLength(0);
    });

    it('re-posts findings when line was modified in current PR', () => {
        const findings = [makeFinding('src/index.ts', 10)];
        const threads = [makeThread('src/index.ts', 10, true, 5)]; // active thread
        const modifiedLines = new Map<string, Set<number>>([['src/index.ts', new Set([10])]]);
        const result = applySmartDedup(findings, threads, { modifiedLines, headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(1);
        expect(result.findingsToPost[0].reason).toBe('line_modified_repost');
        expect(result.suppressedInline).toHaveLength(0);
    });

    it('ignores non-bot threads', () => {
        const findings = [makeFinding('src/index.ts', 10)];
        // Human comment on the same line — shouldn't affect bot behavior
        const threads = [makeThread('src/index.ts', 10, false, 5)];
        const result = applySmartDedup(findings, threads, { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(1);
        expect(result.findingsToPost[0].reason).toBe('new_finding');
    });

    it('handles mixed scenarios: some suppressed, some posted', () => {
        const findings = [
            makeFinding('src/file1.ts', 10, 'Unchanged line issue'),
            makeFinding('src/file2.ts', 20, 'Modified line issue'),
            makeFinding('src/file3.ts', 30, 'New issue'),
        ];
        const threads = [
            makeThread('src/file1.ts', 10, true, 5),  // active, unmodified — suppress
            makeThread('src/file2.ts', 20, true, null, 5), // outdated — re-post
        ];
        const result = applySmartDedup(findings, threads, { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(2); // file2 + file3
        expect(result.suppressedInline).toHaveLength(1); // file1
        expect(result.allUnresolved).toHaveLength(3); // all in checklist
    });

    it('handles findings without file or line', () => {
        const findings = [{ severity: 'high', title: 'No file', issue: 'test' }];
        const result = applySmartDedup(findings, [], { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(1);
        expect(result.findingsToPost[0].reason).toBe('no_file_or_line');
    });

    it('handles empty findings array', () => {
        const result = applySmartDedup([], [], { modifiedLines: new Map(), headSha: 'abc123' });
        expect(result.findingsToPost).toHaveLength(0);
        expect(result.suppressedInline).toHaveLength(0);
        expect(result.allUnresolved).toHaveLength(0);
    });
});
