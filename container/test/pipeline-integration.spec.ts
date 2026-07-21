import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Integration tests for the container review pipeline (Task 18).
 *
 * Two complementary parts:
 *
 *  Part A — full `runReviewPipeline` runs with a heavy mock set. These exercise
 *    the real Scheduler, real Triage finalization, and the real Consensus_Router
 *    while stubbing every network/git/LLM boundary. They validate:
 *      • Disabled-equivalence (Property 7, R9.2/R11.1): with ALL new flags OFF
 *        the new stages are inert (dependency-audit / consensus router / agentic
 *        verifier are NEVER invoked), the pre-feature path runs, and a review is
 *        posted.
 *      • Per-track behavior: fast skips graphify/personas/verify; full is gated
 *        by the dual-agent flag; deep forces personas.
 *      • Verifier replaces Stage 2 when on; Stage 2 runs when off (R6.7).
 *      • Degradation matrix (Property 6, R9.1/R9.3/R9.4): every degradation row
 *        still posts a review.
 *
 *  Part B — Scheduler-level matrix (`buildAgentSchedule`) assertions per track +
 *    breaker state. Robust, fast gating checks that back the same requirements.
 *
 * What is mocked: git-ops (clone/cleanup), github (fetch/classify/chunks/post),
 * github-auth token, static-analysis, ast-graph, KvProxy, stack-detector,
 * repo-config, previous-review, llm/index (chunk/synth), dual-agent
 * (Stage1/Stage2), agentic-verifier (verify), dependency-audit, smart-dedup,
 * graphify, usage-tracker, tracer, web-search, prompt composer.
 * Kept REAL: scheduler, triage-rules, consensus router, constants, retry
 * breakers, verdict/clusters/formatter/delta.
 */

// ---------------------------------------------------------------------------
// Module mocks (hoisted above imports by vitest)
// ---------------------------------------------------------------------------

vi.mock('../src/git-ops.js', () => ({
	cloneRepository: vi.fn(async () => undefined),
	cleanup: vi.fn(async () => undefined),
}));

vi.mock('../src/ast-graph.js', () => ({
	buildBlastRadius: vi.fn(async () => ({
		changedFiles: [],
		impactedFiles: [],
		changedSymbols: [],
		impactedSymbols: [],
	})),
	extractChangedSymbols: vi.fn(async () => []),
}));

vi.mock('../src/static-analysis.js', () => ({
	runStaticAnalysis: vi.fn(async () => []),
}));

vi.mock('../src/kv-proxy.js', () => ({
	KvProxy: class {
		async get() {
			return null;
		}
		async put() {
			return undefined;
		}
		async delete() {
			return undefined;
		}
		async list() {
			return { keys: [] };
		}
	},
}));

vi.mock('../src/lib/github-auth.js', () => ({
	getInstallationToken: vi.fn(async () => 'test-token'),
}));

vi.mock('../src/lib/github.js', () => ({
	fetchChangedFiles: vi.fn(async () => []),
	classifyFiles: vi.fn((files: any[]) => ({ tier1: files, tier2: [], skipped: [] })),
	buildReviewChunks: vi.fn(async (classified: any) => {
		const filenames = [...(classified.tier1 ?? []), ...(classified.tier2 ?? [])].map(
			(f: any) => f.filename,
		);
		return {
			chunks: ['/* chunk 1 */'],
			chunkFileMap: [filenames],
			globalContext: '',
			allFiles: filenames,
			pluginFindings: [],
		};
	}),
	postPRReview: vi.fn(async () => undefined),
	postPRComment: vi.fn(async () => undefined),
	updateCheckRun: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/stack-detector.js', () => ({
	detectTechStack: vi.fn(async () => ({ languages: [], frameworks: [] })),
}));

// Keep repo-config real (applyPipelineConfigOverrides / applyConfigOverrides /
// shouldIgnore are pure); only stub the network fetch to "no repo config".
vi.mock('../src/lib/repo-config.js', async (importActual) => {
	const actual = await importActual<typeof import('../src/lib/repo-config')>();
	return {
		...actual,
		fetchRepoConfig: vi.fn(async () => null),
	};
});

vi.mock('../src/lib/previous-review.js', () => ({
	fetchPreviousReviewFindings: vi.fn(async () => ({ findings: [] })),
	formatPreviousReviewContext: vi.fn(() => ''),
}));

vi.mock('../src/lib/llm/index.js', () => ({
	callChunkReview: vi.fn(async () => ({
		findings: [
			{
				issue: 'map issue',
				title: 'map finding',
				description: 'map issue',
				severity: 'medium',
				file: 'src/app.ts',
				line: 3,
				category: 'bug',
			},
		],
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
	})),
	callSynthesizer: vi.fn(async () => ({
		review: '## AI Review\n\nLooks fine.',
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
	})),
	getModelName: vi.fn(() => 'mock-model'),
}));

vi.mock('../src/lib/cliq.js', () => ({
	postToCliq: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/usage-tracker.js', () => ({
	buildPRUsageMetrics: vi.fn(() => ({})),
	storePRUsageMetrics: vi.fn(async () => undefined),
}));

// Keep the real tracer (SpanNames/SpanAttributes/startSpan are used across the
// pipeline and degrade to no-ops without OTEL env); only stub the network init.
vi.mock('../src/lib/observability/tracer.js', async (importActual) => {
	const actual = await importActual<typeof import('../src/lib/observability/tracer')>();
	return {
		...actual,
		initializeTracing: vi.fn(async () => undefined),
	};
});

vi.mock('../src/lib/llm/dual-agent.js', () => ({
	runStage1Review: vi.fn(async () => ({
		findings: [
			{
				issue: 'persona issue',
				title: 'persona finding',
				description: 'persona issue',
				severity: 'high',
				file: 'src/app.ts',
				line: 7,
				category: 'security',
			},
		],
		usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
		personaResults: [{ persona: 'security' }],
	})),
	runStage2Verification: vi.fn(async (findings: any[]) => ({
		verifiedFindings: findings,
		rejectedFindings: [],
		stats: { totalEvaluated: findings.length, verified: findings.length, rejected: 0 },
		usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
	})),
}));

vi.mock('../src/lib/smart-dedup.js', () => ({
	fetchPRCommentThreads: vi.fn(async () => []),
	applySmartDedup: vi.fn((findings: any[]) => ({
		findingsToPost: findings.map((f) => ({ finding: f, reason: 'post' })),
		suppressedInline: [],
		allUnresolved: findings,
	})),
}));

vi.mock('../src/lib/llm/agents/dependency-audit.js', () => ({
	runDependencyAudit: vi.fn(async () => []),
}));

vi.mock('../src/lib/llm/agentic-verifier.js', () => ({
	verify: vi.fn(async (ambiguous: any[]) => ({
		verifiedFindings: ambiguous.map(({ provenance, ...rest }: any) => rest),
		rejectedFindings: [],
		stats: { totalEvaluated: ambiguous.length, verified: ambiguous.length, rejected: 0, flips: 0 },
		usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
	})),
}));

vi.mock('../src/lib/graphify/index.js', () => ({
	run: vi.fn(async () => ({
		context: {
			render: () => '',
			available: true,
			reviewNotice: () => undefined,
		},
		telemetry: { degradationReason: undefined },
	})),
}));

vi.mock('../src/lib/graphify/extraction-runner.js', () => ({
	outParentFor: vi.fn((workDir: string) => `${workDir}-gfx`),
}));

vi.mock('../src/lib/web-search.js', () => ({
	shouldEnableWebSearch: vi.fn(() => false),
	getCachedSearchSources: vi.fn(async () => []),
	formatCachedSourcesContext: vi.fn(() => ''),
	formatSearchSources: vi.fn(() => ''),
	cacheSearchSources: vi.fn(async () => undefined),
}));

vi.mock('../src/config/prompts/composer.js', () => ({
	composeChunkPrompt: vi.fn(() => 'chunk-system-prompt'),
	composeSynthesizerPrompt: vi.fn(() => 'synth-system-prompt'),
}));

// Consensus router kept REAL but wrapped so call-counts are observable and a
// single route decision can be forced into the VERIFY band for verifier tests.
vi.mock('../src/lib/llm/consensus.js', async (importActual) => {
	const actual = await importActual<typeof import('../src/lib/llm/consensus')>();
	return {
		...actual,
		routeAll: vi.fn(actual.routeAll),
		mergeByIdentity: vi.fn(actual.mergeByIdentity),
		resolveFallback: vi.fn(actual.resolveFallback),
	};
});

// ---------------------------------------------------------------------------
// Imports (resolve to the mocked modules above)
// ---------------------------------------------------------------------------

import { runReviewPipeline } from '../src/pipeline';
import type { ReviewRequest } from '../src/types';
import * as github from '../src/lib/github';
import * as dualAgent from '../src/lib/llm/dual-agent';
import * as verifier from '../src/lib/llm/agentic-verifier';
import * as depAudit from '../src/lib/llm/agents/dependency-audit';
import * as consensus from '../src/lib/llm/consensus';
import * as repoConfig from '../src/lib/repo-config';
import * as graphify from '../src/lib/graphify';
import { buildAgentSchedule } from '../src/lib/llm/scheduler';
import { circuitBreakers } from '../src/lib/retry';
import type { Env } from '../src/types/env';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PRFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
}

const FILES: Record<'fast' | 'full' | 'deep', PRFile[]> = {
	// All-docs + small → triage assigns `fast`.
	fast: [{ filename: 'README.md', status: 'modified', additions: 2, deletions: 0, changes: 2, patch: '@@ -1 +1 @@\n+docs' }],
	// A code file → triage assigns `full` (reason: default).
	full: [{ filename: 'src/app.ts', status: 'modified', additions: 5, deletions: 1, changes: 6, patch: '@@ -1 +1,5 @@\n+code' }],
	// Security-sensitive path → triage assigns `deep` (floor).
	deep: [{ filename: 'src/auth/login.ts', status: 'modified', additions: 5, deletions: 1, changes: 6, patch: '@@ -1 +1,5 @@\n+code' }],
};

function makeRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
	return {
		repoFullName: 'acme/widgets',
		prNumber: 42,
		headSha: 'abc123',
		title: 'Improve widget rendering',
		prAuthor: 'octocat',
		allowedFiles: [],
		// checkRunId intentionally omitted so the internal CheckRun heartbeat
		// (which calls global fetch) short-circuits and performs no network I/O.
		...overrides,
	};
}

// Breaker getter spies are tracked so they are ALWAYS restored in afterEach,
// even if a test throws before its inline restore — preventing state leakage
// into later tests (the global circuit breakers are module singletons).
const activeSpies: Array<{ mockRestore: () => void }> = [];
function openBreaker(breaker: { isOpen: boolean }): void {
	const spy = vi.spyOn(breaker, 'isOpen', 'get').mockReturnValue(true);
	activeSpies.push(spy);
}

const NEW_FLAGS = [
	'ENABLE_TRIAGE',
	'ENABLE_DUAL_AGENT',
	'ENABLE_DEPENDENCY_AUDIT',
	'ENABLE_CONSENSUS',
	'ENABLE_AGENTIC_VERIFIER',
] as const;

function setFiles(track: 'fast' | 'full' | 'deep'): void {
	vi.mocked(github.fetchChangedFiles).mockResolvedValue(FILES[track] as any);
}

beforeEach(() => {
	// clearAllMocks resets call history but PRESERVES the implementations set in
	// the vi.mock factories above (including the real-delegating consensus spies).
	// We deliberately avoid resetAllMocks/restoreAllMocks, which would wipe those
	// factory implementations for subsequent tests.
	vi.clearAllMocks();
	// Required env for validateEnvironment().
	process.env.GITHUB_APP_ID = 'app-id';
	process.env.GITHUB_APP_PRIVATE_KEY = 'pk';
	process.env.GITHUB_APP_INSTALLATION_ID = 'inst';
	process.env.GITHUB_WEBHOOK_SECRET = 'secret';
	process.env.ANTHROPIC_API_KEY = 'anthropic-key';
	process.env.AI_PROVIDER = 'claude';
	// All new feature flags OFF by default.
	for (const f of NEW_FLAGS) delete process.env[f];
});

afterEach(() => {
	for (const f of NEW_FLAGS) delete process.env[f];
	while (activeSpies.length) activeSpies.pop()!.mockRestore();
});

// ===========================================================================
// Part A — full pipeline runs
// ===========================================================================

describe('pipeline integration — disabled-equivalence (Property 7, R9.2/R11.1)', () => {
	it('with ALL new flags OFF (full track): new stages are inert and a review is posted', async () => {
		setFiles('full');
		// All flags unset (default).

		const res = await runReviewPipeline(makeRequest(), 'req-1');

		// New stages NEVER invoked.
		expect(depAudit.runDependencyAudit).not.toHaveBeenCalled();
		expect(consensus.routeAll).not.toHaveBeenCalled();
		expect(verifier.verify).not.toHaveBeenCalled();
		// Pre-feature dual-agent path is off for a plain `full` PR (no deepReview,
		// no ENABLE_DUAL_AGENT) → Stage 2 does not run either; MAP posts directly.
		expect(dualAgent.runStage2Verification).not.toHaveBeenCalled();
		expect(dualAgent.runStage1Review).not.toHaveBeenCalled();
		// graphify runs on the full track (pre-feature always-on behavior).
		expect(graphify.run).toHaveBeenCalledTimes(1);
		// A review is posted.
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
		// Returns a valid ReviewResponse.
		expect(res).toBeDefined();
		expect(res.metrics).toBeDefined();
	});

	it('with ALL new flags OFF (fast track): graphify/personas/verify are skipped and a review is posted', async () => {
		setFiles('fast');
		process.env.ENABLE_TRIAGE = 'true'; // needed so the container finalizes to `fast`

		await runReviewPipeline(makeRequest(), 'req-fast');

		// Fast track skips graphify + personas + consensus + verify entirely.
		expect(graphify.run).not.toHaveBeenCalled();
		expect(dualAgent.runStage1Review).not.toHaveBeenCalled();
		expect(dualAgent.runStage2Verification).not.toHaveBeenCalled();
		expect(consensus.routeAll).not.toHaveBeenCalled();
		expect(verifier.verify).not.toHaveBeenCalled();
		// Static + MAP still post.
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('deep track forces personas on (Stage 1 runs) even with new flags OFF', async () => {
		setFiles('deep');
		process.env.ENABLE_TRIAGE = 'true'; // finalize to `deep` via the security path

		await runReviewPipeline(makeRequest(), 'req-deep');

		// deep forces the dual-agent (persona) path.
		expect(dualAgent.runStage1Review).toHaveBeenCalledTimes(1);
		// Consensus off → the original single-shot Stage 2 runs (not the verifier).
		expect(dualAgent.runStage2Verification).toHaveBeenCalledTimes(1);
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(consensus.routeAll).not.toHaveBeenCalled();
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});
});

describe('pipeline integration — verifier replaces Stage 2 when ON (R6.7)', () => {
	it('consensus + verifier ON: Stage 2 is NOT run and the agentic verifier IS invoked', async () => {
		setFiles('full');
		process.env.ENABLE_DUAL_AGENT = 'true'; // persona path on `full`
		process.env.ENABLE_CONSENSUS = 'true';
		process.env.ENABLE_AGENTIC_VERIFIER = 'true';

		// Force one persona finding into the VERIFY band so the verifier is exercised
		// (default persona tagging scores 0.90 → KEEP, so we override the route once).
		vi.mocked(consensus.routeAll).mockImplementationOnce((findings) => ({
			keep: [],
			downgraded: [],
			toVerify: findings,
			suppressedCount: 0,
		}));

		await runReviewPipeline(makeRequest(), 'req-verify');

		expect(consensus.routeAll).toHaveBeenCalledTimes(1);
		// Verifier REPLACES Stage 2 (R6.7).
		expect(dualAgent.runStage2Verification).not.toHaveBeenCalled();
		expect(verifier.verify).toHaveBeenCalledTimes(1);
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('consensus + verifier OFF (dual-agent ON): Stage 2 runs and the verifier is NOT invoked', async () => {
		setFiles('full');
		process.env.ENABLE_DUAL_AGENT = 'true';
		// consensus + verifier stay OFF.

		await runReviewPipeline(makeRequest(), 'req-stage2');

		expect(dualAgent.runStage1Review).toHaveBeenCalledTimes(1);
		expect(dualAgent.runStage2Verification).toHaveBeenCalledTimes(1);
		expect(verifier.verify).not.toHaveBeenCalled();
		expect(consensus.routeAll).not.toHaveBeenCalled();
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});
});

describe('pipeline integration — repo-config enableTriage override (R11.3)', () => {
	it('repo pipeline.enableTriage:true finalizes the track even when ENABLE_TRIAGE env is unset', async () => {
		setFiles('fast');
		// ENABLE_TRIAGE env intentionally UNSET; the repo `.codereview.yml` forces
		// triage ON via `pipeline.enableTriage`, so the container must finalize the
		// track (an all-docs PR → `fast`) instead of defaulting to `full`.
		vi.mocked(repoConfig.fetchRepoConfig).mockResolvedValueOnce({
			pipeline: { enableTriage: true },
		} as any);

		await runReviewPipeline(makeRequest(), 'req-repo-triage-on');

		// Triage finalized to `fast`, which skips graphify + personas.
		expect(graphify.run).not.toHaveBeenCalled();
		expect(dualAgent.runStage1Review).not.toHaveBeenCalled();
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('with triage neither enabled by env nor repo config, an all-docs PR stays on the default full track', async () => {
		setFiles('fast');
		// No repo override and ENABLE_TRIAGE unset → triage disabled → track defaults
		// to `full`, so graphify runs (pre-feature always-on behavior). This is the
		// contrast case proving the repo override above actually drove finalization.
		await runReviewPipeline(makeRequest(), 'req-repo-triage-off');

		expect(graphify.run).toHaveBeenCalledTimes(1);
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});
});

describe('pipeline integration — dependency audit gating (R3.5)', () => {
	it('runs the dependency audit when its flag is ON', async () => {
		setFiles('full');
		process.env.ENABLE_DEPENDENCY_AUDIT = 'true';

		await runReviewPipeline(makeRequest(), 'req-dep-on');

		expect(depAudit.runDependencyAudit).toHaveBeenCalledTimes(1);
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('does NOT run the dependency audit when its flag is OFF', async () => {
		setFiles('full');

		await runReviewPipeline(makeRequest(), 'req-dep-off');

		expect(depAudit.runDependencyAudit).not.toHaveBeenCalled();
	});
});

describe('pipeline integration — degradation matrix (Property 6, R9.1/R9.3/R9.4)', () => {
	it('flags off → posts a review', async () => {
		setFiles('full');
		await runReviewPipeline(makeRequest(), 'deg-off');
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('consensus ON + verifier OFF → Fallback_Decision, still posts (R5.6)', async () => {
		setFiles('full');
		process.env.ENABLE_DUAL_AGENT = 'true';
		process.env.ENABLE_CONSENSUS = 'true';
		// verifier OFF
		vi.mocked(consensus.routeAll).mockImplementationOnce((findings) => ({
			keep: [],
			downgraded: [],
			toVerify: findings,
			suppressedCount: 0,
		}));

		await runReviewPipeline(makeRequest(), 'deg-fallback');

		expect(verifier.verify).not.toHaveBeenCalled();
		expect(consensus.resolveFallback).toHaveBeenCalled();
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('verifier ON but throws → stage caught, active set kept, still posts (R9.4)', async () => {
		setFiles('full');
		process.env.ENABLE_DUAL_AGENT = 'true';
		process.env.ENABLE_CONSENSUS = 'true';
		process.env.ENABLE_AGENTIC_VERIFIER = 'true';
		vi.mocked(consensus.routeAll).mockImplementationOnce((findings) => ({
			keep: [],
			downgraded: [],
			toVerify: findings,
			suppressedCount: 0,
		}));
		vi.mocked(verifier.verify).mockRejectedValueOnce(new Error('verifier boom'));

		await runReviewPipeline(makeRequest(), 'deg-verify-throw');

		expect(verifier.verify).toHaveBeenCalledTimes(1);
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('dependency audit throws → caught, still posts (R9.4)', async () => {
		setFiles('full');
		process.env.ENABLE_DEPENDENCY_AUDIT = 'true';
		vi.mocked(depAudit.runDependencyAudit).mockRejectedValueOnce(new Error('audit boom'));

		await runReviewPipeline(makeRequest(), 'deg-dep-throw');

		expect(depAudit.runDependencyAudit).toHaveBeenCalledTimes(1);
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('graphify graph unavailable → tree-sitter fallback, still posts (R9.3)', async () => {
		setFiles('full');
		vi.mocked(graphify.run).mockResolvedValueOnce({
			context: { render: () => '', available: false, reviewNotice: () => 'graph unavailable' },
			telemetry: { degradationReason: 'missing-key' },
		} as any);

		await runReviewPipeline(makeRequest(), 'deg-graph');

		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('cost/circuit breaker open (synth) disables the verifier → Fallback, still posts (R7.3)', async () => {
		setFiles('full');
		process.env.ENABLE_DUAL_AGENT = 'true';
		process.env.ENABLE_CONSENSUS = 'true';
		process.env.ENABLE_AGENTIC_VERIFIER = 'true';
		// Open the synthesis-provider breaker → schedule.verifierEnabled becomes false.
		openBreaker(circuitBreakers.anthropicSynth);
		vi.mocked(consensus.routeAll).mockImplementationOnce((findings) => ({
			keep: [],
			downgraded: [],
			toVerify: findings,
			suppressedCount: 0,
		}));

		await runReviewPipeline(makeRequest(), 'deg-breaker');

		expect(verifier.verify).not.toHaveBeenCalled();
		expect(github.postPRReview).toHaveBeenCalledTimes(1);
	});

	it('postPRReview fails → falls back to an issue comment (still posts)', async () => {
		setFiles('full');
		vi.mocked(github.postPRReview).mockRejectedValueOnce(new Error('reviews API 500'));

		await runReviewPipeline(makeRequest(), 'deg-post');

		expect(github.postPRReview).toHaveBeenCalledTimes(1);
		expect(github.postPRComment).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// Part B — Scheduler-level matrix (buildAgentSchedule)
// ===========================================================================

function schedEnv(overrides: Partial<Env> = {}): Env {
	return {
		AI_PROVIDER: 'claude',
		ANTHROPIC_API_KEY: 'k',
		...overrides,
	} as unknown as Env;
}

describe('scheduler matrix — per-track gating (R2)', () => {
	it('fast disables graphify / stage1 / consensus / verify', () => {
		const s = buildAgentSchedule('fast', schedEnv({ ENABLE_CONSENSUS: 'true', ENABLE_AGENTIC_VERIFIER: 'true', ENABLE_DUAL_AGENT: 'true' }));
		expect(s.phases.graphify.enabled).toBe(false);
		expect(s.phases.stage1.enabled).toBe(false);
		expect(s.consensusEnabled).toBe(false);
		expect(s.verifierEnabled).toBe(false);
		expect(s.phases.stage2.enabled).toBe(false);
	});

	it('deep enables personas + all phases with the largest budgets', () => {
		const deep = buildAgentSchedule('deep', schedEnv());
		const fast = buildAgentSchedule('fast', schedEnv());
		expect(deep.personasEnabled).toBe(true);
		expect(deep.phases.graphify.enabled).toBe(true);
		expect(deep.phases.stage1.enabled).toBe(true);
		// deep budgets are the largest of the tracks.
		expect(deep.budgets.stageTokenBudget).toBeGreaterThan(fast.budgets.stageTokenBudget);
	});

	it('full: personas gated by the dual-agent flag (schedule-wins-over-flag, R2.7/R2.8)', () => {
		const off = buildAgentSchedule('full', schedEnv({ ENABLE_DUAL_AGENT: 'false' }));
		const on = buildAgentSchedule('full', schedEnv({ ENABLE_DUAL_AGENT: 'true' }));
		expect(off.personasEnabled).toBe(false);
		expect(on.personasEnabled).toBe(true);
	});

	it('full: consensus + verifier follow their flags', () => {
		const on = buildAgentSchedule(
			'full',
			schedEnv({ ENABLE_CONSENSUS: 'true', ENABLE_AGENTIC_VERIFIER: 'true' }),
		);
		expect(on.consensusEnabled).toBe(true);
		expect(on.verifierEnabled).toBe(true);
		const off = buildAgentSchedule('full', schedEnv());
		expect(off.consensusEnabled).toBe(false);
		expect(off.verifierEnabled).toBe(false);
	});
});

describe('scheduler matrix — breaker-aware disabling (R2.4)', () => {
	it('open map breaker disables graphify + stage1 even when flags are on', () => {
		openBreaker(circuitBreakers.anthropicMap);
		const s = buildAgentSchedule('deep', schedEnv({ ENABLE_DUAL_AGENT: 'true' }));
		expect(s.phases.graphify.enabled).toBe(false);
		expect(s.phases.stage1.enabled).toBe(false);
		expect(s.personasEnabled).toBe(false);
	});

	it('open synth breaker disables the verifier (flag on cannot re-enable it, R2.8)', () => {
		openBreaker(circuitBreakers.anthropicSynth);
		const s = buildAgentSchedule('full', schedEnv({ ENABLE_AGENTIC_VERIFIER: 'true' }));
		expect(s.verifierEnabled).toBe(false);
	});

	it('open dependency-audit breaker disables the dependency-audit phase', () => {
		openBreaker(circuitBreakers.dependencyAudit);
		const s = buildAgentSchedule('full', schedEnv({ ENABLE_DEPENDENCY_AUDIT: 'true' }));
		expect(s.phases['dependency-audit'].enabled).toBe(false);
	});
});
