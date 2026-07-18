import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

vi.mock('execa', () => ({ execa: vi.fn() }));
import { execa } from 'execa';

import {
	parseAffectedOutput,
	resolveNodeIds,
	blastRadius,
} from '../../src/lib/graphify/query-service.js';
import { parse } from '../../src/lib/graphify/graph-parser.js';
import { writeGraphDir, cleanupGraphDir, SAMPLE_AFFECTED_STDOUT } from './fixtures.js';
import type { SymbolInfo } from '../../src/types.js';

const mockedExeca = vi.mocked(execa);

describe('parseAffectedOutput', () => {
	it('parses label, relation, and location; ignores headers', () => {
		const deps = parseAffectedOutput(SAMPLE_AFFECTED_STDOUT);
		expect(deps).toEqual([
			{ label: 'x', relation: 'calls', location: 'pkg/top.ts:L2' },
			{ label: 'top.ts', relation: 'imports', location: 'pkg/top.ts:L1' },
		]);
	});

	it('returns [] for empty / no-match output', () => {
		expect(parseAffectedOutput('No unique node match for Logger')).toEqual([]);
		expect(parseAffectedOutput('')).toEqual([]);
	});
});

describe('resolveNodeIds', () => {
	it('maps changed files to unique node IDs, ranking symbol-changed files first', () => {
		const dir = writeGraphDir({});
		const data = parse(dir);
		const changedSymbols: SymbolInfo[] = [
			{ name: 'foo', kind: 'function', file: 'pkg/sub/deep.ts', startLine: 1, endLine: 1 },
		];
		const ids = resolveNodeIds(data, ['pkg/top.ts', './pkg/sub/deep.ts'], changedSymbols);
		// deep.ts (ranked) node IDs should come before top.ts node IDs.
		expect(ids[0]).toMatch(/deep/);
		expect(ids).toContain('pkg_top');
		cleanupGraphDir(dir);
	});

	it('canonicalizes paths so ./pkg/x matches node source_file pkg/x', () => {
		const dir = writeGraphDir({});
		const data = parse(dir);
		const ids = resolveNodeIds(data, ['./pkg/top.ts'], []);
		expect(ids).toContain('pkg_top');
		cleanupGraphDir(dir);
	});

	it('returns [] when no changed file maps into the graph', () => {
		const dir = writeGraphDir({});
		const data = parse(dir);
		expect(resolveNodeIds(data, ['unrelated/other.ts'], [])).toEqual([]);
		cleanupGraphDir(dir);
	});
});

describe('blastRadius', () => {
	beforeEach(() => mockedExeca.mockReset());

	it('queries by node ID and parses dependents + matchCount', async () => {
		mockedExeca.mockResolvedValue({ exitCode: 0, stdout: SAMPLE_AFFECTED_STDOUT } as never);
		const dir = writeGraphDir({});
		const data = parse(dir);
		const res = await blastRadius(dir, data, ['pkg/top.ts'], []);
		expect(res.length).toBeGreaterThan(0);
		expect(res[0].matchCount).toBe(2);
		// Assert it queried by unique ID, never a bare label.
		const [, args] = mockedExeca.mock.calls[0];
		expect(args).toContain('affected');
		expect((args as string[]).some((a) => a.startsWith('pkg_'))).toBe(true);
		cleanupGraphDir(dir);
	});

	it('records zero-result and continues batch on no-unique-match exit', async () => {
		mockedExeca.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'No unique node match' } as never);
		const dir = writeGraphDir({});
		const data = parse(dir);
		const res = await blastRadius(dir, data, ['pkg/top.ts'], []);
		expect(res.every((r) => r.matchCount === 0)).toBe(true);
		cleanupGraphDir(dir);
	});

	it('returns [] and issues no queries when no node IDs resolve', async () => {
		const dir = writeGraphDir({});
		const data = parse(dir);
		const res = await blastRadius(dir, data, ['unrelated/other.ts'], []);
		expect(res).toEqual([]);
		expect(mockedExeca).not.toHaveBeenCalled();
		cleanupGraphDir(dir);
	});

	it('stops launching queries once the aggregate query budget is exceeded', async () => {
		// Each mocked call "takes" ~20ms; with a 0ms budget, no query should fire.
		mockedExeca.mockImplementation((async () => {
			await new Promise((r) => setTimeout(r, 20));
			return { exitCode: 0, stdout: SAMPLE_AFFECTED_STDOUT };
		}) as never);
		const dir = writeGraphDir({});
		const data = parse(dir);
		// queryBudgetMs = 0 → deadline is already past on the first iteration.
		const res = await blastRadius(dir, data, ['pkg/top.ts', 'pkg/sub/deep.ts'], [], undefined, 0);
		expect(res).toEqual([]);
		expect(mockedExeca).not.toHaveBeenCalled();
		cleanupGraphDir(dir);
	});

	// Property 6: scope monotonicity — dependents parsed from affected output
	// are a subset of graph node labels for the fixture graph.
	it('Property 6: parsed dependents are a subset of graph node labels', async () => {
		const dir = writeGraphDir({});
		const data = parse(dir);
		const labels = new Set(
			[...data.nodesByFile.values()].flat().map((n) => n.label).filter(Boolean)
		);
		mockedExeca.mockResolvedValue({ exitCode: 0, stdout: SAMPLE_AFFECTED_STDOUT } as never);
		const res = await blastRadius(dir, data, ['pkg/top.ts'], []);
		for (const r of res) {
			for (const d of r.dependents) {
				expect(labels.has(d.label)).toBe(true);
			}
		}
		cleanupGraphDir(dir);
	});
});
