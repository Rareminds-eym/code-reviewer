/**
 * Shared fixtures for the Graphify integration tests.
 *
 * These mirror the real shape of graphify 0.9.5 output verified against the CLI:
 * - graph.json is networkx node-link: keys `nodes`, `links`, `built_at_commit`
 *   (NO `edges`, NO `metadata`, NO `godNodes`).
 * - nodes carry `label`, `source_file`, `id`.
 * - `.graphify_analysis.json` sidecar carries `gods[]` = {id, label, degree}.
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface FixtureNode {
	id: string;
	label: string;
	source_file: string;
}

export interface FixtureLink {
	source: string;
	target: string;
	relation?: string;
}

/** A minimal but realistic graph.json body (node-link format). */
export function sampleGraphJson(overrides: Partial<{
	nodes: FixtureNode[];
	links: FixtureLink[];
	built_at_commit: string;
}> = {}): Record<string, unknown> {
	const nodes: FixtureNode[] = overrides.nodes ?? [
		{ id: 'pkg_top', label: 'top.ts', source_file: 'pkg/top.ts' },
		{ id: 'pkg_top_x', label: 'x', source_file: 'pkg/top.ts' },
		{ id: 'pkg_sub_deep', label: 'deep.ts', source_file: 'pkg/sub/deep.ts' },
		{ id: 'pkg_sub_deep_foo', label: 'foo()', source_file: 'pkg/sub/deep.ts' },
	];
	const links: FixtureLink[] = overrides.links ?? [
		{ source: 'pkg_top_x', target: 'pkg_sub_deep_foo', relation: 'calls' },
		{ source: 'pkg_top', target: 'pkg_sub_deep', relation: 'imports' },
	];
	return {
		directed: false,
		multigraph: false,
		graph: {},
		nodes,
		links,
		hyperedges: [],
		built_at_commit: overrides.built_at_commit ?? '6a2acc82',
	};
}

/** A minimal `.graphify_analysis.json` sidecar body. */
export function sampleAnalysisSidecar(overrides: Partial<{
	gods: Array<{ id: string; label: string; degree: number }>;
}> = {}): Record<string, unknown> {
	return {
		communities: {},
		cohesion: {},
		gods: overrides.gods ?? [
			{ id: 'pkg_sub_deep_foo', label: 'foo()', degree: 3 },
		],
		surprises: [],
		tokens: { input: 0, output: 0 },
	};
}

/**
 * Write a graph.json (+ optional sidecar) into a fresh temp graphDir and return
 * its path. Caller must pass the returned dir to `cleanupGraphDir`.
 */
export function writeGraphDir(opts: {
	graph?: Record<string, unknown> | null;
	sidecar?: Record<string, unknown> | null;
	rawGraph?: string; // write this exact string instead of JSON.stringify
} = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'gfx-fixture-'));
	mkdirSync(dir, { recursive: true });
	if (opts.rawGraph !== undefined) {
		writeFileSync(join(dir, 'graph.json'), opts.rawGraph, 'utf-8');
	} else if (opts.graph !== null) {
		writeFileSync(join(dir, 'graph.json'), JSON.stringify(opts.graph ?? sampleGraphJson()), 'utf-8');
	}
	if (opts.sidecar !== null) {
		writeFileSync(
			join(dir, '.graphify_analysis.json'),
			JSON.stringify(opts.sidecar ?? sampleAnalysisSidecar()),
			'utf-8'
		);
	}
	return dir;
}

export function cleanupGraphDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/** Sample `graphify affected` stdout for a unique node (relation + location). */
export const SAMPLE_AFFECTED_STDOUT = `Affected nodes for foo()
Relations: calls, indirect_call, references, imports, imports_from, re_exports, inherits, extends, implements, uses, mixes_in, embeds
Depth: 2
- x [calls] pkg/top.ts:L2
- top.ts [imports] pkg/top.ts:L1
`;

/** Sample stdout when a bare label is ambiguous (the failure we design around). */
export const SAMPLE_AFFECTED_NO_UNIQUE = `No unique node match for Logger`;
