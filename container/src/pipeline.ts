import { v4 as uuidv4 } from 'uuid';
import { readFile, access as fsAccess } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { cloneRepository, cleanup } from './git-ops.js';
import { buildBlastRadius } from './ast-graph.js';
import { runStaticAnalysis } from './static-analysis.js';
import type { ReviewRequest, ReviewResponse, ReviewMetrics } from './types.js';
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
import { fetchRepoConfig, buildCustomRulesPrompt, applyConfigOverrides, shouldIgnore } from './lib/repo-config.js';
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
import { initializeTracing } from './lib/observability/tracer.js';
import { runStage1Review, runStage2Verification } from './lib/llm/dual-agent.js';
import { fetchPRCommentThreads, applySmartDedup } from './lib/smart-dedup.js';
import {
	DEFAULT_AI_PROVIDER,
	MAX_CHUNK_CHARS,
} from './config/constants.js';
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
 * Build Gate — runs the project's compile/build step before spending LLM tokens.
 * If the build fails, the pipeline terminates cleanly with buildFailed: true,
 * posts error logs to GitHub Check Run and Zoho Cliq, and returns early
 * without consuming any LLM budget.
 */
async function runBuildGate(
	workDir: string,
	repoFullName: string,
	checkRunId: number | undefined,
	token: string,
	signal?: AbortSignal
): Promise<{ success: true } | { success: false; errorLog: string }> {
	console.log(`[build-gate] Running build compilation check...`);

	// Detect package manager and install dependencies
	let installCmd: string[];
	if (await fsAccess(join(workDir, 'yarn.lock')).then(() => true).catch(() => false)) {
		installCmd = ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'];
	} else if (await fsAccess(join(workDir, 'pnpm-lock.yaml')).then(() => true).catch(() => false)) {
		installCmd = ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'];
	} else {
		installCmd = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
	}

	try {
		console.log(`[build-gate] Installing dependencies: ${installCmd.join(' ')}`);
		await execa(installCmd[0], installCmd.slice(1), {
			cwd: workDir,
			timeout: 180_000,
			cancelSignal: signal,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[build-gate] Dependency install failed (non-fatal, attempting build anyway): ${msg}`);
	}

	// Run build
	try {
		const buildResult = await execa('npm', ['run', 'build', '--if-present'], {
			cwd: workDir,
			timeout: 300_000,
			cancelSignal: signal,
			reject: false,
		});

		if (buildResult.exitCode !== 0 && buildResult.exitCode !== null) {
			const errorLog = (buildResult.stderr || buildResult.stdout || 'Build failed with unknown error').slice(0, 50000);
			console.error(`[build-gate] Build FAILED (exit code ${buildResult.exitCode})`);

			// Post to Check Run
			if (checkRunId) {
				try {
					await updateCheckRun(
						repoFullName,
						checkRunId,
						token,
						'failure',
						`## ❌ Build Failed\n\n\`\`\`\n${errorLog.slice(0, 30000)}\n\`\`\`\n\nReview pipeline terminated — zero LLM tokens spent.`
					);
				} catch { /* best-effort */ }
			}

			return { success: false, errorLog };
		}

		// Prune /tmp to free disk space (Architecture §8.3)
		await execa('sh', ['-c', 'rm -rf /tmp/*'], { timeout: 30_000 }).catch(() => {});
		console.log(`[build-gate] Build passed successfully.`);
		return { success: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Timeout or abort — treat as failure
		// Prune /tmp to free disk space (Architecture §8.3)
		await execa('sh', ['-c', 'rm -rf /tmp/*'], { timeout: 30_000 }).catch(() => {});
		if (checkRunId) {
			try {
				await updateCheckRun(
					repoFullName,
					checkRunId,
					token,
					'failure',
					`## ⏰ Build Timed Out\n\n\`\`\`\n${msg}\n\`\`\`\n\nReview pipeline terminated.`
				);
			} catch { /* best-effort */ }
		}
		return { success: false, errorLog: msg };
	}
}

/**
 * Graphify Indexing — runs the Graphify AST knowledge graph builder
 * on the checked-out workspace. Injects the graph data as context
 * for the review coordinators.
 */
async function runGraphifyIndexing(
	workDir: string,
	signal?: AbortSignal
): Promise<{ graphJson: any | null; graphContext: string }> {
	console.log(`[graphify] Running graphify AST indexing...`);
	try {
		const result = await execa('graphify', ['.', '--output', join(workDir, 'graphify-out')], {
			cwd: workDir,
			timeout: 120_000,
			cancelSignal: signal,
			reject: false,
		});

		if (result.exitCode !== 0) {
			console.warn(`[graphify] graphify exited with code ${result.exitCode}: ${result.stderr?.slice(0, 500)}`);
			return { graphJson: null, graphContext: '' };
		}

		const graphJsonPath = join(workDir, 'graphify-out', 'graph.json');
		let graphJson: any = null;
		try {
			const content = await readFile(graphJsonPath, 'utf-8');
			graphJson = JSON.parse(content);
		} catch (err) {
			console.warn(`[graphify] Failed to read graph.json:`, err);
			return { graphJson: null, graphContext: '' };
		}

		const nodeCount = graphJson.nodes?.length || 0;
		const edgeCount = graphJson.edges?.length || 0;

		const graphContext = `\n\n## Graphify AST Knowledge Graph\n- Total nodes: ${nodeCount}\n- Total edges: ${edgeCount}\n- Changed files indexed: ${graphJson.metadata?.changedFiles?.length || 0}\n- God nodes (highly connected): ${(graphJson.godNodes || []).map((n: any) => n.name).join(', ')}\n`;
		console.log(`[graphify] Graph generated: ${nodeCount} nodes, ${edgeCount} edges`);
		return { graphJson, graphContext };
	} catch (err) {
		console.warn(`[graphify] graphify execution failed:`, err);
		return { graphJson: null, graphContext: '' };
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
		CLIQ_CLIENT_ID: process.env.CLIQ_CLIENT_ID || '',
		CLIQ_CLIENT_SECRET: process.env.CLIQ_CLIENT_SECRET || '',
		CLIQ_REFRESH_TOKEN: process.env.CLIQ_REFRESH_TOKEN || '',
		CLIQ_BOT_NAME: process.env.CLIQ_BOT_NAME || '',
		CLIQ_CHANNEL_ID: process.env.CLIQ_CHANNEL_ID || '',
		CLIQ_DB_NAME: process.env.CLIQ_DB_NAME || '',
	};

	// ── Step 0.1: Idempotency Guard ──
	const dedupKey = `review_completed:${request.repoFullName}:${request.prNumber}:${request.headSha}`;
	const isAlreadyCompleted = await env.DEDUP_KV.get(dedupKey).catch(e => {
		console.warn('Failed to check completion key (non-fatal):', e);
		return null;
	});
	if (isAlreadyCompleted === 'true') {
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
		const repoConfig = await fetchRepoConfig(request.repoFullName, token, env.CACHE_KV);

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

		// ── Build Gate: Compile check before LLM token spend ──
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🔨 Running build compilation check...');
		const buildGateResult = await runBuildGate(workDir, request.repoFullName, request.checkRunId, token, signal);
		if (!buildGateResult.success) {
			console.log(`[${requestId}] Build gate FAILED. Terminating pipeline — zero LLM tokens spent.`);
			// Post Cliq failure alert
			if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
				try {
					await postToCliq(
						env.CLIQ_CLIENT_ID, env.CLIQ_CLIENT_SECRET, env.CLIQ_REFRESH_TOKEN,
						env.CLIQ_BOT_NAME, env.CLIQ_CHANNEL_ID,
						request.repoFullName, request.prNumber, request.title, request.prAuthor,
						'failure',
						{ critical: 0, high: 0, medium: 0, low: 0 },
						env.CLIQ_DB_NAME,
						[`Build failed: ${buildGateResult.errorLog.slice(0, 500)}`]
					);
				} catch { /* best-effort */ }
			}
			// Return 200 OK — do NOT throw, prevent queue retry
			return {
				staticFindings: [],
				blastRadius: { changedFiles: [], impactedFiles: [], changedSymbols: [], impactedSymbols: [] },
				metrics: { ...metrics, totalTimeMs: Date.now() - totalStart },
				buildFailed: true,
				buildErrorLog: buildGateResult.errorLog,
			};
		}

		console.log(`[${requestId}] Building AST dependency graph via Tree-Sitter...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🌳 Building Deep Dependency Graph via Tree-Sitter AST...');
		const parseStart = Date.now();
		const blastRadius = await buildBlastRadius(workDir, existingAllowedFiles);
		metrics.parseTimeMs = Date.now() - parseStart;
		metrics.symbolsTracked = blastRadius.changedSymbols.length + blastRadius.impactedSymbols.length;
		console.log(`[${requestId}] AST parsed in ${metrics.parseTimeMs}ms — ${metrics.symbolsTracked} symbols tracked`);

		console.log(`[${requestId}] Running security & linting tools...`);
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🛡️ Executing Ground-Truth Security & Linting Tools...');
		const staticStart = Date.now();
		const staticFindings = await runStaticAnalysis(workDir, existingAllowedFiles, signal);
		metrics.staticAnalysisTimeMs = Date.now() - staticStart;
		console.log(`[${requestId}] Static analysis done in ${metrics.staticAnalysisTimeMs}ms — ${staticFindings.length} findings`);

		// ── Graphify AST Knowledge Graph Indexing ──
		await updateCheckRunProgress(request.repoFullName, request.checkRunId, token, '🗺️ Indexing codebase AST via Graphify...');
		const { graphJson, graphContext: graphifyContext } = await runGraphifyIndexing(workDir, signal);

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

		const containerBlastRadiusText = `\n\n## Container Blast Radius Analysis\nChanged files: ${blastRadius.changedFiles.length}\nImpacted files: ${blastRadius.impactedFiles.length}\nChanged symbols: ${blastRadius.changedSymbols.map((s) => `${s.kind} ${s.name}`).join(', ')}` + graphifyContext;

		// ── Step 5: Build review chunks ──
		const { chunks, chunkFileMap, globalContext, allFiles: reviewableFiles, pluginFindings } =
			await buildReviewChunks(classified, token, MAX_CHUNK_CHARS, env, {
				title: request.title,
				repoFullName: request.repoFullName,
				prNumber: request.prNumber
			}, containerBlastRadiusText);

		// Combine AST/SAST results into pluginFindings
		pluginFindings.push(...mappedStaticFindings);

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
		const enableDualAgent = process.env.ENABLE_DUAL_AGENT === 'true';

		let stage1Results = { findings: [] as any[], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, personaResults: [] as any[] };
		let stage2Results = { verifiedFindings: [] as any[], rejectedFindings: [] as any[], stats: { totalEvaluated: 0, verified: 0, rejected: 0 }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
		let smartDedupResult = { findingsToPost: [] as any[], suppressedInline: [] as any[], allUnresolved: [] as any[] };

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

				// ── Stage 2: Verification with Gemini Flash ──
				if (stage1Results.findings.length > 0) {
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

					console.log(`[${requestId}] Stage 2 complete: ${stage2Results.stats.verified} verified, ${stage2Results.stats.rejected} rejected`);
				}
			} catch (err) {
				console.warn(`[${requestId}] Dual-agent pipeline error (continuing with base findings):`, err);
				// Fall through with existing findings
			} finally {
				clearInterval(heartbeat);
			}

			// ── Smart Dedup against GitHub PR comments ──
			if (stage2Results.verifiedFindings.length > 0) {
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
						stage2Results.verifiedFindings,
						existingThreads,
						{ modifiedLines, headSha: request.headSha }
					);

					console.log(`[${requestId}] Smart dedup: ${smartDedupResult.findingsToPost.length} to post, ${smartDedupResult.suppressedInline.length} suppressed`);
				} catch (err) {
					console.warn(`[${requestId}] Smart dedup failed (posting all findings):`, err);
					smartDedupResult = {
						findingsToPost: stage2Results.verifiedFindings.map((f: any) => ({ finding: f, reason: 'dedup_skipped' })),
						suppressedInline: [],
						allUnresolved: stage2Results.verifiedFindings,
					};
				}
			}
		}

		// ── Step 8: Combine and Deduplicate Findings ──
		// If dual-agent was active, use Stage 2 verified findings; otherwise use chunk review findings
		const combinedFindings = enableDualAgent && smartDedupResult.allUnresolved.length > 0
			? [...pluginFindings, ...smartDedupResult.allUnresolved]
			: allFindings;

		const deduplicated = deduplicateFindings(combinedFindings);
		const modifiedFileSet = new Set(allowedFiles);
		const { filtered: deltaFiltered, suppressed: suppressedCount } =
			filterPreviouslyRaisedFindings(deduplicated, previousReview, modifiedFileSet);

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
				const synthesizerSystemPrompt = composeSynthesizerPrompt(activeProfile, webSearchActive, synthPreviousContext);

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
		await env.DEDUP_KV.put(completionKey, 'true', { expirationTtl: 86400 }).catch(e => {
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
			try {
				await updateCheckRun(
					request.repoFullName,
					request.checkRunId,
					token,
					'failure',
					`## ❌ Review Pipeline Sandbox Error\n\n**Error:** \`${errMsg}\`\n\n` +
					`Please close and reopen the PR to trigger another review.`
				);
			} catch (chRunErr) {
				console.error('Failed to update Check Run on crash:', chRunErr);
			}
		}

		throw err;
	} finally {
		// ── Clean sandbox environment ──
		await cleanup(workDir);
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
