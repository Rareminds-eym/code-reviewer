import { v4 as uuidv4 } from 'uuid';

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cloneRepository, cleanup } from './git-ops.js';
import { buildBlastRadius, extractChangedSymbols } from './ast-graph.js';
import { runStaticAnalysis } from './static-analysis.js';
import type { ReviewRequest, ReviewResponse, ReviewMetrics, BlastRadius } from './types.js';
import { KvProxy } from './kv-proxy.js';
import { getInstallationToken } from './lib/github-auth.js';
import {
	fetchChangedFiles,
	classifyFiles,
	buildReviewChunks,
	postPRReview,
	postPRComment,
	updateCheckRun,
} from './lib/github.js';
import { detectTechStack } from './lib/stack-detector.js';
import { fetchRepoConfig, buildCustomRulesPrompt, applyConfigOverrides, shouldIgnore, applyPipelineConfigOverrides } from './lib/repo-config.js';
import type { RepoReviewConfig } from './lib/repo-config.js';
import {
	fetchPreviousReviewFindings,
	formatPreviousReviewContext,
} from './lib/previous-review.js';
import { filterPreviouslyRaisedFindings } from './lib/review-delta.js';
import {
	clusterFindings,
} from './lib/finding-clusters.js';
import { formatFindingsAsMarkdown } from './lib/review-formatter.js';
import { deriveVerdict, verdictToConclusion, countBySeverity } from './lib/verdict.js';
import { callChunkReview, callSynthesizer, getModelName } from './lib/llm/index.js';
import { postToCliq } from './lib/cliq.js';
import { buildPRUsageMetrics, storePRUsageMetrics } from './lib/usage-tracker.js';
import { initializeTracing, startSpan, withSpan, SpanNames, SpanAttributes } from './lib/observability/tracer.js';
import { runStage1Review, runStage2Verification } from './lib/llm/dual-agent.js';
import type { PersonaTaggedFinding } from './lib/llm/dual-agent.js';
import { fetchPRCommentThreads, applySmartDedup } from './lib/smart-dedup.js';
import { buildAgentSchedule } from './lib/llm/scheduler.js';
import type { AgentSchedule } from './lib/llm/scheduler.js';
import { runDependencyAudit } from './lib/llm/agents/dependency-audit.js';
import { triagePR, DEFAULT_TRIAGE_CONFIG } from './lib/triage-rules.js';
import type { ReviewTrack } from './types/env.js';
import type { ProvenancedFinding, AgentSource } from './lib/llm/consensus.js';
import { mergeByIdentity, routeAll, resolveFallback, DEFAULT_CONSENSUS_CONFIG } from './lib/llm/consensus.js';
import { verify as verifyFindings } from './lib/llm/agentic-verifier.js';
import type { VerifierResult } from './lib/llm/agentic-verifier.js';
import {
	DEFAULT_AI_PROVIDER,
	MAX_CHUNK_CHARS,
	MAX_GRAPH_CONTEXT_CHARS,
	GRAPHIFY_BUDGET_MS,
} from './config/constants.js';
import * as graphifyIntegration from './lib/graphify/index.js';
import type { GraphifyResult } from './lib/graphify/index.js';
import { outParentFor as graphifyOutParentFor } from './lib/graphify/extraction-runner.js';
import type { Env } from './types/env.js';
import type { LLMCallUsage } from './types/usage.js';
import type { InlineReviewComment } from './lib/github.js';
import type { WebSearchMetadata } from './lib/web-search.js';
import {
	shouldEnableWebSearch,
	getCachedSearchSources,
	formatCachedSourcesContext,
	formatSearchSources,
	cacheSearchSources,
} from './lib/web-search.js';
import { composeChunkPrompt, composeSynthesizerPrompt } from './config/prompts/composer.js';
import type { ReviewFinding } from './types/review.js';

const LLM_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Validates critical environment variables.
 * Raises errors for missing required variables, and warnings for optional ones (Task 3j / request 5).
 */
function validateEnvironment(): void {
	const required = [
		'GITHUB_APP_ID',
		'GITHUB_APP_PRIVATE_KEY',
		'GITHUB_APP_INSTALLATION_ID',
		'GITHUB_WEBHOOK_SECRET',
	];

	const missingRequired = required.filter((k) => !process.env[k]);
	if (missingRequired.length > 0) {
		throw new Error(
			`[ReviewContainer] Critical startup configuration failure. Missing required environment variables: ${missingRequired.join(', ')}`
		);
	}

	const optional = [
		'ANTHROPIC_API_KEY',
		'GEMINI_API_KEY',
		'CLIQ_CLIENT_ID',
		'CLIQ_CLIENT_SECRET',
		'CLIQ_REFRESH_TOKEN',
		'CLIQ_BOT_NAME',
		'CLIQ_CHANNEL_ID',
		'HONEYCOMB_API_KEY',
		'OTEL_EXPORTER_URL',
	];

	const missingOptional = optional.filter((k) => !process.env[k]);
	if (missingOptional.length > 0) {
		console.warn(`[ReviewContainer] Optional configuration fields not set: ${missingOptional.join(', ')}`);
	}

	if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
		console.warn('⚠️ WARNING: Both ANTHROPIC_API_KEY and GEMINI_API_KEY are missing. AI reviews will fail!');
	}
}

/**
 * Updates the progress of the GitHub Check Run symmetrically mirroring the container's execution state.
 */
async function updateCheckRunProgress(
	repoFullName: string,
	checkRunId: number | undefined,
	token: string,
	summary: string
): Promise<void> {
	if (!checkRunId) return;

	try {
		console.log(`[CheckRun] Updating progress: ${summary}`);
		const res = await fetch(`https://api.github.com/repos/${repoFullName}/check-runs/${checkRunId}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'code-reviewer-container/1.0',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'AI Code Reviewer',
				status: 'in_progress',
				output: {
					title: 'Live Review Progress',
					summary,
				},
			}),
		});
		if (!res.ok) console.warn(`[CheckRun] Failed to update progress, status: ${res.status}`);
	} catch (err) {
		console.warn(`[CheckRun] Failed to update progress:`, err);
	}
}

/**
 * Local helper to deduplicate findings based on composite keys.
 */
function deduplicateFindings(findings: ReviewFinding[]): ReviewFinding[] {
	const seen = new Set<string>();
	const deduplicated: ReviewFinding[] = [];
	for (const f of findings) {
		const normalizedTitle = f.title.toLowerCase().trim().replace(/\s+/g, ' ');
		const key = `${f.file}::${normalizedTitle}::${f.line ?? ''}`;
		if (!seen.has(key)) {
			seen.add(key);
			deduplicated.push(f);
		}
	}
	return deduplicated;
}

/**
 * Attach LLM Provenance to the Active_Finding_Set (R4.1). These are the MAP
 * chunk findings (source `map-chunk`) or the Stage-1 persona findings that the
 * Consensus_Router / Agentic_Verifier operate on in Task 16.
 *
 * NOTE: the MAP path tags findings with a single `map-chunk` source. The
 * Stage-1 persona path uses `attachPersonaProvenance` instead, which preserves
 * each finding's real per-persona attribution (architect/sre/security).
 */
function attachLLMProvenance(
	findings: ReviewFinding[],
	sources: AgentSource[],
	stage2Verified: boolean,
): ProvenancedFinding[] {
	return findings.map((f) => ({
		...f,
		provenance: { sources: [...sources], stage2Verified, groundTruth: false },
	}));
}

/**
 * Attach LLM Provenance to Stage-1 persona findings using each finding's REAL
 * per-persona attribution (R4.1, R9.5). The persona set carried on each
 * `PersonaTaggedFinding` (unioned across merged duplicates in dedup) maps
 * directly to `AgentSource` values (`architect`/`sre`/`security`), so
 * `mergeByIdentity` can union real sources and multi-persona agreement raises
 * confidence. Findings that somehow carry no persona metadata fall back to the
 * previous single `['security']` tag. The `personas` field is stripped here so
 * the ProvenancedFinding keeps the plain `ReviewFinding` shape (plus provenance).
 */
function attachPersonaProvenance(
	findings: PersonaTaggedFinding[],
	stage2Verified: boolean,
): ProvenancedFinding[] {
	return findings.map((f) => {
		const { personas, ...rest } = f;
		const sources: AgentSource[] = personas && personas.length > 0 ? [...personas] : ['security'];
		return {
			...rest,
			provenance: { sources, stage2Verified, groundTruth: false },
		};
	});
}

/**
 * Strip Provenance back to the plain `ReviewFinding` shape (R4.3). The
 * downstream dedup/REDUCE stages expect the plain shape; Provenance is always
 * attached but stripped here so it is INERT while the Consensus_Router and
 * Agentic_Verifier are disabled (R4.5, Property 7 — disabled-equivalence).
 */
function stripProvenance(findings: ProvenancedFinding[]): ReviewFinding[] {
	return findings.map(({ provenance: _provenance, ...rest }) => rest);
}

/**
 * Resolve the directory holding graphify's `graph.json` for the Agentic_Verifier
 * (Task 16 / R6.4). graphify writes either to the semantic out-of-repo dir
 * (`<workDir>-gfx/graphify-out`) when a backend key was set, or the default
 * code-only in-repo dir (`<workDir>/graphify-out`). The `run()` result does not
 * expose which path it took, so we prefer whichever actually contains a
 * `graph.json`, defaulting to the code-only dir. When neither exists the
 * graphify Verification_Tools simply return tool-errors and the verifier
 * continues with `read_file` (R9.3) — the stage never fails.
 */
function resolveGraphDir(workDir: string): string {
	const semantic = join(graphifyOutParentFor(workDir), 'graphify-out');
	if (existsSync(join(semantic, 'graph.json'))) return semantic;
	return join(workDir, 'graphify-out');
}

/**
 * Bounded concurrency runner to execute actions in parallel up to a concurrency limit (Task 3f / Gap 54).
 */
async function processWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<(R | Error)[]> {
	const results: (R | Error)[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const idx = nextIndex++;
			try {
				results[idx] = await fn(items[idx], idx);
			} catch (err) {
				results[idx] = err instanceof Error ? err : new Error(String(err));
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
	return results;
}

/**
 * Wraps an async function with a timeout guard and supports propagation of a parent AbortSignal.
 */
async function withTimeout<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
	parentSignal?: AbortSignal
): Promise<T> {
	if (parentSignal?.aborted) {
		throw new Error(`${label} aborted before starting: ${parentSignal.reason || 'parent signal aborted'}`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let onAbort: (() => void) | undefined;
	if (parentSignal) {
		onAbort = () => {
			controller.abort(parentSignal.reason || new Error('Parent signal aborted'));
		};
		parentSignal.addEventListener('abort', onAbort);
	}

	try {
		const result = await Promise.race([
			fn(controller.signal),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () =>
					reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
				);
				if (parentSignal) {
					parentSignal.addEventListener('abort', () =>
						reject(new Error(`${label} aborted: ${parentSignal.reason || 'parent signal aborted'}`))
					);
				}
			}),
		]);
		return result;
	} finally {
		clearTimeout(timer);
		if (parentSignal && onAbort) {
			parentSignal.removeEventListener('abort', onAbort);
		}
	}
}

/**
 * The core container-side review pipeline. Orchestrates the full sequence:
 * 1. Validate environment
 * 2. Fetch files from GitHub Pull Request API
 * 3. Run Static Analysis locally in clone (Shallow clone -> AST Graph -> oxlint/biome/semgrep)
 * 4. MAP - Chunked reviews via LLM (Haiku / Flash)
 * 5. REDUCE - Synthesize final review & post annotations
 * 6. Zoho Cliq & usage metrics storage
 * 7. Cleanup temp workspace
 */
export async function runReviewPipeline(
	request: ReviewRequest,
	requestId: string,
	signal?: AbortSignal
): Promise<ReviewResponse> {
	console.log(`[container-debug] runReviewPipeline ENTERED at ${Date.now()} for PR #${request.prNumber}`);
	// ── Step 0: Validate Env & Setup Mock Env ──
	validateEnvironment();

	console.log(`[pipeline-debug] ENV: AI_PROVIDER='${process.env.AI_PROVIDER}', DEFAULT='${DEFAULT_AI_PROVIDER}'`);
	console.log(`[pipeline-debug] ENV: ANTHROPIC_API_KEY present=${!!process.env.ANTHROPIC_API_KEY} len=${(process.env.ANTHROPIC_API_KEY || '').length}`);
	console.log(`[pipeline-debug] ENV: GEMINI_API_KEY present=${!!process.env.GEMINI_API_KEY} len=${(process.env.GEMINI_API_KEY || '').length}`);

	const env: Env = {
		CACHE_KV: new KvProxy('CACHE_KV'),
		USAGE_METRICS: new KvProxy('USAGE_METRICS'),
		AUTH_KV: new KvProxy('AUTH_KV'),
		DEDUP_KV: new KvProxy('DEDUP_KV'),
		AI_PROVIDER: (process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER) as any,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
		GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
		GITHUB_APP_ID: process.env.GITHUB_APP_ID || '',
		GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY || '',
		GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID || '',
		GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || '',
		BUDGET_ALERT_WEBHOOK: process.env.BUDGET_ALERT_WEBHOOK || '',
		HONEYCOMB_API_KEY: process.env.HONEYCOMB_API_KEY || '',
		OTEL_EXPORTER_URL: process.env.OTEL_EXPORTER_URL || '',
		ENABLE_WEB_SEARCH: process.env.ENABLE_WEB_SEARCH || 'false',
		// Agentic-review-pipeline feature flags (all default "false"). These must be
		// mirrored from process.env into `env` because `buildAgentSchedule` reads them
		// off the Env object to gate the dependency-audit, consensus, and verifier
		// phases (R2, R3.5, R11.1). Without this the new stages are unreachable.
		ENABLE_TRIAGE: process.env.ENABLE_TRIAGE || 'false',
		ENABLE_DUAL_AGENT: process.env.ENABLE_DUAL_AGENT || 'false',
		ENABLE_DEPENDENCY_AUDIT: process.env.ENABLE_DEPENDENCY_AUDIT || 'false',
		ENABLE_CONSENSUS: process.env.ENABLE_CONSENSUS || 'false',
		ENABLE_AGENTIC_VERIFIER: process.env.ENABLE_AGENTIC_VERIFIER || 'false',
		CLIQ_CLIENT_ID: process.env.CLIQ_CLIENT_ID || '',
		CLIQ_CLIENT_SECRET: process.env.CLIQ_CLIENT_SECRET || '',
		CLIQ_REFRESH_TOKEN: process.env.CLIQ_REFRESH_TOKEN || '',
		CLIQ_BOT_NAME: process.env.CLIQ_BOT_NAME || '',
		CLIQ_CHANNEL_ID: process.env.CLIQ_CHANNEL_ID || '',
		CLIQ_DB_NAME: process.env.CLIQ_DB_NAME || '',
		USAGE_API_KEY: process.env.USAGE_API_KEY || '',
	};

	// ── Step 0.1: Idempotency Guard ──
	const dedupKey = `review_completed:${request.repoFullName}:${request.prNumber}:${request.headSha}`;
	let isAlreadyCompleted = false;
	try {
		const cached = await env.DEDUP_KV.get(dedupKey).catch(e => {
			console.warn('Failed to check completion key (non-fatal):', e);
			return null;
		});
		if (cached) {
			if (cached === 'true') {
				isAlreadyCompleted = true;
			} else {
				const parsed = JSON.parse(cached);
				if (parsed && typeof parsed === 'object' && parsed.completed) {
					isAlreadyCompleted = true;
				}
			}
		}
	} catch {
		// Ignore JSON parse errors
	}

	if (isAlreadyCompleted) {
		console.log(`[${requestId}] PR review already completed for ${request.repoFullName}#${request.prNumber} at ${request.headSha}. Skipping.`);
		return {
			staticFindings: [],
			blastRadius: { changedFiles: [], impactedFiles: [], changedSymbols: [], impactedSymbols: [] },
			metrics: {
				cloneTimeMs: 0,
				parseTimeMs: 0,
				staticAnalysisTimeMs: 0,
				totalTimeMs: 0,
				filesAnalyzed: 0,
				symbolsTracked: 0,
			},
		};
	}

	if (signal?.aborted) {
		throw new Error(`Review aborted: ${signal.reason || 'parent signal aborted'}`);
	}

	// ── Step 0.5: Initialize Tracing ──
	await initializeTracing(env);

	const workDir = `/tmp/review-${uuidv4()}`;
	const metrics: ReviewMetrics = {
		cloneTimeMs: 0,
		parseTimeMs: 0,
		staticAnalysisTimeMs: 0,
		totalTimeMs: 0,
		filesAnalyzed: 0,
		symbolsTracked: 0,
	};

	const totalStart = Date.now();
	const startTime = new Date().toISOString();
	const llmCalls: LLMCallUsage[] = [];
	// Graphify result is captured here so its degradation notice (R12) can be
	// appended to the posted review — including from the outer sandbox-error path.
	let graphifyResult: GraphifyResult | undefined;
	const provider = env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER;
	const modelName = getModelName(provider);
	console.log(`[pipeline-debug] Effective provider='${provider}' model='${modelName}' env.AI_PROVIDER='${env.AI_PROVIDER}'`);

	// ── Step 1: Get installation token ──
	console.log(`[${requestId}] Fetching installation token...`);
	const token = await getInstallationToken(env);

	try {
		// ── Step 2: Fetch and Filter Changed Files from GitHub API ──
		console.log(`[${requestId}] Fetching changed files for ${request.repoFullName}#${request.prNumber}...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🔍 Fetching changed files list from GitHub API...');
		const allFiles = await fetchChangedFiles(request.repoFullName, request.prNumber, token, env, request.headSha);

		if (allFiles.length === 0) {
			if (request.checkRunId) {
				await updateCheckRun(request.repoFullName, request.checkRunId, token, 'neutral', '## No Files to Review\n\nThis PR has no reviewable file changes.');
			}
			return {
				staticFindings: [],
				blastRadius: { changedFiles: [], impactedFiles: [], changedSymbols: [], impactedSymbols: [] },
				metrics: { ...metrics, totalTimeMs: Date.now() - totalStart },
			};
		}

		// ── Step 2.5: Finalize Review_Track + build Agent_Schedule (R1.8, R2.1) ──
		// The edge worker may have attached a provisional `track` (from title/labels
		// when the file list was unavailable). Now that the real changed-file list is
		// known, re-run the shared triage rules to FINALIZE the track (R1.8). Gated by
		// `ENABLE_TRIAGE`: when triage is off, the track defaults to `full` so behavior
		// matches the pre-feature pipeline (R1.5, Property 7 disabled-equivalence).
		const provisionalTrack: ReviewTrack = request.track ?? 'full';

		// Fetch the per-repo `.codereview.yml` config ONCE, up front, so its
		// pipeline overrides (track + enabled stages, R11.3) can be applied BEFORE
		// the Agent_Schedule is built. Reused later for stack/rules/ignore overrides.
		const repoConfig: RepoReviewConfig | null = await fetchRepoConfig(request.repoFullName, token, env.CACHE_KV);

		// Effective triage-enabled decision (R11.3): a repo's `.codereview.yml`
		// `pipeline.enableTriage` takes precedence when set, so a repo can force
		// triage/track finalization on or off; otherwise fall back to the
		// `ENABLE_TRIAGE` env flag. The security-`deep` floor is still enforced by
		// `applyPipelineConfigOverrides` afterward regardless of this value.
		const triageEnabled = repoConfig?.pipeline?.enableTriage ?? (process.env.ENABLE_TRIAGE === 'true');

		// R10.6: tracer span for triage/track finalization. `startSpan` degrades to a
		// no-op when OpenTelemetry is unavailable, so this never throws (R9.4).
		const triageSpan = startSpan(SpanNames.TRIAGE_FINALIZE, { [SpanAttributes.GITHUB_PR_NUMBER]: request.prNumber });
		let finalizedTrack: ReviewTrack = 'full';
		let trackReason = 'triage-disabled';
		// A security-driven `deep` escalation is a FLOOR that repo config cannot lower
		// (R11.3, Property 10). It is set when the container's own rules escalate for a
		// security path, or when the edge attached a provisional `deep` (security-only).
		let securityDeepFloor = false;
		try {
			if (triageEnabled) {
				const decision = triagePR(
					{
						files: allFiles.map((f) => ({
							filename: f.filename,
							status: f.status,
							additions: f.additions,
							deletions: f.deletions,
						})),
						// Labels/target branch are not carried into the container; the edge
						// worker captured any label-based security escalation in the
						// provisional track, which is honored as a floor below.
						labels: [],
						title: request.title,
						targetBranch: '',
					},
					DEFAULT_TRIAGE_CONFIG,
				);
				finalizedTrack = decision.track;
				trackReason = decision.reason;
				if (decision.track === 'deep' && /security/i.test(decision.reason)) {
					securityDeepFloor = true;
				}
				// Security floor (R1.2 / R11.3): never LOWER an edge security escalation.
				// The edge assigns `deep` only for security-sensitive PRs, so a provisional
				// `deep` pins the floor — file-based finalization can raise but never lower it.
				if (provisionalTrack === 'deep' && finalizedTrack !== 'deep') {
					finalizedTrack = 'deep';
					trackReason = 'security-sensitive (edge floor)';
				}
				if (provisionalTrack === 'deep') securityDeepFloor = true;
			}
			triageSpan.setAttribute(SpanAttributes.REVIEW_TRACK, finalizedTrack);
			triageSpan.setAttribute(SpanAttributes.REVIEW_TRACK_REASON, trackReason);
			triageSpan.setAttribute(SpanAttributes.REVIEW_TRACK_PROVISIONAL, provisionalTrack);
			triageSpan.setAttribute(SpanAttributes.REVIEW_TRACK_SECURITY_FLOOR, securityDeepFloor);
		} finally {
			triageSpan.end();
		}

		// ── Per-repo pipeline overrides (R11.3) ──
		// A repo may raise the track or toggle stages via `.codereview.yml`, EXCEPT it
		// cannot lower a security-driven `deep` escalation (Property 10). Apply the
		// override to the track and derive an env overlay so the Scheduler sees the
		// repo's stage toggles.
		const pipelineOverride = applyPipelineConfigOverrides(finalizedTrack, securityDeepFloor, repoConfig);
		if (pipelineOverride.securityFloorEnforced) {
			// R10.5: log the specific reason the repo override was clamped.
			console.log(
				`[${requestId}] Repo config requested a track below the security 'deep' floor; enforcing 'deep' (R11.3, security-floor).`
			);
			trackReason = `${trackReason} [security-floor: repo config could not lower below deep]`;
		} else if (pipelineOverride.trackChanged) {
			trackReason = `repo-config-override:${pipelineOverride.track} (triage:${trackReason})`;
		}
		finalizedTrack = pipelineOverride.track;

		// Env overlay carrying the repo's stage toggles into `buildAgentSchedule`.
		let scheduleEnv: Env = env;
		const of = pipelineOverride.flags;
		if (
			of.enableDependencyAudit !== undefined ||
			of.enableConsensus !== undefined ||
			of.enableAgenticVerifier !== undefined
		) {
			scheduleEnv = { ...env };
			if (of.enableDependencyAudit !== undefined)
				scheduleEnv.ENABLE_DEPENDENCY_AUDIT = of.enableDependencyAudit ? 'true' : 'false';
			if (of.enableConsensus !== undefined)
				scheduleEnv.ENABLE_CONSENSUS = of.enableConsensus ? 'true' : 'false';
			if (of.enableAgenticVerifier !== undefined)
				scheduleEnv.ENABLE_AGENTIC_VERIFIER = of.enableAgenticVerifier ? 'true' : 'false';
			console.log(
				`[${requestId}] Repo config stage overrides applied: ` +
					`dependency-audit=${of.enableDependencyAudit ?? 'default'} ` +
					`consensus=${of.enableConsensus ?? 'default'} ` +
					`verifier=${of.enableAgenticVerifier ?? 'default'}`
			);
		}

		// R10.6: tracer span for building the Agent_Schedule.
		const scheduleSpan = startSpan(SpanNames.SCHEDULE_BUILD, { [SpanAttributes.REVIEW_TRACK]: finalizedTrack });
		const schedule: AgentSchedule = buildAgentSchedule(finalizedTrack, scheduleEnv);
		scheduleSpan.setAttribute(SpanAttributes.SCHEDULE_CONSENSUS_ENABLED, schedule.consensusEnabled);
		scheduleSpan.setAttribute(SpanAttributes.SCHEDULE_VERIFIER_ENABLED, schedule.verifierEnabled);
		scheduleSpan.setAttribute(SpanAttributes.SCHEDULE_PERSONAS_ENABLED, schedule.personasEnabled);
		scheduleSpan.end();
		const isFastTrack = finalizedTrack === 'fast';
		// R10.1: log the assigned track and reason.
		console.log(
			`[${requestId}] Review track finalized: ${finalizedTrack} (reason: ${trackReason}, provisional: ${provisionalTrack}, triageEnabled: ${triageEnabled}) — schedule: consensus=${schedule.consensusEnabled} verifier=${schedule.verifierEnabled} personas=${schedule.personasEnabled} dep-audit=${schedule.phases['dependency-audit'].enabled}`
		);

		const classified = classifyFiles(allFiles);
		
		// Apply tech stack and repo configurations
		const patchContents = allFiles
			.filter(f => f.patch && (f.status === 'added' || f.status === 'modified'))
			.slice(0, 20)
			.map(f => ({
				filename: f.filename,
				content: f.patch!.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n'),
			}))
			.filter(f => f.content.length > 0);

		const stackProfile = await detectTechStack({
			changedFiles: allFiles.map(f => f.filename),
			fileContents: patchContents.length > 0 ? patchContents : undefined,
			repoFullName: request.repoFullName,
			token,
			kvNamespace: env.CACHE_KV,
		});

		let activeProfile = stackProfile;
		let customRulesPrompt: string | undefined;
		// `repoConfig` was fetched up front (above) so pipeline overrides could gate
		// the Agent_Schedule; reuse it here for stack/rules/ignore overrides.
		if (repoConfig) {
			activeProfile = applyConfigOverrides(stackProfile, repoConfig);
			customRulesPrompt = buildCustomRulesPrompt(repoConfig);

			if (repoConfig.ignore?.length) {
				classified.tier1 = classified.tier1.filter(f => !shouldIgnore(f.filename, repoConfig.ignore!));
				classified.tier2 = classified.tier2.filter(f => !shouldIgnore(f.filename, repoConfig.ignore!));
			}
		}

		if (classified.tier1.length === 0 && classified.tier2.length === 0) {
			if (request.checkRunId) {
				await updateCheckRun(request.repoFullName, request.checkRunId, token, 'neutral', `## All Files Ignored\n\nAll ${allFiles.length} files are ignored by \`.codereview.yml\`.`);
			}
			return {
				staticFindings: [],
				blastRadius: { changedFiles: [], impactedFiles: [], changedSymbols: [], impactedSymbols: [] },
				metrics: { ...metrics, totalTimeMs: Date.now() - totalStart },
			};
		}

		const allowedFiles = [...classified.tier1.map(f => f.filename), ...classified.tier2.map(f => f.filename)];
		metrics.filesAnalyzed = allowedFiles.length;

		// ── Step 3: Fetch previous review context ──
		const previousReview = await fetchPreviousReviewFindings(request.repoFullName, request.prNumber, token);

		// ── Step 4: Run Static Analysis locally in Clone (Shallow Clone -> AST -> oxlint/biome/semgrep) ──
		console.log(`[${requestId}] Shallow cloning repository into isolated sandbox...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '📦 Cloning repository into isolated sandbox...');
		const cloneStart = Date.now();
		await cloneRepository(request.repoFullName, request.headSha, token, workDir, signal);
		metrics.cloneTimeMs = Date.now() - cloneStart;
		console.log(`[${requestId}] Clone completed in ${metrics.cloneTimeMs}ms`);

		// Filter allowedFiles to only include files that exist on disk in the clone (exclude deleted files)
		const existingAllowedFiles = allowedFiles.filter(f => existsSync(join(workDir, f)));

		// Cheap, always-on: extract symbols from the CHANGED files only (used to
		// seed/rank graphify queries and summarize the PR). The expensive repo-wide
		// reverse-dependency scan is delegated to graphify and only run as a
		// fallback below when graphify is unusable (R8).
		console.log(`[${requestId}] Extracting changed symbols via Tree-Sitter...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🌳 Extracting changed symbols via Tree-Sitter AST...');
		const parseStart = Date.now();
		const changedSymbols = await extractChangedSymbols(workDir, existingAllowedFiles);
		metrics.parseTimeMs = Date.now() - parseStart;
		metrics.symbolsTracked = changedSymbols.length;
		console.log(`[${requestId}] AST symbols extracted in ${metrics.parseTimeMs}ms — ${changedSymbols.length} changed symbols`);

		console.log(`[${requestId}] Running security & linting tools...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🛡️ Executing Ground-Truth Security & Linting Tools...');
		const staticStart = Date.now();
		const staticFindings = await runStaticAnalysis(workDir, existingAllowedFiles, signal);
		metrics.staticAnalysisTimeMs = Date.now() - staticStart;
		console.log(`[${requestId}] Static analysis done in ${metrics.staticAnalysisTimeMs}ms — ${staticFindings.length} findings`);

		// ── Dependency Audit (R3.1) — ground-truth supply-chain scan ──
		// Standalone step over ALL changed files (not only code files, R3.4): scans
		// lockfiles, manifests, Dockerfiles, and CI workflows the plugin runner never
		// sees. Gated by the Agent_Schedule (flag + breaker). Emits ground-truth
		// findings that are merged into `pluginFindings` below so they are always
		// posted and never rejected by any LLM stage (R5.2). Never throws (R9.4).
		let mappedDependencyFindings: ReviewFinding[] = [];
		if (schedule.phases['dependency-audit'].enabled) {
			// R10.6: tracer span for the dependency-audit stage; never throws (R9.4).
			const depSpan = startSpan(SpanNames.DEPENDENCY_AUDIT, { [SpanAttributes.REVIEW_TRACK]: finalizedTrack });
			try {
				await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🔗 Auditing dependencies & supply-chain files...');
				const depFindings = await runDependencyAudit({
					workDir,
					changedFiles: allFiles.map((f) => f.filename),
				});
				mappedDependencyFindings = depFindings.map((d) => ({
					issue: d.issue,
					title: d.title,
					description: d.issue,
					severity: d.severity,
					file: d.file,
					line: d.line,
					category: d.category,
				}));
				depSpan.setAttribute(SpanAttributes.DEP_AUDIT_FINDINGS, mappedDependencyFindings.length);
				console.log(`[${requestId}] Dependency audit done — ${mappedDependencyFindings.length} ground-truth findings`);
			} catch (err) {
				console.warn(`[${requestId}] Dependency audit failed (non-fatal, continuing):`, err);
			} finally {
				depSpan.end();
			}
		}

		// ── Graphify AST Knowledge Graph Indexing ──
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🗺️ Indexing codebase AST via Graphify...');
		// Keep the CheckRun fresh during the (up to GRAPHIFY_BUDGET_MS) extraction
		// window so the review does not appear stalled (Requirement 3.5). graphify
		// runs as a child process, so this interval fires freely on the event loop.
		const graphifyHeartbeat = setInterval(() => {
			void updateCheckRunProgress(
				request.repoFullName,
				request.checkRunId,
				token,
				'🗺️ Indexing codebase AST via Graphify...'
			).catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				console.warn(`Graphify heartbeat failed: ${msg}`);
			});
		}, 30_000);
		// Blast radius: graphify is authoritative when it produced a usable graph.
		// Only fall back to the expensive tree-sitter reverse-dependency scan when
		// graphify was unusable (R8.2), so we never lose a blast-radius signal.
		let blastRadius: BlastRadius = {
			changedFiles: existingAllowedFiles,
			impactedFiles: [],
			changedSymbols,
			impactedSymbols: [],
		};
		let graphifyContext = '';
		// graphify extraction is gated by the Agent_Schedule (R2.2/R2.8): the `fast`
		// track skips it entirely, and an open provider breaker disables it. When
		// skipped we still compute a tree-sitter blast radius so downstream context
		// is populated. On full/deep with a closed breaker this matches the
		// pre-feature always-on behavior (Property 7 disabled-equivalence).
		const runGraphify = schedule.phases.graphify.enabled;
		// The heartbeat wraps BOTH graphify extraction AND the (possibly slow,
		// repo-wide) tree-sitter fallback scan, so the CheckRun never appears
		// stalled during either phase; cleared once in the finally.
		try {
			if (!runGraphify) {
				console.log(`[${requestId}] Graphify skipped (schedule disabled for track '${finalizedTrack}'); using tree-sitter blast radius`);
				await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🌳 Computing dependency blast radius via Tree-Sitter...');
				const fbStart = Date.now();
				blastRadius = await buildBlastRadius(workDir, existingAllowedFiles);
				metrics.parseTimeMs += Date.now() - fbStart;
				metrics.symbolsTracked = blastRadius.changedSymbols.length + blastRadius.impactedSymbols.length;
			} else {
				graphifyResult = await graphifyIntegration.run(
					workDir,
					existingAllowedFiles,
					changedSymbols,
					signal,
					MAX_GRAPH_CONTEXT_CHARS,
					GRAPHIFY_BUDGET_MS
				);
				graphifyContext = graphifyResult.context.render();

				// Fall back ONLY when graphify produced no usable graph (R8.1). Keying
				// on `context.available` (not on `degradationReason`) means a salvaged
				// code-only graph — e.g. a `missing-key` outcome on the semantic path
				// that still wrote a graph and ran `affected` — is treated as
				// authoritative and does NOT trigger the redundant repo-wide scan.
				const graphifyUsable = graphifyResult.context.available;
				if (!graphifyUsable) {
					console.warn(`[${requestId}] Graphify graph unavailable (${graphifyResult.telemetry.degradationReason ?? 'unknown'}); falling back to tree-sitter blast radius`);
					await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🌳 Computing dependency blast radius via Tree-Sitter fallback...');
					const fbStart = Date.now();
					blastRadius = await buildBlastRadius(workDir, existingAllowedFiles);
					metrics.parseTimeMs += Date.now() - fbStart;
					metrics.symbolsTracked = blastRadius.changedSymbols.length + blastRadius.impactedSymbols.length;
				}
			}
		} finally {
			clearInterval(graphifyHeartbeat);
		}

		// Map static analysis outputs to standardized ReviewFindings
		const mappedStaticFindings = staticFindings.map(f => ({
			issue: f.message,
			title: `[${f.tool}] ${f.rule}`,
			description: f.message,
			severity: (f.severity === 'error' ? 'high' : 'medium') as 'critical'|'high'|'medium'|'low',
			file: f.file,
			line: f.line,
			category: 'clean-code' as const,
		}));

		// Only surface the tree-sitter "Impacted files" line when the fallback
		// actually ran; otherwise graphify's section (in graphifyContext) is the
		// authoritative blast radius and a "0" here would be misleading.
		const impactedLine = blastRadius.impactedFiles.length > 0
			? `\nImpacted files: ${blastRadius.impactedFiles.length}`
			: '';
		const containerBlastRadiusText = `\n\n## Container Blast Radius Analysis\nChanged files: ${existingAllowedFiles.length}${impactedLine}\nChanged symbols: ${changedSymbols.map((s) => `${s.kind} ${s.name}`).join(', ')}` + graphifyContext;

		// ── Step 5: Build review chunks ──
		const { chunks, chunkFileMap, globalContext, allFiles: reviewableFiles, pluginFindings } =
			await buildReviewChunks(classified, token, MAX_CHUNK_CHARS, env, {
				title: request.title,
				repoFullName: request.repoFullName,
				prNumber: request.prNumber
			}, containerBlastRadiusText);

		// Combine AST/SAST results into pluginFindings
		pluginFindings.push(...mappedStaticFindings);
		// Merge ground-truth dependency-audit findings so they are always posted
		// (they flow through `combinedFindings` in BOTH the dual-agent and direct
		// MAP paths, including the `fast` track). Inert when the audit is disabled
		// (`mappedDependencyFindings` stays empty).
		pluginFindings.push(...mappedDependencyFindings);

		// ── Step 6: Map Phase — LLM Chunk Reviews with Concurrency Limit 5 (Task 3f / Gap 54) ──
		const webSearchActive = shouldEnableWebSearch(reviewableFiles, env);
		let cachedSourcesContext = '';

		if (webSearchActive) {
			const cachedSources = await getCachedSearchSources(request.repoFullName, env.CACHE_KV);
			cachedSourcesContext = formatCachedSourcesContext(cachedSources);
		}

		console.log(`[${requestId}] Dispatching ${chunks.length} review chunks to LLM (concurrency limit: 5)...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, `🤖 Reviewing ${chunks.length} code chunks in parallel via AI...`);

		const allFindings = [...pluginFindings];
		// Track MAP chunk findings separately (in addition to `allFindings`) so the
		// MAP-only Active_Finding_Set can be provenance-tagged for the router/verifier
		// seam below without re-separating them from the ground-truth findings.
		const mapFindings: ReviewFinding[] = [];
		let failedChunks = 0;
		const failedChunkFiles: string[] = [];
		const chunkErrors: string[] = [];

		const chunkResults = await processWithConcurrency(
			chunks,
			5, // Max 5 parallel chunk reviews to prevent rate-limit 429 errors
			async (chunkContent: string, i: number) => {
				const chunkLabel = `${i + 1}/${chunks.length}`;
				const chunkFiles = chunkFileMap[i] || [];
				
				let chunkSystemPrompt = composeChunkPrompt(activeProfile, chunkFiles, customRulesPrompt, webSearchActive);
				if (request.deepReview) {
					chunkSystemPrompt += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nDEEP REVIEW MODE — EXTRA THOROUGH ANALYSIS REQUIRED\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nYou are performing a DEEP REVIEW. Be EXTRA thorough. Scrutinize EVERY line for:\n- Edge cases and boundary conditions\n- Race conditions and concurrency bugs\n- Security vulnerabilities (XSS, injection, auth bypass, CSRF, SSRF)\n- Performance issues and memory leaks\n- Error handling gaps and missing validation\n- Type safety violations\n- Architectural and design problems\n- Logic errors and off-by-one bugs\n- Inconsistent error/success patterns\n\nDo NOT skip any potential issue. Re-examine each file from multiple angles. Even subtle issues matter in a deep review.';
				}
				if (webSearchActive && cachedSourcesContext) {
					chunkSystemPrompt += '\n\n' + cachedSourcesContext;
				}
				if (previousReview.findings.length > 0) {
					const chunkPreviousContext = formatPreviousReviewContext(previousReview, chunkFiles);
					if (chunkPreviousContext) chunkSystemPrompt += '\n\n' + chunkPreviousContext;
				}

				const prContext = request.prDescription ? `PR Description:\n${request.prDescription}\n\n` : '';

				try {
					const result = await withTimeout(
						(sig) => callChunkReview(
							prContext + chunkContent,
							request.title,
							chunkLabel,
							env,
							sig,
							chunkSystemPrompt,
							reviewableFiles,
							webSearchActive
						),
						LLM_TIMEOUT_MS,
						`Chunk ${chunkLabel}`,
						signal
					);
					return { result, chunkLabel, chunkContent };
				} catch (primaryError) {
					const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
					console.log(`[pipeline-debug] Chunk ${chunkLabel} primary error: ${errMsg.slice(0, 300)}`);
					
					// Circuit breaker fallback to alternate provider
					if (errMsg.includes('circuit breaker') && errMsg.includes('OPEN')) {
						const altProvider = provider === 'claude' ? 'gemini' : 'claude';
						const altKey = altProvider === 'gemini' ? env.GEMINI_API_KEY : env.ANTHROPIC_API_KEY;
						console.log(`[pipeline-debug] Fallback triggered: provider=${provider} altProvider=${altProvider} altKeyPresent=${!!altKey}`);

						if (altKey) {
							console.warn(`[${requestId}] Primary provider circuit open, attempting alternate provider: ${altProvider}`);
							const fallbackEnv = { ...env, AI_PROVIDER: altProvider } as Env;

							try {
								const result = await withTimeout(
									(sig) => callChunkReview(
										prContext + chunkContent,
										request.title,
										chunkLabel,
										fallbackEnv,
										sig,
										chunkSystemPrompt,
										reviewableFiles,
										webSearchActive
									),
									LLM_TIMEOUT_MS,
									`Chunk ${chunkLabel} (fallback:${altProvider})`,
									signal
								);
								return { result, chunkLabel, chunkContent };
							} catch (fallbackError) {
								console.error(`[${requestId}] Chunk fallback failed too:`, fallbackError);
								return {
									error: true,
									chunkLabel,
									errorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
								};
							}
						}
					}
					throw primaryError;
				}
			}
		);

		// Process map output results
		for (let i = 0; i < chunkResults.length; i++) {
			const outcome = chunkResults[i];
			if (outcome instanceof Error || (outcome as any).error) {
				failedChunks++;
				const errorMsg = outcome instanceof Error ? outcome.message : (outcome as any).errorMessage;
				const errorReason = errorMsg || 'Unknown error';
				if (!chunkErrors.includes(errorReason)) chunkErrors.push(errorReason);

				const filePaths = chunkFileMap[i] || [];
				for (const fp of filePaths) {
					if (!failedChunkFiles.includes(fp)) failedChunkFiles.push(fp);
				}
			} else if (outcome.result) {
				allFindings.push(...outcome.result.findings);
				mapFindings.push(...outcome.result.findings);
				llmCalls.push({
					phase: 'map',
					chunkLabel: outcome.chunkLabel,
					model: modelName,
					usage: outcome.result.usage,
					timestamp: new Date().toISOString(),
				});
			}
		}

		// ── Step 7: Dual-Agent Pipeline — Stage 1 (Persona Review) + Stage 2 (Verification) ──
		// Track-aware persona gating (R2.6/R2.7): the `fast` track NEVER runs personas
		// (posts static + MAP directly); `deep` forces personas on. When triage is off
		// the track is `full`, so this reduces to the pre-feature condition
		// (`deepReview || ENABLE_DUAL_AGENT`) — preserving disabled-equivalence.
		const enableDualAgent =
			!isFastTrack &&
			(finalizedTrack === 'deep' || request.deepReview === true || process.env.ENABLE_DUAL_AGENT === 'true');

		let stage1Results = { findings: [] as any[], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, personaResults: [] as any[] };
		let stage2Results = { verifiedFindings: [] as any[], rejectedFindings: [] as any[], stats: { totalEvaluated: 0, verified: 0, rejected: 0 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
		let smartDedupResult = { findingsToPost: [] as any[], suppressedInline: [] as any[], allUnresolved: [] as any[] };
		// The LLM survivors that feed smart-dedup. When consensus is DISABLED this is
		// exactly `stage2Results.verifiedFindings` (pre-feature behavior); when
		// ENABLED it is the Consensus_Router + Agentic_Verifier survivors (R6.7).
		let activeVerifiedFindings: ReviewFinding[] = [];

		// Directory holding graphify's `graph.json`, resolved once for the verifier.
		const resolvedGraphDir = resolveGraphDir(workDir);

		// ── Consensus_Router + Agentic_Verifier stage (Task 16, R5/R6/R7) ──────────
		// Runs `mergeByIdentity → routeAll` on an Active_Finding_Set, then either
		// verifies the Ambiguous (VERIFY) findings via the bounded Agentic_Verifier
		// (when `schedule.verifierEnabled`) or resolves them via the Fallback_Decision
		// (R5.6). Returns plain `ReviewFinding` survivors (KEEP + DOWNGRADE + verified/
		// fallback-kept), provenance stripped. NEVER throws (R9.4): on any error the
		// input active set is returned unchanged so no finding is lost.
		const runConsensusStage = async (activeSet: ProvenancedFinding[]): Promise<ReviewFinding[]> => {
			// R10.6: tracer span for consensus routing; degrades to no-op, never throws.
			const routeSpan = startSpan(SpanNames.CONSENSUS_ROUTE, { [SpanAttributes.REVIEW_TRACK]: finalizedTrack });
			try {
				const merged = mergeByIdentity(activeSet);
				const routed = routeAll(merged, DEFAULT_CONSENSUS_CONFIG);
				// R10.2: log route counts.
				console.log(
					`[${requestId}] Consensus router: KEEP=${routed.keep.length} DOWNGRADE=${routed.downgraded.length} VERIFY=${routed.toVerify.length} SUPPRESS=${routed.suppressedCount}`
				);
				routeSpan.setAttribute(SpanAttributes.CONSENSUS_KEEP, routed.keep.length);
				routeSpan.setAttribute(SpanAttributes.CONSENSUS_DOWNGRADE, routed.downgraded.length);
				routeSpan.setAttribute(SpanAttributes.CONSENSUS_VERIFY, routed.toVerify.length);
				routeSpan.setAttribute(SpanAttributes.CONSENSUS_SUPPRESS, routed.suppressedCount);

				// KEEP + DOWNGRADE survive (downgraded already forced to severity `low`).
				const survivors: ReviewFinding[] = [
					...stripProvenance(routed.keep),
					...stripProvenance(routed.downgraded),
				];

				if (routed.toVerify.length === 0) return survivors;

				if (schedule.verifierEnabled) {
					// Wall-clock deadline = fraction of the review's REMAINING time (R7.8),
					// so verification never starves the REDUCE/post stage. There is no
					// global review-deadline constant, so we bound remaining time by the
					// LLM stage cap (`LLM_TIMEOUT_MS`) minus elapsed pipeline time.
					const elapsed = Date.now() - totalStart;
					const remaining = Math.max(0, LLM_TIMEOUT_MS - elapsed);
					const deadlineMs = Date.now() + Math.floor(remaining * schedule.budgets.wallClockFraction);

					// R7.4: keep the CheckRun heartbeat reporting while the stage runs.
					await updateCheckRunProgress(
						request.repoFullName,
						request.checkRunId,
						token,
						`🔎 Agentic verification of ${routed.toVerify.length} ambiguous finding(s)...`
					);
					const verifyHeartbeat = setInterval(() => {
						void updateCheckRunProgress(
							request.repoFullName,
							request.checkRunId,
							token,
							'🔎 Agentic verification in progress — reading code & querying the graph...'
						).catch((e: unknown) => {
							const msg = e instanceof Error ? e.message : String(e);
							console.warn(`Verifier heartbeat failed: ${msg}`);
						});
					}, 30_000);

					// R10.6: tracer span for the agentic verifier stage (nested under the
					// consensus route span). Wrapped with `withSpan` so success/error status
					// is recorded; the verifier itself never throws (R9.4).
					let verifierResult: VerifierResult;
					try {
						verifierResult = await withSpan(
							SpanNames.AGENTIC_VERIFY,
							async (span) => {
								span.setAttribute(SpanAttributes.CONSENSUS_VERIFY, routed.toVerify.length);
								span.setAttribute(SpanAttributes.REVIEW_TRACK, finalizedTrack);
								const r = await verifyFindings(
									routed.toVerify,
									{
										workDir,
										graphDir: resolvedGraphDir,
										env,
										signal,
										budgets: schedule.budgets,
										deadlineMs,
									},
									(f) => resolveFallback(f, DEFAULT_CONSENSUS_CONFIG),
								);
								span.setAttribute(SpanAttributes.VERIFIER_EVALUATED, r.stats.totalEvaluated);
								span.setAttribute(SpanAttributes.VERIFIER_VERIFIED, r.stats.verified);
								span.setAttribute(SpanAttributes.VERIFIER_REJECTED, r.stats.rejected);
								span.setAttribute(SpanAttributes.VERIFIER_FLIPS, r.stats.flips);
								span.setAttribute(SpanAttributes.VERIFIER_TOKENS, r.usage.totalTokens);
								return r;
							},
						);
					} finally {
						clearInterval(verifyHeartbeat);
					}

					// Record verifier usage as a distinct phase (R6.13).
					llmCalls.push({
						phase: 'verify',
						chunkLabel: 'agentic-verify',
						// The verifier's selectProvider may pick a different provider than
						// the pipeline's configured one — log the actually-selected model
						// when known, else fall back to the configured provider's model.
						model: verifierResult.selectedModel ?? getModelName(provider),
						usage: verifierResult.usage,
						timestamp: new Date().toISOString(),
					});

					// R10.7: log the flip COUNT and FRACTION (flips/evaluated) plus the
					// consensus suppression/downgrade counts, so the verifier's value is
					// measurable. R10.4 (steps/tool-calls/elapsed) is logged inside the
					// verifier's own aggregate line.
					const evaluated = verifierResult.stats.totalEvaluated;
					const flips = verifierResult.stats.flips;
					const flipRate = evaluated > 0 ? flips / evaluated : 0;
					const verifySpan = startSpan(SpanNames.AGENTIC_VERIFY);
					verifySpan.setAttribute(SpanAttributes.VERIFIER_FLIP_RATE, Number(flipRate.toFixed(4)));
					verifySpan.end();
					console.log(
						`[${requestId}] Agentic verifier: evaluated=${evaluated} verified=${verifierResult.stats.verified} rejected=${verifierResult.stats.rejected} flips=${flips} flipRate=${flipRate.toFixed(3)} tokens=${verifierResult.usage.totalTokens} | consensus: DOWNGRADE=${routed.downgraded.length} SUPPRESS=${routed.suppressedCount}`
					);

					survivors.push(...verifierResult.verifiedFindings);
					return survivors;
				}

				// Verifier disabled/unavailable → Fallback_Decision per finding (R5.6).
				// R10.5: the Fallback_Decision reason is that the Agentic_Verifier is not
				// enabled for this schedule (flag off or breaker open / fast track).
				const fallbackReason = schedule.verifierEnabled
					? 'verifier-unavailable'
					: 'verifier-disabled';
				let fbKeep = 0;
				let fbDowngrade = 0;
				let fbSuppress = 0;
				for (const f of routed.toVerify) {
					const disposition = resolveFallback(f, DEFAULT_CONSENSUS_CONFIG);
					const [plain] = stripProvenance([f]);
					if (disposition === 'keep') {
						survivors.push(plain);
						fbKeep++;
					} else if (disposition === 'downgrade') {
						survivors.push({ ...plain, severity: 'low' });
						fbDowngrade++;
					} else {
						fbSuppress++;
					}
				}
				console.log(
					`[${requestId}] Consensus fallback (reason: ${fallbackReason}): keep=${fbKeep} downgrade=${fbDowngrade} suppress=${fbSuppress} (of ${routed.toVerify.length} VERIFY-routed)`
				);
				return survivors;
			} catch (err) {
				// Never throw (R9.4): fall back to the input active set unchanged.
				console.warn(`[${requestId}] Consensus router/verifier failed (using active set unchanged):`, err);
				return stripProvenance(activeSet);
			} finally {
				routeSpan.end();
			}
		};

		if (enableDualAgent && chunks.length > 0) {
			// ── Stage 1: Persona-based Review with Claude Sonnet ──
			console.log(`[${requestId}] Running Stage 1: Persona-based review with Claude Sonnet...`);
			await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🤖 Stage 1: Reviewing code with Architect, SRE & Security personas...');

			// Start 30s heartbeat to prevent CheckRun timeout (Architecture §8.6)
			const heartbeat = setInterval(async () => {
				await updateCheckRunProgress(
					request.repoFullName,
					request.checkRunId,
					token,
					'🤖 Stage 1 in progress — running Architect, SRE & Security personas...'
				).catch((e: unknown) => {
					const msg = e instanceof Error ? e.message : String(e);
					console.warn(`Stage 1 heartbeat failed: ${msg}`);
				});
			}, 30_000);

			const staticFindingsContext = mappedStaticFindings.length > 0
				? mappedStaticFindings.map(f => `- [${f.severity}] ${f.title} in ${f.file}:${f.line}`).join('\n')
				: undefined;

			try {
				stage1Results = await runStage1Review(
					chunks,
					chunkFileMap,
					allowedFiles,
					request.title,
					env,
					signal,
					customRulesPrompt,
					staticFindingsContext,
					graphifyContext || undefined
				);

				// Track Stage 1 LLM usage
				llmCalls.push({
					phase: 'map',
					chunkLabel: 'stage1-all',
					model: 'claude-sonnet-4-6',
					usage: stage1Results.usage,
					timestamp: new Date().toISOString(),
				});

				console.log(`[${requestId}] Stage 1 complete: ${stage1Results.findings.length} findings from ${stage1Results.personaResults.length} persona runs`);

				if (schedule.consensusEnabled) {
					// ── Consensus_Router + Agentic_Verifier REPLACE single-shot Stage 2 ──
					// The Active_Finding_Set on the dual-agent path is the Stage-1 persona
					// findings (R5.1a). The original `runStage2Verification` is deliberately
					// NOT run here (avoid double verification, R6.7). Survivors feed
					// smart-dedup exactly where Stage 2's verified findings fed it.
					console.log(`[${requestId}] Consensus enabled: routing ${stage1Results.findings.length} persona findings (replaces Stage 2)...`);
					await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🧭 Consensus routing of persona findings...');
					const personaActive = attachPersonaProvenance(stage1Results.findings, false);
					activeVerifiedFindings = await runConsensusStage(personaActive);
				} else if (stage1Results.findings.length > 0) {
					// ── Stage 2: single-shot Verification with Gemini Flash (consensus off) ──
					console.log(`[${requestId}] Running Stage 2: Verifying findings with Gemini Flash...`);
					await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🔬 Stage 2: Verifying findings with Gemini Flash...');

					// Build PR diff context for verification
					const diffContext = allFiles
						.filter(f => f.patch)
						.slice(0, 10)
						.map(f => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
						.join('\n');

					stage2Results = await runStage2Verification(
						stage1Results.findings,
						diffContext,
						env,
						signal
					);

					llmCalls.push({
						phase: 'reduce',
						chunkLabel: 'stage2-all',
						model: 'gemini-2.0-flash',
						usage: stage2Results.usage,
						timestamp: new Date().toISOString(),
					});

					activeVerifiedFindings = stage2Results.verifiedFindings;

					console.log(`[${requestId}] Stage 2 complete: ${stage2Results.stats.verified} verified, ${stage2Results.stats.rejected} rejected`);
				}
			} catch (err) {
				console.warn(`[${requestId}] Dual-agent pipeline error (continuing with base findings):`, err);
				// Fall through with existing findings
			} finally {
				clearInterval(heartbeat);
			}

			// ── Smart Dedup against GitHub PR comments ──
			// Consumes `activeVerifiedFindings` — the router/verifier survivors when
			// consensus is on, or Stage 2's verified findings when off (identical set
			// in the disabled case, preserving Property 7 disabled-equivalence).
			if (activeVerifiedFindings.length > 0) {
				console.log(`[${requestId}] Running smart dedup against PR comments...`);
				await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🔍 Running smart dedup against existing PR comments...');

				try {
					const existingThreads = await fetchPRCommentThreads(
						request.repoFullName,
						request.prNumber,
						token
					);

					// Build modified lines map from PR files (parse unified diff format)
					const modifiedLines = new Map<string, Set<number>>();
					for (const file of allFiles) {
						if (!file.patch) continue;
						const lines = new Set<number>();
						let currentLine = 0;
						for (const line of file.patch.split('\n')) {
							const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
							if (hunkMatch) {
								currentLine = parseInt(hunkMatch[1], 10);
								continue;
							}
							if (line.startsWith('+') && !line.startsWith('+++')) {
								lines.add(currentLine);
							}
							if (!line.startsWith('-')) {
								currentLine++;
							}
						}
						if (lines.size > 0) modifiedLines.set(file.filename, lines);
					}

					smartDedupResult = applySmartDedup(
						activeVerifiedFindings,
						existingThreads,
						{ modifiedLines, headSha: request.headSha }
					);

					console.log(`[${requestId}] Smart dedup: ${smartDedupResult.findingsToPost.length} to post, ${smartDedupResult.suppressedInline.length} suppressed`);
				} catch (err) {
					console.warn(`[${requestId}] Smart dedup failed (posting all findings):`, err);
					smartDedupResult = {
						findingsToPost: activeVerifiedFindings.map((f: any) => ({ finding: f, reason: 'dedup_skipped' })),
						suppressedInline: [],
						allUnresolved: activeVerifiedFindings,
					};
				}
			}
		}

		// ── Provenance tagging (R4.1) + Active_Finding_Set — Task 16 router seam ──
		// Attach Provenance to every finding source. Ground-truth findings
		// (static/plugins → `static-analysis`; supply-chain → `dependency-audit`)
		// are tagged `groundTruth:true` and ALWAYS post; the Consensus_Router passes
		// them through unchanged and never scores them (R5.2). The LLM
		// Active_Finding_Set is the Stage-1 persona findings when the dual-agent path
		// is enabled, or the MAP chunk findings otherwise — mutually exclusive today
		// (R5.1a).
		//
		// Wiring by mode:
		//   - Dual-agent path: the router/verifier already ran on the persona set
		//     BEFORE smart-dedup (replacing Stage 2), so `smartDedupResult.allUnresolved`
		//     is already the deduped router/verifier survivors. Here we simply strip.
		//   - MAP path with consensus ON: route the MAP findings HERE (there is no
		//     smart-dedup on the MAP path) and post the survivors.
		//   - Consensus OFF (either path): Provenance is INERT — attached then
		//     immediately STRIPPED — so posted output is byte-for-byte the pre-feature
		//     pipeline (R4.5, R9.1/R9.2, Property 7). No merge-by-identity/routing runs.
		// Ground-truth findings (static-analysis / plugins / dependency-audit) post
		// directly via `pluginFindings` below — they bypass consensus routing and
		// scoring entirely and are never rejected by any LLM stage (R5.2), so no
		// provenance tagging is needed for them here.
		const activeFindingSet: ProvenancedFinding[] = enableDualAgent
			? attachLLMProvenance(smartDedupResult.allUnresolved, ['security'], true)
			: attachLLMProvenance(mapFindings, ['map-chunk'], false);

		// Router/verifier survivors of the Active_Finding_Set. On the MAP path with
		// consensus ON, route the MAP findings now (the dual-agent path already routed
		// the persona set before smart-dedup). Otherwise this is the stripped
		// (provenance-inert) active set, preserving disabled-equivalence (Property 7).
		let activeSurvivors: ReviewFinding[];
		if (schedule.consensusEnabled && !enableDualAgent) {
			console.log(`[${requestId}] Consensus enabled: routing ${activeFindingSet.length} MAP findings...`);
			await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🧭 Consensus routing of MAP findings...');
			activeSurvivors = await runConsensusStage(activeFindingSet);
		} else {
			activeSurvivors = stripProvenance(activeFindingSet);
		}

		// ── Step 8: Combine and Deduplicate Findings ──
		// Ground-truth (`pluginFindings`) always posts. The LLM survivors are:
		//   - dual-agent path: the deduped router/verifier (or Stage 2) survivors;
		//   - MAP + consensus ON: the routed MAP survivors;
		//   - consensus OFF / MAP: `allFindings` (= pluginFindings + raw MAP findings),
		//     exactly the pre-feature combination (Property 7).
		let combinedFindings: ReviewFinding[];
		if (enableDualAgent && smartDedupResult.allUnresolved.length > 0) {
			combinedFindings = [...pluginFindings, ...activeSurvivors];
		} else if (schedule.consensusEnabled && !enableDualAgent) {
			combinedFindings = [...pluginFindings, ...activeSurvivors];
		} else {
			combinedFindings = allFindings;
		}

		const deduplicated = deduplicateFindings(combinedFindings);
		const modifiedFileSet = new Set(allowedFiles);
		const { filtered: deltaFiltered, suppressed: suppressedCount } = request.deepReview
			? { filtered: deduplicated, suppressed: 0 }
			: filterPreviouslyRaisedFindings(deduplicated, previousReview, modifiedFileSet);

		const clusters = clusterFindings(deltaFiltered);

		// ── Step 8: Reduce Phase — Synthesize final review & post annotations ──
		const allChunksFailed = failedChunks === chunks.length && chunks.length > 0;
		const verdict = deriveVerdict(deltaFiltered, allChunksFailed);
		const conclusion = verdictToConclusion(verdict);
		const severityCounts = countBySeverity(deltaFiltered);

		console.log(`[${requestId}] Aggregating reviews in Reduce phase (verdict: ${verdict})...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '📝 Synthesizing final review report and annotations...');

		let finalReview: string;
		let isFallback = false;

		if (allChunksFailed && deltaFiltered.length === 0) {
			const errorDetailsSection = chunkErrors.length > 0 ? `### Error Details\n\n` + chunkErrors.map((err, i) => `${i + 1}. \`${err}\``).join('\n') + '\n\n' : '';
			const affectedFilesSection = failedChunkFiles.length > 0 ? `<details>\n<summary>📂 <b>Affected Files (${failedChunkFiles.length})</b></summary>\n\n` + failedChunkFiles.map(f => `- \`${f}\``).join('\n') + '\n\n</details>\n\n' : '';
			
			finalReview = `## ❌ Review Pipeline Error\n\nAll **${chunks.length}** review chunks failed to process.\n\n` + errorDetailsSection + affectedFilesSection + `Overall verdict: **Request Changes**`;
		} else if (deltaFiltered.length === 0) {
			finalReview = formatFindingsAsMarkdown(clusters, {
				allFiles: reviewableFiles,
				prTitle: request.title,
				totalChunks: chunks.length,
				failedChunks,
				droppedFindingsCount: 0,
				failedChunkFiles,
				isFallback: false,
			});
			if (suppressedCount > 0) {
				finalReview = `> ♻️ **Re-review:** All ${suppressedCount} previously-flagged issue(s) appear to be resolved. Nice work!\n\n` + finalReview;
			}
		} else {
			const dynamicMaxTokens = Math.min(16384, 3000 + clusters.length * 300);
			const { payload: synthesizerPayload, droppedFindingsCount } = buildSynthesizerPayload(
				request.title,
				reviewableFiles,
				classified.skipped.length,
				clusters,
				chunks.length,
				failedChunks,
				failedChunkFiles,
				verdict,
				severityCounts,
				conclusion
			);

			try {
				const synthPreviousContext = formatPreviousReviewContext(previousReview);
				let synthesizerSystemPrompt = composeSynthesizerPrompt(activeProfile, webSearchActive, synthPreviousContext);
				if (request.deepReview) {
					synthesizerSystemPrompt += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nDEEP REVIEW MODE\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nYou are performing a DEEP REVIEW. The findings below include ALL potential issues (including ones previously flagged in earlier reviews). Re-evaluate each cluster with extra scrutiny. Look for:\n- Patterns and systemic issues across files\n- Architectural concerns that individual findings miss\n- Interactions between multiple findings that create compound risks\n\nDo NOT dismiss findings just because they were raised before — they were re-identified intentionally for re-evaluation. Be thorough in your synthesis.';
				}

				const result = await withTimeout(
					(sig) => callSynthesizer(
						synthesizerPayload, env, sig, synthesizerSystemPrompt, dynamicMaxTokens, webSearchActive
					),
					LLM_TIMEOUT_MS,
					'Synthesizer',
					signal
				);
				finalReview = result.review;
				llmCalls.push({
					phase: 'reduce',
					model: modelName,
					usage: result.usage,
					timestamp: new Date().toISOString(),
				});
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				console.error(`[${requestId}] Synthesizer failed, using fallback formatter:`, error);
				console.log(`[pipeline-debug] Synthesizer error: ${errMsg.slice(0, 300)}`);
				isFallback = true;
				finalReview = formatFindingsAsMarkdown(clusters, {
					allFiles: reviewableFiles,
					prTitle: request.title,
					totalChunks: chunks.length,
					failedChunks,
					droppedFindingsCount,
					failedChunkFiles,
					isFallback: true,
				});

				finalReview = `> ⚠️ **Degraded Mode:** The AI synthesizer failed (\`${errMsg}\`). This review was generated by the fallback formatter.\n\n` + finalReview;
				if (!chunkErrors.includes(`Synthesizer: ${errMsg}`)) chunkErrors.push(`Synthesizer: ${errMsg}`);
			}
		}

		// Inject metadata banners
		if ((chunks.length > 1 || failedChunks > 0) && !isFallback) {
			let banner = `> ℹ️ **Review Pipeline:** ${chunks.length} chunks processed` +
				`${failedChunks > 0 ? ` (${failedChunks} failed)` : ''}, ` +
				`${deltaFiltered.length} findings in ${clusters.length} clusters.\n\n`;

			if (failedChunks > 0 && chunkErrors.length > 0) {
				banner += `> ⚠️ **Failed chunk errors:** ${chunkErrors.map(e => `\`${e}\``).join(', ')}\n\n`;
			}
			if (suppressedCount > 0) {
				banner += `> ♻️ **Re-review:** ${suppressedCount} previously-addressed finding(s) suppressed.\n\n`;
			}
			finalReview = banner + finalReview;
		}

		// Append web search metadata if grounded search was enabled
		if (webSearchActive) {
			const allWebSearchSources: WebSearchMetadata = {
				searchQueries: [],
				sources: [],
				searchRequestCount: 0,
			};

			for (const outcome of chunkResults) {
				if (outcome && !(outcome instanceof Error) && !(outcome as any).error && (outcome as any).result?.webSearchMetadata) {
					const meta = (outcome as any).result.webSearchMetadata as WebSearchMetadata;
					allWebSearchSources.searchQueries.push(...meta.searchQueries);
					allWebSearchSources.sources.push(...meta.sources);
					allWebSearchSources.searchRequestCount += meta.searchRequestCount;
				}
			}

			const sourcesSection = formatSearchSources(allWebSearchSources);
			if (sourcesSection) finalReview += sourcesSection;

			if (allWebSearchSources.sources.length > 0) {
				await cacheSearchSources(request.repoFullName, allWebSearchSources.sources, env.CACHE_KV).catch((e) =>
					console.warn('Failed to cache search sources', e)
				);
			}
		}

		// ── Step 9: Post review with inline comments to GitHub ──
		const inlineComments: InlineReviewComment[] = [];
		const filePatchMap = new Map<string, string>();
		for (const file of [...classified.tier1, ...classified.tier2]) {
			if (file.patch) filePatchMap.set(file.filename, file.patch);
		}

		for (const finding of deltaFiltered) {
			if (
				(finding.severity === 'critical' || finding.severity === 'high') &&
				finding.file &&
				finding.line &&
				finding.line > 0 &&
				filePatchMap.has(finding.file)
			) {
				const emoji = finding.severity === 'critical' ? '🔴' : '🟠';
				let commentBody = `${emoji} **${finding.severity.toUpperCase()}** — ${finding.title}\n\n${finding.issue}`;
				inlineComments.push({
					path: finding.file,
					line: finding.line,
					body: commentBody,
				});
			}
		}

		const reviewEvent = verdict === 'approve' ? 'APPROVE' as const : verdict === 'request_changes' ? 'REQUEST_CHANGES' as const : 'COMMENT' as const;

		// ── Surface any graphify degradation in the posted review (R12) ──
		// Appended (never replaces content); wrapped so it can't block posting.
		try {
			const graphNotice = graphifyResult?.context.reviewNotice();
			if (graphNotice) {
				finalReview += `\n\n---\n> ℹ️ ${graphNotice}`;
			}
		} catch (noticeErr) {
			console.warn(`[${requestId}] Failed to append graphify notice (non-fatal):`, noticeErr);
		}

		try {
			await postPRReview(
				request.repoFullName,
				request.prNumber,
				token,
				reviewEvent,
				finalReview,
				inlineComments,
				filePatchMap
			);
			console.log(`[${requestId}] GitHub PR review posted successfully with ${inlineComments.length} inline comments.`);
		} catch (err) {
			console.warn(`[${requestId}] Reviews API failed, posting issue comment as fallback...`, err);
			await postPRComment(request.repoFullName, request.prNumber, finalReview, token);
		}

		// ── Step 10: Update Check Run with Final Conclusion ──
		if (request.checkRunId) {
			await updateCheckRun(request.repoFullName, request.checkRunId, token, conclusion, finalReview);
		}

		// ── Step 11: Zoho Cliq Notifications ──
		if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
			await postToCliq(
				env.CLIQ_CLIENT_ID,
				env.CLIQ_CLIENT_SECRET,
				env.CLIQ_REFRESH_TOKEN,
				env.CLIQ_BOT_NAME,
				env.CLIQ_CHANNEL_ID,
				request.repoFullName,
				request.prNumber,
				request.title,
				request.prAuthor,
				conclusion,
				severityCounts,
				env.CLIQ_DB_NAME,
				chunkErrors
			);
		}

		// ── Step 12: Record Usage Metrics ──
		if (llmCalls.length > 0) {
			try {
				const usageMetrics = buildPRUsageMetrics(
					request.prNumber,
					request.repoFullName,
					request.headSha,
					provider,
					startTime,
					llmCalls,
					reviewableFiles.length,
					chunks.length,
					deduplicated.length,
					allChunksFailed ? 'failed' : failedChunks > 0 ? 'partial' : 'success'
				);
				await storePRUsageMetrics(usageMetrics, env);
			} catch (err) {
				console.warn('Failed to record usage metrics (non-fatal):', err);
			}
		}

		// Mark review as completed to prevent duplicate reviews on retries
		const completionKey = `review_completed:${request.repoFullName}:${request.prNumber}:${request.headSha}`;
		const dedupValue = JSON.stringify({ completed: true, conclusion });
		await env.DEDUP_KV.put(completionKey, dedupValue, { expirationTtl: 86400 }).catch(e => {
			console.warn('Failed to store completion key (non-fatal):', e);
		});

		return {
			staticFindings,
			blastRadius,
			metrics: { ...metrics, totalTimeMs: Date.now() - totalStart },
		};

	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(`[${requestId}] Pipeline critical sandbox execution failure:`, err);

		// Notify Zoho Cliq on critical crashes
		if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
			try {
				await postToCliq(
					env.CLIQ_CLIENT_ID,
					env.CLIQ_CLIENT_SECRET,
					env.CLIQ_REFRESH_TOKEN,
					env.CLIQ_BOT_NAME,
					env.CLIQ_CHANNEL_ID,
					request.repoFullName,
					request.prNumber,
					request.title,
					request.prAuthor,
					'failure',
					{ critical: 0, high: 0, medium: 0, low: 0 },
					env.CLIQ_DB_NAME,
					[errMsg]
				);
			} catch (cliqErr) {
				console.error('Failed to notify Zoho Cliq on outer error:', cliqErr);
			}
		}

		// Update Check Run with failure details
		if (request.checkRunId) {
			// Append any graphify degradation notice even on the sandbox-error path (R12.5).
			let graphNoticeSuffix = '';
			try {
				const graphNotice = graphifyResult?.context.reviewNotice();
				if (graphNotice) graphNoticeSuffix = `\n\n---\n> ℹ️ ${graphNotice}`;
			} catch { /* non-fatal */ }
			try {
				await updateCheckRun(
					request.repoFullName,
					request.checkRunId,
					token,
					'failure',
					`## ❌ Review Pipeline Sandbox Error\n\n**Error:** \`${errMsg}\`\n\n` +
					`Please close and reopen the PR to trigger another review.` +
					graphNoticeSuffix
				);
			} catch (chRunErr) {
				console.error('Failed to update Check Run on crash:', chRunErr);
			}
		}

		throw err;
	} finally {
		// ── Clean sandbox environment ──
		await cleanup(workDir);
		// Also remove the out-of-repo graphify output dir (`<workDir>-gfx`) so a
		// reused container does not accumulate stale graphs (R3.8b).
		await cleanup(graphifyOutParentFor(workDir));
	}
}

/**
 * Builds the JSON payload for the synthesizer LLM.
 */
function buildSynthesizerPayload(
	prTitle: string,
	allFiles: string[],
	skippedCount: number,
	clusters: any[],
	totalChunks: number,
	failedChunks: number,
	failedChunkFiles: string[],
	verdict: string,
	severityCounts: any,
	conclusion: string
): { payload: string; droppedFindingsCount: number } {
	const allAnnotated: any[] = [];
	for (const cluster of clusters) {
		const isMultiFile = new Set(cluster.findings.map((f: any) => f.file)).size > 1;
		const fileCount = new Set(cluster.findings.map((f: any) => f.file)).size;

		for (let i = 0; i < cluster.findings.length; i++) {
			const f = cluster.findings[i];
			const notes: string[] = [];

			if (cluster.groupReason === 'similar-pattern' && isMultiFile && i === 0) {
				notes.push(`🔄 This pattern repeats across ${fileCount} files — consider a systematic fix`);
			}

			allAnnotated.push({
				severity: f.severity,
				file: f.file,
				line: f.line,
				title: f.title,
				issue: f.issue,
				currentCode: f.currentCode,
				category: f.category,
				...(notes.length > 0 ? { annotations: notes } : {}),
			});
		}
	}

	const SEVERITY_SORT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
	allAnnotated.sort((a, b) => {
		const sevDiff = (SEVERITY_SORT[a.severity] ?? 3) - (SEVERITY_SORT[b.severity] ?? 3);
		if (sevDiff !== 0) return sevDiff;
		return a.file.localeCompare(b.file);
	});

	const input = {
		prTitle,
		allFiles,
		skippedCount,
		findings: allAnnotated,
		totalFindingsCount: allAnnotated.length,
		totalChunks,
		failedChunks,
		droppedFindingsCount: 0,
		failedChunkFiles,
		verdict,
		severityCounts,
		conclusion,
	};

	return {
		payload: JSON.stringify(input),
		droppedFindingsCount: 0,
	};
}
