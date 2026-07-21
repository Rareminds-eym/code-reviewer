import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
	executeTool,
	STALE_LOCATION_PREFIX,
	VERIFIER_TOOLS,
	type ToolContext,
} from '../src/lib/llm/verifier-tools';
import { READ_FILE_MAX_LINES } from '../src/config/constants';

/**
 * Tests for the read-only, sandboxed verification tool layer (R6.2–R6.4, R9.3).
 *
 * Property 5 (Sandbox safety): for arbitrary tool arguments, `read_file` never
 * resolves outside the Workspace and no tool writes files, executes a shell, or
 * performs disallowed egress.
 *
 * Layout of the temp tree used by these tests:
 *
 *   <root>/
 *     workspace/              <- ctx.workDir (the sandbox boundary)
 *       src/big.ts            <- 500-line file used for range-bound checks
 *       src/small.ts
 *     secret.txt              <- lives OUTSIDE workDir; its marker must NEVER leak
 *     graphless/              <- ctx.graphDir with NO graph.json
 */

// A unique, high-entropy marker that only exists in the out-of-workspace secret.
const SECRET_MARKER = 'SUPER_SECRET_LEAK_CANARY_9f83ac21d7';
const BIG_FILE_LINES = 500;

let root: string;
let workDir: string;
let graphDir: string;
let ctx: ToolContext;

/** Recursively list every regular file under `dir` as workspace-relative paths. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(dir, full).split(sep).join('/'));
		}
	};
	walk(dir);
	return out.sort();
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'verifier-tools-'));
	workDir = join(root, 'workspace');
	graphDir = join(root, 'graphless');
	mkdirSync(join(workDir, 'src'), { recursive: true });
	mkdirSync(graphDir, { recursive: true });

	// A large, in-workspace file with deterministic content for range tests.
	const big = Array.from({ length: BIG_FILE_LINES }, (_, i) => `line ${i + 1} content`).join('\n');
	writeFileSync(join(workDir, 'src', 'big.ts'), big, 'utf-8');
	writeFileSync(join(workDir, 'src', 'small.ts'), 'alpha\nbeta\ngamma\n', 'utf-8');

	// The secret lives OUTSIDE the workspace. Its marker must never appear in any
	// ok result no matter what path the model supplies.
	writeFileSync(join(root, 'secret.txt'), `TOP ${SECRET_MARKER} SECRET`, 'utf-8');

	ctx = { workDir, graphDir };
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('verifier-tools: tool surface is read-only (R6.2, R6.4)', () => {
	it('exposes exactly the four read-only tools', () => {
		expect(VERIFIER_TOOLS.map((t) => t.name).sort()).toEqual([
			'graphify_affected',
			'graphify_explain',
			'graphify_query',
			'read_file',
		]);
	});

	it('exposes no tool whose name suggests a write / exec / network capability', () => {
		const forbidden = /(write|create|delete|remove|exec|run_shell|shell|spawn|fetch|http|network|edit|patch|apply)/i;
		for (const tool of VERIFIER_TOOLS) {
			expect(tool.name).not.toMatch(forbidden);
		}
	});

	it('rejects an unknown tool name with a tool error, never a throw', async () => {
		const res = await executeTool('write_file', { path: 'x', content: 'y' }, ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/unknown tool/i);
	});
});

describe('verifier-tools: read_file sandbox safety (Property 5, R6.3)', () => {
	// Generator biased toward escape attempts: random junk plus traversal chains,
	// absolute-ish paths, encoded traversal, and NUL smuggling.
	const escapePath = fc.oneof(
		fc.string(),
		fc.constantFrom(
			'../secret.txt',
			'../../secret.txt',
			'../../../secret.txt',
			'../../../../../../secret.txt',
			'./../secret.txt',
			'src/../../secret.txt',
			'src/../../../secret.txt',
			'/etc/passwd',
			'/absolute/secret.txt',
			'..%2Fsecret.txt',
			'%2e%2e/secret.txt',
			'..\\secret.txt',
			'src/big.ts\0../../secret.txt',
			'....//secret.txt',
		),
		// Arbitrary-depth `../` chains appended to the secret name.
		fc.array(fc.constant('../'), { minLength: 0, maxLength: 12 }).map((segs) => segs.join('') + 'secret.txt'),
	);

	it('never returns the out-of-workspace secret for any argument', async () => {
		await fc.assert(
			fc.asyncProperty(escapePath, async (path) => {
				const res = await executeTool('read_file', { path }, ctx);
				if (res.ok) {
					// In-workspace reads are allowed, but they must NEVER contain the
					// marker that only exists in the out-of-workspace secret file.
					expect(res.result.includes(SECRET_MARKER)).toBe(false);
				}
				// When not ok, it must be a structured tool error (never a throw).
				else {
					expect(typeof res.error).toBe('string');
				}
			}),
			{ numRuns: 500 },
		);
	});

	it('rejects absolute paths outright', async () => {
		const res = await executeTool('read_file', { path: '/etc/hosts' }, ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/absolute/i);
	});

	it('rejects a symlink that escapes the workspace', () => {
		// Create a symlink INSIDE the workspace pointing at the out-of-workspace
		// secret; read_file must reject it via the post-realpath containment check.
		const linkPath = join(workDir, 'src', 'escape-link.ts');
		let linkable = true;
		try {
			symlinkSync(join(root, 'secret.txt'), linkPath);
		} catch {
			linkable = false; // Some environments disallow symlinks; skip if so.
		}
		if (!linkable) return;

		return executeTool('read_file', { path: 'src/escape-link.ts' }, ctx).then((res) => {
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toMatch(/escape|symlink|workspace/i);
			rmSync(linkPath, { force: true });
		});
	});

	it('no tool call writes or removes any file in the workspace', async () => {
		const before = listFiles(workDir);

		await fc.assert(
			fc.asyncProperty(
				fc.record({
					name: fc.constantFrom('read_file', 'graphify_affected', 'graphify_explain', 'graphify_query', 'write_file', 'exec'),
					arg: fc.string(),
				}),
				async ({ name, arg }) => {
					// Fire arbitrary calls across every tool name; none may mutate the FS.
					await executeTool(name, { path: arg, node: arg, question: arg, content: arg }, ctx);
				},
			),
			{ numRuns: 300 },
		);

		expect(listFiles(workDir)).toEqual(before);
	});
});

describe('verifier-tools: read_file range bound (R6.3)', () => {
	it('caps the returned span at READ_FILE_MAX_LINES even for a huge endLine', async () => {
		const res = await executeTool('read_file', { path: 'src/big.ts', startLine: 1, endLine: 100_000 }, ctx);
		expect(res.ok).toBe(true);
		if (!res.ok) return;

		const lines = res.result.split('\n');
		const [header, ...body] = lines;
		expect(header).toMatch(/^# lines 1-\d+ of \d+$/);
		// Body must contain at most READ_FILE_MAX_LINES numbered content lines.
		expect(body.length).toBeLessThanOrEqual(READ_FILE_MAX_LINES);
		expect(body.length).toBe(READ_FILE_MAX_LINES);
		expect(header).toContain(`1-${READ_FILE_MAX_LINES}`);
	});

	it('property: for any range, the returned body never exceeds READ_FILE_MAX_LINES', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: BIG_FILE_LINES + 50 }),
				fc.integer({ min: 1, max: 100_000 }),
				async (startLine, endLine) => {
					const res = await executeTool('read_file', { path: 'src/big.ts', startLine, endLine }, ctx);
					expect(res.ok).toBe(true);
					if (!res.ok) return;
					const body = res.result.split('\n').slice(1);
					expect(body.length).toBeLessThanOrEqual(READ_FILE_MAX_LINES);
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe('verifier-tools: stale location (R6.8)', () => {
	it('returns a STALE_LOCATION signal for a non-existent in-workspace path', async () => {
		const res = await executeTool('read_file', { path: 'src/does-not-exist.ts' }, ctx);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.result.startsWith(STALE_LOCATION_PREFIX)).toBe(true);
	});
});

describe('verifier-tools: graphify tool-error when graph missing (R9.3)', () => {
	it('graphify_affected returns a tool error mentioning the graph is unavailable', async () => {
		const res = await executeTool('graphify_affected', { node: 'someNode' }, ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/graph.*unavailable|unavailable|graph\.json/i);
	});

	it('graphify_explain returns a tool error when graph.json is missing', async () => {
		const res = await executeTool('graphify_explain', { node: 'someNode' }, ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/graph.*unavailable|unavailable|graph\.json/i);
	});

	it('graphify_query returns a tool error when graph.json is missing', async () => {
		const res = await executeTool('graphify_query', { question: 'what calls foo?' }, ctx);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/graph.*unavailable|unavailable|graph\.json/i);
	});
});
