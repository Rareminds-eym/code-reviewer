import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(), rmSync: vi.fn() }));

import { execa } from 'execa';
import { existsSync, rmSync } from 'node:fs';
import {
	ensureGraph,
	outParentFor,
	semanticGraphDirFor,
	codeOnlyGraphDirFor,
} from '../../src/lib/graphify/extraction-runner.js';

const mockedExeca = vi.mocked(execa);
const mockedExists = vi.mocked(existsSync);
const mockedRm = vi.mocked(rmSync);

const WORKDIR = '/tmp/review-abc';
const CODE_DIR = codeOnlyGraphDirFor(WORKDIR); // <workDir>/graphify-out  (update, in-repo)
const SEM_DIR = semanticGraphDirFor(WORKDIR); // <workDir>-gfx/graphify-out (extract --out)
const OUTPARENT = outParentFor(WORKDIR); // <workDir>-gfx

describe('ExtractionRunner.ensureGraph — default code-only (update) path', () => {
	beforeEach(() => {
		mockedExeca.mockReset();
		mockedExists.mockReset();
		mockedRm.mockReset();
	});

	it('uses `graphify update <workDir>` (no key, docs-safe) with no backend', async () => {
		mockedExists.mockReturnValue(true);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, { GEMINI_API_KEY: 'k' });
		const [, args] = mockedExeca.mock.calls[0];
		// `update` (not `extract`), and NEVER a `--backend` on the default path,
		// even when a key is present — the default is code-only.
		expect(args).toEqual(['update', WORKDIR]);
		expect(args).not.toContain('--backend');
		expect(out.mode).toBe('full'); // clean rebuild each run
		expect(out.ok).toBe(true);
	});

	it('reads/returns the IN-REPO graph dir and never targets the out-of-repo parent', async () => {
		mockedExists.mockReturnValue(true);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, {});
		expect(out.graphDir).toBe(CODE_DIR);
		expect(out.graphDir).toBe(`${WORKDIR}/graphify-out`);
	});

	it('deletes any pre-existing (committed/stale) graphify-out before update (R3.8b)', async () => {
		mockedExists.mockReturnValue(true);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		await ensureGraph(WORKDIR, undefined, 120000, {});
		expect(mockedRm).toHaveBeenCalledWith(CODE_DIR, { recursive: true, force: true });
	});

	it('timeout/abort → timeout degradation', async () => {
		mockedExists.mockReturnValue(false);
		mockedExeca.mockRejectedValue(Object.assign(new Error('timed out'), { timedOut: true }));
		const out = await ensureGraph(WORKDIR, undefined, 120000, {});
		expect(out.ok).toBe(false);
		expect(out.degradationReason).toBe('timeout');
	});

	it('does NOT salvage/misreport missing-key on the code-only path', async () => {
		// `update` never emits the missing-key error, but even if a non-zero exit
		// mentioned it, the default path must not classify it as missing-key.
		mockedExists.mockReturnValue(false);
		mockedExeca.mockResolvedValue({
			exitCode: 1,
			stderr: 'no LLM API key found',
		} as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, {});
		expect(out.degradationReason).toBe('unexpected-error');
	});
});

describe('ExtractionRunner.ensureGraph — semantic opt-in (extract --out) path', () => {
	beforeEach(() => {
		mockedExeca.mockReset();
		mockedExists.mockReset();
		mockedRm.mockReset();
	});

	it('uses `extract --out <parent> --backend gemini` when opted in with a key', async () => {
		mockedExists.mockReturnValue(false);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, {
			GRAPHIFY_SEMANTIC_DOCS: '1',
			GEMINI_API_KEY: 'k',
		});
		const [, args] = mockedExeca.mock.calls[0];
		expect(args).toEqual(['extract', WORKDIR, '--out', OUTPARENT, '--backend', 'gemini']);
		// out-of-repo nested graphify-out dir.
		expect(out.graphDir).toBe(SEM_DIR);
		expect(out.graphDir).toBe(`${OUTPARENT}/graphify-out`);
		// no in-repo deletion on the semantic path.
		expect(mockedRm).not.toHaveBeenCalled();
	});

	it('opt-in WITHOUT a key falls back to the code-only update path', async () => {
		mockedExists.mockReturnValue(false);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		await ensureGraph(WORKDIR, undefined, 120000, { GRAPHIFY_SEMANTIC_DOCS: '1' });
		const [, args] = mockedExeca.mock.calls[0];
		expect(args).toEqual(['update', WORKDIR]); // no key → code-only
	});

	it('reports incremental when a prior out-of-repo graph exists (extract cache reuse)', async () => {
		mockedExists.mockReturnValue(true);
		mockedExeca.mockResolvedValue({ exitCode: 0 } as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, {
			GRAPHIFY_SEMANTIC_DOCS: '1',
			ANTHROPIC_API_KEY: 'k',
		});
		expect(out.mode).toBe('incremental');
		const [, args] = mockedExeca.mock.calls[0];
		expect(args).toContain('claude');
	});

	it('missing-key non-zero exit → missing-key, salvages a code-only graph', async () => {
		// existsSync used only for the salvage check here → graph was written.
		mockedExists.mockReturnValue(true);
		mockedExeca.mockResolvedValue({
			exitCode: 1,
			stderr: 'error: no LLM API key found (8 doc files need semantic extraction)',
		} as never);
		const out = await ensureGraph(WORKDIR, undefined, 120000, {
			GRAPHIFY_SEMANTIC_DOCS: '1',
			GEMINI_API_KEY: 'k',
		});
		expect(out.degradationReason).toBe('missing-key');
		expect(out.ok).toBe(true); // salvaged code-only graph
	});
});
