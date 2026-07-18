import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { parse, canonicalizePath } from '../../src/lib/graphify/graph-parser.js';
import {
	sampleGraphJson,
	sampleAnalysisSidecar,
	writeGraphDir,
	cleanupGraphDir,
} from './fixtures.js';

describe('GraphParser', () => {
	const dirs: string[] = [];
	const track = (d: string) => {
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		while (dirs.length) cleanupGraphDir(dirs.pop()!);
	});

	it('derives edgeCount from `links`, NOT a phantom `edges` key (regression)', () => {
		const graph = sampleGraphJson();
		// Add a bogus top-level `edges` the old code wrongly read — must be ignored.
		(graph as Record<string, unknown>).edges = [1, 2, 3, 4, 5, 6, 7];
		const dir = track(writeGraphDir({ graph }));
		const data = parse(dir);
		expect(data.available).toBe(true);
		expect(data.edgeCount).toBe(2); // from `links`, not the 7-length `edges`
		expect(data.nodeCount).toBe(4);
	});

	it('reads god nodes from the sidecar `gods[]` and the commit', () => {
		const dir = track(writeGraphDir({}));
		const data = parse(dir);
		expect(data.godNodes).toEqual([{ id: 'pkg_sub_deep_foo', label: 'foo()', degree: 3 }]);
		expect(data.builtAtCommit).toBe('6a2acc82');
	});

	it('builds nodesByFile keyed by canonical source_file', () => {
		const dir = track(writeGraphDir({}));
		const data = parse(dir);
		expect([...data.nodesByFile.keys()].sort()).toEqual(['pkg/sub/deep.ts', 'pkg/top.ts']);
		expect(data.nodesByFile.get('pkg/top.ts')!.map((n) => n.id).sort()).toEqual([
			'pkg_top',
			'pkg_top_x',
		]);
	});

	it('derives god nodes from link-degree when the sidecar is absent', () => {
		const dir = track(writeGraphDir({ sidecar: null }));
		const data = parse(dir);
		expect(data.available).toBe(true); // graph.json present
		// No sidecar (the code-only `update` path) → god nodes are DERIVED from
		// `links`. Each fixture node touches exactly one link → degree 1.
		expect(data.godNodes.length).toBe(4);
		expect(data.godNodes.every((g) => g.degree === 1)).toBe(true);
		expect(data.godNodes.map((g) => g.id)).toContain('pkg_sub_deep_foo');
	});

	it('prefers the sidecar gods over structural derivation when present', () => {
		const dir = track(writeGraphDir({})); // sidecar present (1 god)
		const data = parse(dir);
		expect(data.godNodes).toEqual([{ id: 'pkg_sub_deep_foo', label: 'foo()', degree: 3 }]);
	});

	it('derives no god nodes when there are no links', () => {
		const dir = track(writeGraphDir({ graph: sampleGraphJson({ links: [] }), sidecar: null }));
		const data = parse(dir);
		expect(data.godNodes).toEqual([]);
	});

	it('returns available:false when graph.json is missing', () => {
		const dir = track(writeGraphDir({ graph: null, sidecar: null }));
		const data = parse(dir);
		expect(data.available).toBe(false);
		expect(data.nodeCount).toBe(0);
		expect(data.edgeCount).toBe(0);
	});

	it('returns available:false on malformed JSON (never throws)', () => {
		const dir = track(writeGraphDir({ rawGraph: '{ this is not json' }));
		expect(() => parse(dir)).not.toThrow();
		expect(parse(dir).available).toBe(false);
	});

	// Property 1: parser never throws for arbitrary/degenerate inputs.
	it('Property 1: never throws for arbitrary JSON graph bodies', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (body) => {
				const dir = writeGraphDir({ rawGraph: JSON.stringify(body), sidecar: null });
				try {
					const data = parse(dir);
					expect(typeof data.available).toBe('boolean');
					expect(data.edgeCount).toBeGreaterThanOrEqual(0);
					expect(data.nodeCount).toBeGreaterThanOrEqual(0);
				} finally {
					cleanupGraphDir(dir);
				}
			}),
			{ numRuns: 100 }
		);
	});

	it('Property 1: never throws for arbitrary raw byte strings', () => {
		fc.assert(
			fc.property(fc.string(), (raw) => {
				const dir = writeGraphDir({ rawGraph: raw, sidecar: null });
				try {
					expect(() => parse(dir)).not.toThrow();
				} finally {
					cleanupGraphDir(dir);
				}
			}),
			{ numRuns: 100 }
		);
	});
});

describe('canonicalizePath', () => {
	it('strips leading ./ and normalizes separators', () => {
		expect(canonicalizePath('./pkg/x.ts')).toBe('pkg/x.ts');
		expect(canonicalizePath('pkg\\sub\\y.ts')).toBe('pkg/sub/y.ts');
		expect(canonicalizePath('pkg/x.ts')).toBe('pkg/x.ts');
	});
});
