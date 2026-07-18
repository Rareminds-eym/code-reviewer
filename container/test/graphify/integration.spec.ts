import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the component boundaries so we drive the orchestrator across the matrix.
vi.mock('../../src/lib/graphify/extraction-runner.js', () => ({
	ensureGraph: vi.fn(),
	graphDirFor: (w: string) => `${w}-gfx`,
}));
vi.mock('../../src/lib/graphify/graph-parser.js', () => ({
	parse: vi.fn(),
	canonicalizePath: (p: string) => p,
}));
vi.mock('../../src/lib/graphify/query-service.js', () => ({
	blastRadius: vi.fn(),
}));

import { run } from '../../src/lib/graphify/index.js';
import { ensureGraph } from '../../src/lib/graphify/extraction-runner.js';
import { parse } from '../../src/lib/graphify/graph-parser.js';
import { blastRadius } from '../../src/lib/graphify/query-service.js';
import type { GraphData } from '../../src/lib/graphify/types.js';

const mEnsure = vi.mocked(ensureGraph);
const mParse = vi.mocked(parse);
const mBlast = vi.mocked(blastRadius);

const okData: GraphData = {
	nodeCount: 100,
	edgeCount: 250,
	godNodes: [{ id: 'g', label: 'runReviewPipeline()', degree: 48 }],
	builtAtCommit: 'deadbeef',
	nodesByFile: new Map([['pkg/a.ts', [{ id: 'pkg_a', label: 'a', source_file: 'pkg/a.ts' }]]]),
	available: true,
};

const unavailableData: GraphData = {
	nodeCount: 0,
	edgeCount: 0,
	godNodes: [],
	nodesByFile: new Map(),
	available: false,
};

beforeEach(() => {
	mEnsure.mockReset();
	mParse.mockReset();
	mBlast.mockReset();
});

describe('GraphifyIntegration.run — success path', () => {
	it('produces PR-scoped context, no notice, and correct telemetry', async () => {
		mEnsure.mockResolvedValue({ ok: true, mode: 'full', graphDir: '/x-gfx', durationMs: 1234 });
		mParse.mockReturnValue(okData);
		mBlast.mockResolvedValue([
			{ subject: 'pkg_a', matchCount: 2, dependents: [
				{ label: 'b', relation: 'calls' }, { label: 'c', relation: 'imports' },
			] },
		]);

		const { context, telemetry } = await run('/x', ['pkg/a.ts'], [], undefined, 5000, 120000);

		expect(context.render()).toContain('Blast Radius');
		expect(context.reviewNotice()).toBeUndefined();
		expect(telemetry).toMatchObject({
			nodeCount: 100,
			edgeCount: 250,
			godNodeCount: 1,
			mode: 'full',
			queriedSymbols: 1,
			totalMatches: 2,
		});
		expect(telemetry.degradationReason).toBeUndefined();
	});
});

describe('GraphifyIntegration.run — failure matrix', () => {
	it('missing-key: keeps code-only graph, emits notice', async () => {
		mEnsure.mockResolvedValue({
			ok: true, mode: 'full', graphDir: '/x-gfx', durationMs: 10, degradationReason: 'missing-key',
		});
		mParse.mockReturnValue(okData);
		mBlast.mockResolvedValue([]);
		const { context, telemetry } = await run('/x', ['pkg/a.ts'], [], undefined, 5000, 120000);
		expect(telemetry.degradationReason).toBe('missing-key');
		expect(context.reviewNotice()).toMatch(/code only/i);
		expect(context.render().length).toBeGreaterThan(0);
	});

	it('timeout: unavailable graph, timeout notice, review continues', async () => {
		mEnsure.mockResolvedValue({
			ok: false, mode: 'full', graphDir: '/x-gfx', durationMs: 120000, degradationReason: 'timeout',
		});
		mParse.mockReturnValue(unavailableData);
		const { context, telemetry } = await run('/x', ['pkg/a.ts'], [], undefined, 5000, 120000);
		expect(telemetry.degradationReason).toBe('timeout');
		expect(context.reviewNotice()).toMatch(/timed out/i);
		expect(context.render()).toContain('unavailable');
		expect(mBlast).not.toHaveBeenCalled(); // no querying without a usable graph
	});

	it('malformed graph: unavailable context + notice', async () => {
		mEnsure.mockResolvedValue({ ok: false, mode: 'full', graphDir: '/x-gfx', durationMs: 5 });
		mParse.mockReturnValue(unavailableData);
		const { context, telemetry } = await run('/x', ['pkg/a.ts'], [], undefined, 5000, 120000);
		expect(telemetry.degradationReason).toBe('malformed-graph');
		expect(context.reviewNotice()).toBeTypeOf('string');
	});

	it('unexpected error inside a component: falls back to a valid context', async () => {
		mEnsure.mockRejectedValue(new Error('boom'));
		const { context, telemetry } = await run('/x', ['pkg/a.ts'], [], undefined, 5000, 120000);
		expect(telemetry.degradationReason).toBe('unexpected-error');
		expect(context.render().length).toBeGreaterThan(0);
		expect(context.reviewNotice()).toMatch(/unexpected error/i);
	});
});
