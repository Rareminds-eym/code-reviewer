/**
 * ExtractionRunner — invokes the graphify CLI to produce/update the graph.
 *
 * Key decisions (see design.md R3/R9), all VERIFIED against graphify 0.9.5:
 *
 * - DEFAULT (code-only, no key): `graphify update <workDir>`.
 *   VERIFIED: `graphify extract` HARD-FAILS (exit 1, writes NO graph.json) as
 *   soon as the repo contains any doc/paper/image file and no LLM key is set —
 *   which is nearly every real repo (they all have a README). `graphify update`
 *   is the documented headless, no-LLM, code-only path: it re-extracts code
 *   files and produces a graph EVEN when docs are present and no key is set.
 *   It writes IN-REPO to `<workDir>/graphify-out` (it does not accept `--out`),
 *   so we first delete any pre-existing (possibly committed/stale/foreign)
 *   `<workDir>/graphify-out` to guarantee we never update against a foreign
 *   graph and always build a clean one for THIS clone (R3.8b). The clone is a
 *   throwaway sandbox and is removed wholesale in the pipeline's cleanup, so the
 *   in-repo output is cleaned automatically.
 *   NOTE: `update` emits no `.graphify_analysis.json` sidecar; the GraphParser
 *   derives god nodes from the graph's own `links` in that case.
 *
 * - SEMANTIC OPT-IN (`GRAPHIFY_SEMANTIC_DOCS=1` AND a key present):
 *   `graphify extract <workDir> --out <parent> --backend <b>` — the only path
 *   that semantically extracts docs. It accepts `--out`, so it writes OUTSIDE
 *   the repo to `<workDir>-gfx/graphify-out` (collision-safe, and it produces
 *   the sidecar). A backend is added ONLY here (offline/free by default).
 *
 * Directionality is obtained at query time from `affected`'s reverse traversal
 * (R11.1); no build-time direction flag is used. Never throws.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ExtractionOutcome } from './types.js';

/** The out-of-repo parent dir we pass to `--out` on the semantic path. */
export function outParentFor(workDir: string): string {
	return `${workDir}-gfx`;
}

/**
 * Graph dir for the SEMANTIC path: `graphify extract --out <parent>` writes to
 * `<parent>/graphify-out`, so the parser/query read that nested path.
 */
export function semanticGraphDirFor(workDir: string): string {
	return join(outParentFor(workDir), 'graphify-out');
}

/** Graph dir for the DEFAULT code-only path: in-repo `<workDir>/graphify-out`. */
export function codeOnlyGraphDirFor(workDir: string): string {
	return join(workDir, 'graphify-out');
}

/**
 * Choose a semantic backend, or `null` for the code-only default.
 * Only opts in when `GRAPHIFY_SEMANTIC_DOCS=1` AND a matching key is present.
 */
function selectBackend(env: NodeJS.ProcessEnv): 'gemini' | 'claude' | null {
	if (env.GRAPHIFY_SEMANTIC_DOCS !== '1') return null; // default: code-only
	if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini';
	if (env.ANTHROPIC_API_KEY) return 'claude';
	return null; // opted in but no key → still code-only (R9.3)
}

function looksLikeMissingKey(stderr: string | undefined): boolean {
	return !!stderr && /no LLM API key found/i.test(stderr);
}

function isAbortOrTimeout(x: unknown): boolean {
	const e = x as { timedOut?: boolean; isCanceled?: boolean; killed?: boolean };
	return !!(e?.timedOut || e?.isCanceled || e?.killed);
}

/**
 * Run one graphify invocation and classify the outcome. Never throws.
 *
 * @param allowMissingKeySalvage only the semantic (`extract`) path can hit the
 *   "no LLM API key" error; when it does we salvage any code-only graph written.
 */
async function runGraphify(
	args: string[],
	cwd: string,
	graphDir: string,
	mode: 'full' | 'incremental',
	budgetMs: number,
	signal: AbortSignal | undefined,
	env: NodeJS.ProcessEnv,
	start: number,
	allowMissingKeySalvage: boolean
): Promise<ExtractionOutcome> {
	try {
		const result = await execa('graphify', args, {
			cwd,
			timeout: budgetMs,
			cancelSignal: signal,
			reject: false,
			env,
		});
		const durationMs = Date.now() - start;

		// Success within budget → use this graph immediately (R3.6).
		if (result.exitCode === 0) {
			return { ok: true, mode, graphDir, durationMs };
		}

		// Timeout / abort. With reject:false, execa resolves rather than throwing,
		// so classify from the result flags (and the signal) here (R3.4).
		if (isAbortOrTimeout(result) || signal?.aborted) {
			return { ok: false, mode, graphDir, durationMs, degradationReason: 'timeout' };
		}

		// Semantic path only: docs needed a key we don't have. Keep any code-only
		// graph that was still written (R4.1).
		if (allowMissingKeySalvage && looksLikeMissingKey(result.stderr)) {
			const salvaged = existsSync(join(graphDir, 'graph.json'));
			return { ok: salvaged, mode, graphDir, durationMs, degradationReason: 'missing-key' };
		}

		// Any other non-zero exit. If nothing was produced, report mode 'none'.
		const produced = existsSync(join(graphDir, 'graph.json'));
		return {
			ok: false,
			mode: produced ? mode : 'none',
			graphDir,
			durationMs,
			degradationReason: 'unexpected-error',
		};
	} catch (err) {
		// Final safety net — runGraphify never throws.
		const durationMs = Date.now() - start;
		const produced = existsSync(join(graphDir, 'graph.json'));
		return {
			ok: false,
			mode: produced ? mode : 'none',
			graphDir,
			durationMs,
			degradationReason: isAbortOrTimeout(err) ? 'timeout' : 'unexpected-error',
		};
	}
}

/**
 * Ensure a graph exists for the clone at `workDir`, within `budgetMs`.
 * Never throws; returns an ExtractionOutcome describing what happened.
 */
export async function ensureGraph(
	workDir: string,
	signal: AbortSignal | undefined,
	budgetMs: number,
	env: NodeJS.ProcessEnv = process.env
): Promise<ExtractionOutcome> {
	const start = Date.now();
	const backend = selectBackend(env);

	if (backend) {
		// ── Semantic opt-in path: extract --out (out-of-repo) with a backend. ──
		const outParent = outParentFor(workDir);
		const graphDir = semanticGraphDirFor(workDir);
		// `extract` reuses its manifest cache in the out dir → incremental when a
		// prior (our own) graph exists (telemetry only; command is the same).
		const mode: 'full' | 'incremental' = existsSync(join(graphDir, 'graph.json'))
			? 'incremental'
			: 'full';
		const args = ['extract', workDir, '--out', outParent, '--backend', backend];
		return runGraphify(args, workDir, graphDir, mode, budgetMs, signal, env, start, true);
	}

	// ── Default code-only path: `graphify update` (no key, docs-safe). ──
	// Writes in-repo; delete any pre-existing graphify-out first so we never
	// update against a committed/stale/foreign graph and always rebuild clean
	// for this clone (R3.8b).
	const graphDir = codeOnlyGraphDirFor(workDir);
	try {
		rmSync(graphDir, { recursive: true, force: true });
	} catch {
		/* best-effort; a leftover graph would only be overwritten by update */
	}
	// A clean rebuild each run → always 'full' (the incremental cache lived in
	// the graphify-out we just removed for safety).
	const args = ['update', workDir];
	return runGraphify(args, workDir, graphDir, 'full', budgetMs, signal, env, start, false);
}
