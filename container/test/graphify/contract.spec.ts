/**
 * CLI CONTRACT / SMOKE TEST — runs the REAL pinned `graphify` binary.
 *
 * Every other graphify spec mocks `execa`, so nothing there would catch a change
 * in graphify's actual command names, flags, exit codes, stderr strings, stdout
 * format, or graph.json schema. This suite locks those assumptions against the
 * installed (pinned) binary. It SKIPS gracefully when `graphify` is absent (e.g.
 * a dev laptop without it), but MUST run in CI/the container where it is pinned.
 *
 * If graphify is bumped and its schema/output drifts, THIS test fails — instead
 * of the integration silently degrading to zero graph context in production
 * (exactly the failure the mocks hid before).
 *
 * NOTE: this file must NOT `vi.mock('execa')` — it needs the real binary.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse } from '../../src/lib/graphify/graph-parser.js';
import { blastRadius } from '../../src/lib/graphify/query-service.js';

function graphifyAvailable(): boolean {
	try {
		execFileSync('graphify', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const AVAILABLE = graphifyAvailable();

/** A clean env with all semantic-extraction keys stripped → code-only path. */
function codeOnlyEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const k of [
		'GEMINI_API_KEY',
		'GOOGLE_API_KEY',
		'ANTHROPIC_API_KEY',
		'OPENAI_API_KEY',
		'DEEPSEEK_API_KEY',
		'KIMI_API_KEY',
		'MOONSHOT_API_KEY',
		'GRAPHIFY_SEMANTIC_DOCS',
	]) {
		delete env[k];
	}
	return env;
}

describe.skipIf(!AVAILABLE)('graphify CLI contract (real binary)', () => {
	let repo: string;

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'gfx-contract-'));
		mkdirSync(join(repo, 'src'), { recursive: true });
		// A doc file is present on purpose: it must NOT break the code-only path.
		writeFileSync(join(repo, 'README.md'), '# Contract fixture\nDocs present.\n');
		writeFileSync(
			join(repo, 'src', 'b.ts'),
			'export function helper() { return 1; }\n'
		);
		writeFileSync(
			join(repo, 'src', 'a.ts'),
			[
				"import { helper } from './b';",
				'export class Service { run() { return helper(); } }',
				'export function topLevel() { return new Service().run(); }',
			].join('\n') + '\n'
		);
		// Production always runs against a git clone; `built_at_commit` is sourced
		// from git HEAD, so the fixture must be a real repo for that field to exist.
		const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
		git('init');
		git('config', 'user.email', 'contract@test.local');
		git('config', 'user.name', 'contract');
		git('add', '-A');
		git('commit', '-m', 'fixture');
	});

	afterAll(() => {
		if (repo) rmSync(repo, { recursive: true, force: true });
	});

	it('`graphify update` produces a code-only graph WITH docs present and NO key (Blocker 1)', async () => {
		const res = await execa('graphify', ['update', repo], {
			cwd: repo,
			env: codeOnlyEnv(),
			extendEnv: false,
			reject: false,
			timeout: 120_000,
		});
		expect(res.exitCode).toBe(0);
		expect(existsSync(join(repo, 'graphify-out', 'graph.json'))).toBe(true);
	});

	it('graph.json matches the schema the GraphParser targets', () => {
		const graph = JSON.parse(
			readFileSync(join(repo, 'graphify-out', 'graph.json'), 'utf-8')
		) as Record<string, unknown>;
		// Node-link keys the parser relies on; NO phantom `edges`.
		expect(Array.isArray(graph.nodes)).toBe(true);
		expect(Array.isArray(graph.links)).toBe(true);
		expect('edges' in graph).toBe(false);
		expect(typeof graph.built_at_commit).toBe('string');
		const node = (graph.nodes as Array<Record<string, unknown>>)[0];
		expect(typeof node.id).toBe('string');
		expect(typeof node.label).toBe('string');
		expect(typeof node.source_file).toBe('string');
		// source_file is repo-root-relative, forward-slashed, no leading './'.
		expect(node.source_file as string).not.toMatch(/^\.\//);
		expect(node.source_file as string).not.toMatch(/\\/);
	});

	it('our GraphParser reads the real output correctly (edges, gods, commit)', () => {
		const data = parse(join(repo, 'graphify-out'));
		expect(data.available).toBe(true);
		expect(data.nodeCount).toBeGreaterThan(0);
		expect(data.edgeCount).toBeGreaterThan(0);
		expect(data.builtAtCommit).toBeTypeOf('string');
		// No sidecar on the update path → gods DERIVED from links (non-empty here).
		expect(data.godNodes.length).toBeGreaterThan(0);
		// The changed file maps into the graph (path-normalization contract).
		expect(data.nodesByFile.has('src/a.ts')).toBe(true);
	});

	it('real `blastRadius` resolves changed-file node IDs and parses `affected` output', async () => {
		// End-to-end against the real binary: resolveNodeIds(src/b.ts) → unique node
		// IDs → `graphify affected` → parseAffectedOutput. `helper` in b.ts is called
		// by a.ts, so its reverse-dependents must be found and parsed cleanly. This
		// locks the whole query contract (command, flags, and stdout line format).
		const data = parse(join(repo, 'graphify-out'));
		const results = await blastRadius(join(repo, 'graphify-out'), data, ['src/b.ts'], []);
		expect(results.length).toBeGreaterThan(0);

		const totalDeps = results.reduce((n, r) => n + r.dependents.length, 0);
		expect(totalDeps).toBeGreaterThan(0); // helper() has real callers

		for (const r of results) {
			for (const d of r.dependents) {
				// The `- <label> [<relation>] <loc>` format the parser depends on.
				expect(d.label.length).toBeGreaterThan(0);
				expect(d.relation.length).toBeGreaterThan(0);
			}
		}
	});
});
