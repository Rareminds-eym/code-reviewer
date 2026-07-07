# Migration Plan: Consolidate into Cloudflare Container

**Status:** Proposed  
**Target:** Move ALL business logic from Edge Worker into the Cloudflare Container, leaving the Worker as a thin proxy.  
**Rationale:** Eliminate 50-subrequest cap, remove 30s CPU timeout, simplify dual-compute architecture, delete ~50% of code.

---

## Table of Contents

1. [Architecture Comparison](#1-architecture-comparison)
2. [Why Now? (2026 Container GA)](#2-why-now-2026-container-ga)
3. [Migration Phases](#3-migration-phases)
   - [Phase 0 — Prerequisites](#phase-0--prerequisites)
   - [Phase 1 — Merge Dependencies](#phase-1--merge-dependencies)
   - [Phase 2 — KV Proxy on Worker](#phase-2--kv-proxy-on-worker)
   - [Phase 3 — Rewrite Container Server](#phase-3--rewrite-container-server)
   - [Phase 4 — Build Unified Pipeline](#phase-4--build-unified-pipeline)
   - [Phase 5 — Simplify Worker](#phase-5--simplify-worker)
   - [Phase 6 — Delete Phase](#phase-6--delete-phase)
   - [Phase 7 — Config Changes](#phase-7--config-changes)
   - [Phase 8 — Phased Rollout](#phase-8--phased-rollout)
4. [File Movement Map](#4-file-movement-map)
5. [Cost Impact](#5-cost-impact)
6. [Risk Mitigation](#6-risk-mitigation)
7. [Rollback Plan](#7-rollback-plan)
8. [Gap Analysis](#8-gap-analysis)

---

## 1. Architecture Comparison

### Current (Dual-Compute)

```
GitHub Webhook
  │
  ▼
┌──────────────────────────────────────────────────────┐
│  Edge Worker (src/index.ts + src/handlers/queue.ts)  │
│                                                      │
│  fetch() handler:                                    │
│  ├─ Verify HMAC-SHA256                               │
│  ├─ Dedup check → DEDUP_KV                          │
│  ├─ Filter PR action, draft, branch                  │
│  ├─ Get GitHub App JWT token → AUTH_KV              │
│  ├─ Create "in_progress" Check Run                   │
│  ├─ Enqueue to Cloudflare Queue                     │
│  └─ Return 202                                       │
│                                                      │
│  queue() handler (~1400 lines):                      │
│  ├─ Service level / degradation check                │
│  ├─ Adaptive concurrency throttling                  │
│  ├─ SubrequestBudget bookkeeping                     │
│  ├─ [TRY] Container review (git clone, AST, SAST)    │
│  │   └─ On failure → fallback to in-worker           │
│  ├─ Fetch repo config (.codereview.yml)               │
│  ├─ Fetch previous review findings                   │
│  ├─ Detect tech stack                                │
│  ├─ Classify files, build chunks                     │
│  ├─ MAP Phase: LLM calls (MAX_LLM_CHUNKS=50 cap)    │
│  │   ├─ Circuit breaker check                        │
│  │   ├─ Rate limiter acquire                          │
│  │   ├─ Cost breaker check                           │
│  │   ├─ retryWithBackoff()                            │
│  │   └─ Web search grounding                          │
│  ├─ Cluster findings                                 │
│  ├─ Delta detection                                   │
│  ├─ REDUCE Phase: LLM synthesis                       │
│  │   └─ Tiered fallback: Claude ↔ Gemini             │
│  ├─ Derive verdict, format output                     │
│  ├─ Post to GitHub (Check Run, PR Review, Comment)    │
│  ├─ Send Cliq notification                            │
│  └─ Track usage metrics → USAGE_METRICS KV           │
└──────────────────┬───────────────────────────────────┘
                   │
         ┌─────────▼─────────┐
         │  Cloudflare Queue  │
         │  (async buffer)    │
         └─────────┬─────────┘
                   │
         ┌─────────▼─────────┐
         │  Container (Docker)│
         │  git clone         │
         │  tree-sitter AST   │
         │  oxlint/biome/     │
         │  semgrep           │
         └───────────────────┘
```

### Target (Container-Unified)

```
GitHub Webhook
  │
  ▼
┌────────────────────────────────────────────┐
│  Thin Edge Worker (~150 lines)             │
│                                            │
│  POST / → verify HMAC, dedup,              │
│           forward to container, return 202  │
│  GET /health → lightweight health check    │
│  GET/POST /dashboard/* → dashboard UI      │
│  outboundByHost → KV proxy for container   │
│  (NO queue handler, NO queue.ts file)       │
└──────────────────┬─────────────────────────┘
                   │ container.fetch()
         ┌─────────▼─────────────────────────────┐
         │  Container (Docker, Node.js + Hono)   │
         │                                       │
         │  One process, infinite subrequests:   │
         │                                       │
         │  1. shallow git clone (existing)       │
         │  2. git diff → changed files           │
         │  3. tree-sitter AST → blast radius     │
         │  4. oxlint + biome + semgrep           │
         │  5. Tech stack detection               │
         │  6. Fetch .codereview.yml               │
         │  7. Fetch previous review (GitHub API)  │
         │  8. Classify files, build chunks        │
         │  9. MAP: LLM calls (UNLIMITED chunks)  │
         │ 10. Jaccard similarity clustering       │
         │ 11. Delta: filter prior findings        │
         │ 12. REDUCE: LLM synthesis               │
         │ 13. Post Check Run + annotations        │
         │ 14. Post PR Review / Comment            │
         │ 15. Zoho Cliq notification              │
         │ 16. Usage tracking → KV proxy           │
         │ 17. Cleanup tmp dir                     │
         └────────────────────────────────────────┘
```

### What Changes

| Aspect | Current | Target | Benefit |
|--------|---------|--------|---------|
| **Subrequest cap** | 50 per invocation | None (container) | No chunk limits, no `SubrequestBudget` |
| **CPU time** | 30s limit (paid) | Unlimited (active-CPU billing) | Large PRs not truncated |
| **Memory** | 128 MB (paid) | 4-12 GB | Clustering + LLM parsing not squeezed |
| **Chunk limit** | `MAX_LLM_CHUNKS=50` | Unlimited | Full PR coverage always |
| **Cold start** | <5ms (Worker) | 1-3s (Container) | Acceptable — 202 response already sent |
| **Git clone** | Only in container | Same | No change |
| **Queue** | Required | Deleted | ~$0 cost, simpler topology |
| **Dual-compute** | Container + fallback | One runtime | ~1400 lines → ~0 lines |
| **Code complexity** | Budgets, fallbacks, hedging | Straight pipeline | ~50% less code |

---

## 2. Why Now? (2026 Container GA)

Checked against Cloudflare docs (June 2026):

- **Containers GA** since April 2026 — production-ready, no beta limitations
- **Active-CPU pricing** — pay only for CPU cycles used, not wall-clock time
- **Outbound Workers (`outboundByHost`)** — containers can call Worker bindings (KV/R2/D1) via virtual hostnames in-process (critical for this migration)
- **`ContainerProxy` export** — required Worker-side export for outbound interception to work
- **Docker Hub support** — use any base image
- **Higher limits** — up to 4 vCPU, 12 GB, 20 GB disk per instance
- **400 GiB concurrent memory / 100 vCPU / 2 TB disk** per account — sufficient for 66 concurrent `standard-2` instances (plan uses max 20)
- **SSH support** — debug live containers
- **No per-instance time limit** — containers run indefinitely (until `sleepAfter` fires or host restarts)

---

## 3. Migration Phases

### Phase 0 — Prerequisites

**No code changes.** Verify the foundation:

- [ ] Container uses `node:20-alpine` (already done)
- [ ] Container`enableInternet = true` (already done)
- [ ] Container has `fetch` global (Node 20+ has it natively)
- [ ] All Worker lib code uses only HTTP + pure TypeScript (verified: yes)
- [ ] Confirm your Workers Paid plan allows up to 10M subrequests (already increased by Cloudflare in 2025; confirm in dashboard)

### Phase 1 — Merge Dependencies

Merge root `package.json` dependencies into `container/package.json`:

**Root `package.json` deps (to merge into container):**
```json
{
  "@cloudflare/containers": "^0.3.2",     // Already in root Worker only — NOT needed in container
  "@opentelemetry/api": "^1.9.1"           // Already available in container via npm
}
```

**New container `package.json` after merge:**
```json
{
  "dependencies": {
    "@hono/node-server": "^1.19.14",
    "hono": "^4.7.0",
    "execa": "^9.5.0",
    "tree-sitter": "^0.22.0",
    "tree-sitter-typescript": "^0.23.0",
    "uuid": "^11.1.0",
    "@opentelemetry/api": "^1.9.1"
  }
}
```

The Worker code does NOT use any Cloudflare-runtime-specific SDKs — all HTTP calls use the global `fetch()` which exists in both Workers and Node 20+. No Anthropic SDK, no Google SDK — just raw `fetch`.

> **Important:** `@cloudflare/containers` is a Worker-side library (for DO Container class). The container itself never imports it.

### Phase 2 — KV Access via `outboundByHost`

Cloudflare provides a first-class `outboundByHost` mechanism for containers to access Worker bindings (KV, R2, D1) without building a custom proxy endpoint. This is **in-process** communication via the Cloudflare runtime — no public HTTP endpoint, no shared secret, no network hop.

**File: `src/container-class.ts`** — add static `outboundByHost` handler:

```typescript
import { Container, ContainerProxy } from '@cloudflare/containers';
import type { Env } from './types/env';

export class ReviewContainer extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';
  enableInternet = true;

  override onStart(): void {
    console.log('[ReviewContainer] Container instance started');
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.log('[ReviewContainer] Container instance stopped', { exitCode, reason });
  }

  override onError(error: unknown): void {
    console.error('[ReviewContainer] Container instance error', error);
    throw error;
  }
}

// Static outbound handlers — intercept container's HTTP calls to virtual hostnames
ReviewContainer.outboundByHost = {
  'kv.internal': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const [, namespace, action] = url.pathname.split('/');
    const key = url.searchParams.get('key') ?? '';

    const kvMap: Record<string, KVNamespace> = {
      USAGE_METRICS: env.USAGE_METRICS,
      AUTH_KV: env.AUTH_KV,
      CACHE_KV: env.CACHE_KV,
      DEDUP_KV: env.DEDUP_KV,
    };
    const kv = kvMap[namespace];
    if (!kv) return new Response('Unknown namespace', { status: 400 });

    if (action === 'get') {
      const val = await kv.get(key);
      return new Response(val ?? '', { status: val ? 200 : 404 });
    }
    if (action === 'put') {
      const body = await request.text();
      const ttl = parseInt(url.searchParams.get('ttl') ?? '0');
      await kv.put(key, body, ttl ? { expirationTtl: ttl } : undefined);
      return new Response('ok');
    }
    if (action === 'delete') {
      await kv.delete(key);
      return new Response('ok');
    }
    if (action === 'list') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = await kv.list({ prefix });
      return new Response(JSON.stringify(keys));
    }
    return new Response('Unknown action', { status: 400 });
  },
};

// CRITICAL: Must export ContainerProxy for outbound interception to work
export { ContainerProxy };
```

**Container-side usage** — standard `fetch` to virtual hostname (replaces custom kv-proxy.ts):
```typescript
// In container — just use standard fetch to a virtual hostname
const value = await fetch('http://kv.internal/CACHE_KV/get?key=my-key').then(r => r.text());
await fetch('http://kv.internal/USAGE_METRICS/put?key=k&ttl=3600', { method: 'POST', body: val });
await fetch('http://kv.internal/DEDUP_KV/delete?key=k', { method: 'POST' });
```

**Why this is better than a custom proxy:**
- No `PROXY_SECRET` or `PROXY_BASE` — no secrets to manage
- No `/proxy/kv` endpoint exposed on the public internet
- No network hop — runs in the same V8 isolate as the Container class
- No custom proxy handler code to maintain

> **⚠️ CRITICAL:** `src/index.ts` must `export { ContainerProxy }` alongside `export { ReviewContainer }`. Without this, outbound interception silently fails.

### Phase 3 — Rewrite Container Server

**File: `container/src/server.ts`** (rewrite from 64 lines to ~100 lines)

```typescript
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { runReviewPipeline } from './pipeline.js';
import type { ReviewRequest } from './types.js';

const app = new Hono();
app.use('*', honoLogger());

// ── Graceful shutdown state ──
let isShuttingDown = false;
const activeReviews = new Set<string>();

// ── Health check ──
app.get('/ping', (c) => {
  if (isShuttingDown) return c.text('draining', 503);
  return c.text('pong');
});

// ── Main review endpoint (receives payload from Worker) ──
app.post('/review', async (c) => {
  if (isShuttingDown) {
    return c.json({ error: 'Server is shutting down, retry on another instance' }, 503);
  }

  const startTime = Date.now();
  let request: ReviewRequest;
  try {
    request = await c.req.json<ReviewRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!request.repoFullName || !request.prNumber || !request.installationToken) {
    return c.json({ error: 'Missing required fields' }, 400);
  }

  const requestId = request.requestId || `container-${Date.now()}`;
  const reviewKey = `${request.repoFullName}#${request.prNumber}`;
  activeReviews.add(reviewKey);
  console.log(`[${requestId}] Starting unified review for ${reviewKey}`);

  try {
    const response = await runReviewPipeline(request, requestId);
    console.log(`[${requestId}] Review completed in ${Date.now() - startTime}ms`);
    return c.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${requestId}] Pipeline failed:`, errMsg);
    return c.json({ error: 'Pipeline failed', message: errMsg, requestId }, 500);
  } finally {
    activeReviews.delete(reviewKey);
    if (isShuttingDown && activeReviews.size === 0) {
      console.log('[ReviewContainer] All reviews drained, exiting');
      process.exit(0);
    }
  }
});

// ── SIGTERM handler — drain in-flight reviews before exiting ──
process.on('SIGTERM', () => {
  console.log(`[ReviewContainer] SIGTERM received, draining ${activeReviews.size} active reviews...`);
  isShuttingDown = true;
  if (activeReviews.size === 0) {
    process.exit(0);
  }
  // Force exit after 14 minutes (Cloudflare gives 15min grace period)
  setTimeout(() => {
    console.error('[ReviewContainer] Forced shutdown after drain timeout');
    process.exit(1);
  }, 14 * 60 * 1000);
});

// ── Start server ──
import { serve } from '@hono/node-server';
const port = parseInt(process.env.PORT || '3000', 10);
console.log(`[ReviewContainer] Starting on port ${port}`);
serve({ fetch: app.fetch, port });
```

### Phase 4 — Build Unified Pipeline

**File: `container/src/pipeline.ts`** (rewrite from 138 lines to integrate all phases)

This is the heart of the migration. Merge the existing container pipeline (clone → AST → static analysis) with all the worker-side logic from `src/handlers/queue.ts`.

#### Step-by-step pipeline

```typescript
// container/src/pipeline.ts
import { v4 as uuidv4 } from 'uuid';
import { cloneRepository, getChangedFiles, cleanup } from './git-ops.js';
import { buildBlastRadius } from './ast-graph.js';
import { runStaticAnalysis } from './static-analysis.js';
import { detectTechStack } from './stack-detector.js';
import { fetchRepoConfig, applyConfigOverrides, shouldIgnore } from './repo-config.js';
import { fetchPreviousReviewFindings, formatPreviousReviewContext } from './previous-review.js';
import { filterPreviouslyRaisedFindings } from './review-delta.js';
import { classifyFiles, buildReviewChunks, postPRComment, postPRReview, updateCheckRun } from './github.js';
import { composeChunkPrompt, composeSynthesizerPrompt } from './config/prompts/composer.js';
import { callChunkReview, callSynthesizer, getModelName } from './llm/index.js';
import { clusterFindings } from './finding-clusters.js';
import { deriveVerdict, verdictToConclusion, countBySeverity } from './verdict.js';
import { formatFindingsAsMarkdown } from './review-formatter.js';
import { postToCliq } from './cliq.js';
import { buildPRUsageMetrics, storePRUsageMetrics } from './usage-tracker.js';
import { getInstallationToken } from './github-auth.js';
import type { ReviewRequest, ReviewResponse, ReviewMetrics } from './types.js';

// ⚠️ G43 NOTE: github-auth.ts uses crypto.subtle.importKey('pkcs8').
// In Node.js 20, this ONLY accepts PKCS#8 PEM format.
// GitHub generates PKCS#1 keys by default. Either:
//   A) Convert key: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
//   B) Add PKCS#1 auto-detection in importPrivateKey() using node:crypto

/**
 * Concurrency-limited Promise executor.
 * Prevents mass 429 errors from LLM providers by limiting parallel requests.
 * Unlike Promise.allSettled(), this uses a sliding window.
 */
async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  maxConcurrent: number = 5
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        const value = await tasks[i]();
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrent, tasks.length) },
    () => runNext()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Unified review pipeline — replaces BOTH the old container pipeline
 * (clone → AST → SAST) AND the Worker queue.ts handler.
 *
 * No subrequest caps, no CPU time limits, no budget tracking.
 * Secrets come from process.env (set by Container.envVars), not request body.
 */
export async function runReviewPipeline(
  request: ReviewRequest,
  requestId: string
): Promise<ReviewResponse> {
  const workDir = `/tmp/review-${uuidv4()}`;
  const totalStart = Date.now();

  // Secrets come from process.env (set by Container class envVars)
  // NOT from request body — never pass secrets in HTTP payloads
  const env = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY!,
    AI_PROVIDER: process.env.AI_PROVIDER ?? 'claude',
    ENABLE_WEB_SEARCH: process.env.ENABLE_WEB_SEARCH ?? 'false',
    CLIQ_CLIENT_ID: process.env.CLIQ_CLIENT_ID,
    CLIQ_CLIENT_SECRET: process.env.CLIQ_CLIENT_SECRET,
    CLIQ_REFRESH_TOKEN: process.env.CLIQ_REFRESH_TOKEN,
    CLIQ_BOT_NAME: process.env.CLIQ_BOT_NAME,
    CLIQ_CHANNEL_ID: process.env.CLIQ_CHANNEL_ID,
    CLIQ_DB_NAME: process.env.CLIQ_DB_NAME,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID!,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY!,
    GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID!,
    // ⚠️ G55 FIX: Observability & Budget variables were missing
    HONEYCOMB_API_KEY: process.env.HONEYCOMB_API_KEY,
    OTEL_EXPORTER_URL: process.env.OTEL_EXPORTER_URL,
    BUDGET_ALERT_WEBHOOK: process.env.BUDGET_ALERT_WEBHOOK,
  };

  // ⚠️ G58 FIX: Explicit runtime validation for critical environment variables
  const requiredEnv = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'];
  const missingEnv = requiredEnv.filter(k => !process.env[k]);
  if (missingEnv.length > 0) {
    throw new Error(`CRITICAL: Container missing required environment variables: ${missingEnv.join(', ')}`);
  }
  if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
    console.warn(`[${requestId}] WARNING: No LLM API keys provided in environment.`);
  }

  try {
    // ─── Step 1: Shallow git clone ───
    console.log(`[${requestId}] Step 1: Cloning ${request.repoFullName}...`);
    await cloneRepository(request.repoFullName, request.headSha, request.installationToken, workDir);

    // ─── Step 2: Get changed files ───
    console.log(`[${requestId}] Step 2: Getting changed files...`);
    const changedFiles = await getChangedFiles(workDir);

    // ─── Step 3: AST Blast Radius ───
    console.log(`[${requestId}] Step 3: Building AST blast radius...`);
    const blastRadius = await buildBlastRadius(workDir, changedFiles);

    // ─── Step 4: Static Analysis ───
    console.log(`[${requestId}] Step 4: Running static analyzers...`);
    const staticFindings = await runStaticAnalysis(workDir, changedFiles);

    // ─── Step 5: Config & Previous Reviews ───
    console.log(`[${requestId}] Step 5: Fetching config & history...`);
    const repoConfig = await fetchRepoConfig(request.repoFullName, request.installationToken);
    const allowedFiles = repoConfig ? changedFiles.filter(f => !shouldIgnore(f, repoConfig)) : changedFiles;
    const customRules = repoConfig ? applyConfigOverrides(repoConfig) : undefined;
    // ⚠️ G46 FIX: 2nd arg is prNumber, NOT headSha
    const previousReview = await fetchPreviousReviewFindings(
      request.repoFullName, request.prNumber, request.installationToken
    );

    if (allowedFiles.length === 0) {
      return { staticFindings: [], blastRadius, metrics: { totalTimeMs: Date.now() - totalStart } };
    }

    // ─── Step 6: Tech Stack Detection ───
    console.log(`[${requestId}] Step 6: Detecting tech stack...`);
    const profile = await detectTechStack({
      changedFiles, allFiles: allowedFiles, workDir, installationToken: request.installationToken,
    });

    // ─── Step 7: File Classification & Chunking (NO CHUNK LIMIT) ───
    console.log(`[${requestId}] Step 7: Building review chunks...`);
    // ⚠️ G45 FIX: returns { tier1, tier2, skipped }, NOT { tier1Files }
    const { tier1, tier2, skipped } = classifyFiles(allowedFiles);
    const chunks = buildReviewChunks({ tier1, tier2, skipped }, profile, workDir);
    console.log(`[${requestId}] Created ${chunks.length} review chunks`);

    // ─── Step 8: MAP Phase — LLM Chunk Reviews ───
    // ⚠️ G40 FIX: Use concurrency limiter instead of unbounded Promise.allSettled
    // Max 5 concurrent LLM calls prevents 429 rate limit storms
    console.log(`[${requestId}] Step 8: Reviewing ${chunks.length} chunks via LLM (max 5 concurrent)...`);
    const chunkTasks = chunks.map((chunk, i) => async () => {
      const systemPrompt = composeChunkPrompt(profile, chunk.files, customRules);
      return callChunkReview(chunk.content, request.title, `${i + 1}/${chunks.length}`, env);
    });
    const chunkResults = await withConcurrencyLimit(chunkTasks, 5);

    const allFindings = chunkResults.flatMap((r) =>
      r.status === 'fulfilled' ? r.value.findings : []
    );
    const failedChunks = chunkResults.filter(r => r.status === 'rejected').length;

    // ─── Step 9: Cluster Similar Findings ───
    console.log(`[${requestId}] Step 9: Clustering ${allFindings.length} findings...`);
    const clustered = clusterFindings(allFindings);

    // ─── Step 10: Delta: Remove Previously Raised ───
    console.log(`[${requestId}] Step 10: Filtering previously raised findings...`);
    const newFindings = filterPreviouslyRaisedFindings(clustered, previousReview);
    console.log(`[${requestId}] ${newFindings.length} new findings after delta filtering`);

    // ─── Step 11: REDUCE Phase — Synthesis ───
    console.log(`[${requestId}] Step 11: Synthesizing final review...`);
    // ⚠️ G47 FIX: deriveVerdict requires 2 args (findings, allChunksFailed)
    const allChunksFailed = failedChunks === chunks.length && chunks.length > 0;
    const verdict = deriveVerdict(newFindings, allChunksFailed);
    const previousReviewContext = formatPreviousReviewContext(previousReview);
    const webSearchEnabled = env.ENABLE_WEB_SEARCH === 'true';
    const synthPrompt = composeSynthesizerPrompt(profile, webSearchEnabled, previousReviewContext);
    const synthesisResult = await callSynthesizer(
      buildSynthesizerPayload(newFindings, request.title, allowedFiles, verdict),
      env
    );

    // ─── Step 12: Post to GitHub ───
    // ⚠️ G48 NOTE: Function signatures below are CONCEPTUAL.
    // Actual signatures have more parameters — refer to the moved source files.
    console.log(`[${requestId}] Step 12: Posting results to GitHub...`);
    const conclusion = verdictToConclusion(verdict);
    await updateCheckRun(
      request.repoFullName, request.checkRunId, request.installationToken,
      conclusion, synthesisResult.review  // Actual: (repo, id, token, conclusion, body)
    );
    await postPRReview(
      request.repoFullName, request.prNumber, request.installationToken,
      verdict, synthesisResult.review     // Actual: (repo, pr, token, event, body, ...)
    );

    // ─── Step 13: Zoho Cliq Notification ───
    // ⚠️ G48: postToCliq() has 13 parameters — see src/lib/cliq.ts for full signature
    if (request.prAuthor && env.CLIQ_CLIENT_ID) {
      const severityCounts = countBySeverity(newFindings);
      await postToCliq(
        env.CLIQ_CLIENT_ID, env.CLIQ_CLIENT_SECRET, env.CLIQ_REFRESH_TOKEN,
        env.CLIQ_BOT_NAME, env.CLIQ_CHANNEL_ID,
        request.repoFullName, request.prNumber, request.title, request.prAuthor,
        conclusion, severityCounts, env.CLIQ_DB_NAME, failedChunks > 0 ? ['Some chunks failed'] : []
      ).catch(e => console.warn(`[${requestId}] Cliq notification failed:`, e));
    }

    // ─── Step 14: Track Usage Metrics (via outboundByHost → KV) ───
    try {
      // ⚠️ G48: buildPRUsageMetrics has ~10 parameters — see usage-tracker.ts
      const usageMetrics = buildPRUsageMetrics(
        request.prNumber, request.repoFullName, request.headSha,
        env.AI_PROVIDER, totalStart, chunkResults.length,
        allowedFiles.length, chunks.length, newFindings.length, 'completed'
      );
      await storePRUsageMetrics(request.repoFullName, request.prNumber, request.headSha, usageMetrics, env);
    } catch (e) {
      console.warn(`[${requestId}] Usage tracking failed:`, e);
    }

    return {
      staticFindings,
      blastRadius,
      metrics: { totalTimeMs: Date.now() - totalStart, filesAnalyzed: allowedFiles.length },
      review: synthesisResult.review,
      verdict,
      findings: newFindings,
      failedChunks,
      totalChunks: chunks.length,
      requestId,
    };

  } catch (err) {
    console.error(`[${requestId}] Pipeline failure:`, err);
    throw err; // Worker receives 500 and can retry
  } finally {
    await cleanup(workDir);
  }
}
```

#### What was removed from the old queue.ts:

| Concept | Why Removed |
|---------|-------------|
| `SubrequestBudget` | No subrequest cap in containers |
| `adaptiveConcurrency()` | Each container instance handles one review — no concurrent LLM calls |
| `ServiceLevel.DEGRADED` | No need to limit chunks — unlimited CPU/memory |
| `tryContainerReview()` | Container IS the review — no dual-compute fallback |
| `withTimeout(LLM_TIMEOUT_MS)` | Configurable per-fetch, no hard 5-min Worker limit |
| `<br>MAX_LLM_CHUNKS` | Removed — process all chunks |
| `MAX_SYNTHESIZER_INPUT_CHARS` | Removed — 12 GB memory |
| `request-hedging.ts` | Not needed — no subrequest scarcity |

### Phase 5 — Simplify Worker

**File: `src/index.ts`** (trim from 761 lines to ~150 lines)

```typescript
import { ReviewContainer } from './container-class';
import { handlePRWebhook } from './handlers/webhook';
import { handleKVProxy } from './handlers/kv-proxy';
import { handleDashboard } from './handlers/dashboard';
import { performHealthCheck } from './lib/health-check';
import { createSecureJsonResponse } from './lib/security-headers';
import { logger } from './lib/logger';
import type { Env } from './types/env';

export { ReviewContainer };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { method, url } = request;
    const { pathname, searchParams } = new URL(url);

    // ── Health check ──
    if (method === 'GET' && (pathname === '/' || pathname === '/health')) {
      const health = await performHealthCheck(env, WORKER_VERSION, workerStartTime);
      return createSecureJsonResponse(health, getHealthStatusCode(health));
    }

    // ── Dashboard ──
    if (pathname.startsWith('/dashboard')) {
      return handleDashboard(request, env);
    }

    // ── GitHub webhook ──
    if (method === 'POST' && pathname === '/') {
      try {
        // Verify + dedup + forward to container
        return await handlePRWebhook(request, env, ctx);
      } catch (error) {
        logger.error('Webhook error', error);
        return createSecureJsonResponse({ error: 'Internal error' }, 500);
      }
    }

    return createSecureJsonResponse({ error: 'Not Found' }, 404);
  },
};
```

**File: `src/handlers/webhook.ts`** — simplified: remove queue enqueue, add container dispatch

After the existing verify → dedup → filter flow, replace the queue send with a container fetch:

// ── Forward to container (replaces queue send) ──
const container = getContainer(env.REVIEW_CONTAINER, `pr-${repoFullName}-${prNumber}`);

// ⚠️ G51 FIX: Must use ctx.waitUntil to prevent isolate garbage collection
const containerPromise = container.fetch(new Request('http://container/review', {
  method: 'POST',
  body: JSON.stringify({
    repoFullName,
    prNumber,
    headSha,
    title,
    prAuthor: pr.user.login,
    prDescription: pr.body?.slice(0, 2000),
    installationToken: token,
    allowedFiles: [], // Container will classify
    checkRunId,
    requestId: getRequestId(),
    // ⚠️ G56 FIX: `env` object removed from POST body. Secrets must never be passed in HTTP payloads. 
    // They will be mapped via Container.envVars in container-class.ts.
  }),
})).catch(err => logger.error('Container dispatch failed', err));

ctx.waitUntil(containerPromise);

// Return 202 immediately
return createSecureJsonResponse({ message: 'Review dispatched to container', pr: prNumber }, 202);
```

### Phase 6 — Delete Phase

Delete these files and directories (no longer needed):

```
src/handlers/queue.ts                          # ~1400 lines — entire pipeline moved to container
src/lib/llm/index.ts                           # Moved to container/src/llm/
src/lib/llm/adapter.ts                         # Moved to container/src/llm/
src/lib/llm/adapters/claude.ts                 # Moved to container/src/llm/adapters/
src/lib/llm/adapters/gemini.ts                 # Moved to container/src/llm/adapters/
src/lib/llm/error-handler.ts                   # Moved to container/src/llm/
src/lib/llm/parse-findings.ts                  # Moved to container/src/llm/
src/lib/llm/distributed-rate-limiter.ts        # DELETED — uses DurableObject API, incompatible with container
src/lib/llm/rate-limiter-do-export.ts          # DELETED — re-exports RateLimiterDO, no longer needed
src/lib/degradation-levels.ts                  # DELETED — no subrequest caps to degrade around
src/lib/service-levels.ts                      # DELETED — same rationale
src/lib/subrequest-budget.ts                   # No subrequest cap
src/lib/request-hedging.ts                     # Not needed
src/lib/adaptive-concurrency.ts                # Per-container, in-memory only
src/lib/retry-with-backoff.ts                  # MOVED to container/src/ (separate implementation from retry.ts, needed by claude.ts adapter)
src/lib/cost-circuit-breaker.ts                # MOVED to container/src/ (keep if cost control needed; delete if relying on account-level budget alerts)
src/lib/retry.ts                               # MOVED to container/src/ (needed by LLM calls in container)
src/lib/errors.ts                              # COPIED to container/src/ (7 container modules depend on it, but Worker needs it too)
src/lib/plugins/index.ts                       # MOVED to container/src/plugins/
src/lib/plugins/secrets.ts                     # MOVED to container/src/plugins/
src/lib/plugins/suspicious.ts                  # MOVED to container/src/plugins/
src/lib/plugins/ts-strict.ts                   # MOVED to container/src/plugins/
src/types/review.ts                            # Moved to container/src/types/
src/types/stack.ts                             # Moved
src/types/usage.ts                             # Moved
src/types/github.ts                            # Moved (shared — keep in root too? Or just container)
src/config/prompts/                            # Moved to container/src/config/prompts/
src/lib/finding-clusters.ts                    # Moved to container/src/
src/lib/review-delta.ts                        # Moved to container/src/
src/lib/previous-review.ts                     # Moved to container/src/
src/lib/verdict.ts                             # Moved to container/src/
src/lib/review-formatter.ts                    # Moved to container/src/
src/lib/stack-detector.ts                      # Moved to container/src/
src/lib/repo-config.ts                         # Moved to container/src/
src/lib/web-search.ts                          # Moved to container/src/
src/lib/github.ts                              # Moved to container/src/
src/lib/github-auth.ts                         # Moved to container/src/
src/lib/cliq.ts                                # Moved to container/src/
src/lib/usage-tracker.ts                       # Moved to container/src/
src/lib/progressive-chunking.ts                # Moved to container/src/
src/lib/cache.ts                               # Moved to container/src/
src/lib/observability/                         # Moved to container/src/
src/lib/plugins/                               # Moved to container/src/
src/config/constants.ts                        # Moved to container/src/config/
src/config/usage-constants.ts                  # Moved to container/src/config/
```

### Phase 7 — Config Changes

**File: `wrangler.jsonc`**

```jsonc
{
  "name": "code-reviewer",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-03",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "vars": {
    "AI_PROVIDER": "claude",
    "ALLOWED_TARGET_BRANCHES": "dev",
    "CLIQ_BOT_NAME": "codereviewbot",
    "CLIQ_CHANNEL_ID": "prweb",
    "CLIQ_DB_NAME": "githubusermap",
    "DASHBOARD_USERNAME": "admin",
    "DASHBOARD_PASSWORD": "admin123",
    "ENABLE_WEB_SEARCH": "true",
    "PROXY_SECRET": "REPLACE_WITH_GENERATED_SECRET"
  },
  // REMOVED: queues section entirely
  "kv_namespaces": [
    { "binding": "USAGE_METRICS", "id": "2825e1ef509f4069b316c5e96d1dd61b" },
    { "binding": "AUTH_KV", "id": "c715f1033e3c4d2d8fcc356a62657390" },
    { "binding": "CACHE_KV", "id": "800a1d0290dd4b8091dc919f48ebc1e5" },
    { "binding": "DEDUP_KV", "id": "84049d8f2396421682c8abe889dd1ffe" }
  ],
  "containers": [
    {
      "class_name": "ReviewContainer",
      "image": "./container/Dockerfile",
      "instance_type": "standard-2",
      "max_instances": 20
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "REVIEW_CONTAINER", "class_name": "ReviewContainer" }
      // REMOVED: RATE_LIMITER (container handles rate limiting in-memory or via DO proxy)
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["ReviewContainer"] }
    // REMOVED: v2 migration for RateLimiterDO
  ]
}
```

**File: `container-class.ts`** — minor update:

```typescript
export class ReviewContainer extends Container {
  defaultPort = 3000;
  sleepAfter = '10m';  // Increased from 5m to keep warm longer
  enableInternet = true;

  // Pass secrets from Worker environment to container process
  envVars = {
    // All secrets flow through here — Container class passes them
    // to the Docker container as environment variables.
    // The Worker's webhook handler passes them in the /review POST body.
  };
}
```

**File: `.dev.vars`** — add proxy secret for local dev:
```
PROXY_SECRET=dev-secret-not-secure
```

**File: `worker-configuration.d.ts`** — regenerate after config changes:
```bash
npx wrangler types
```

### Phase 8 — Phased Rollout

1. **Build and deploy new container image:**
   ⚠️ **G50 FIX:** Must compile container TypeScript first!
   ```json
   // Add to root package.json:
   "scripts": {
     "build:container": "cd container && npm run build",
     "deploy": "npm run build:container && DOCKER_API_VERSION=1.44 wrangler deploy"
   }
   ```
   ```bash
   npm run deploy
   ```

2. **Run old + new side by side:**
   - Keep the old `queue.ts` handler deployed in the Worker
   - New container handles webhooks forwarded by the thin Worker routes
   - Route 10% traffic to new: use a request header check
   ```typescript
   // In webhook.ts
   if (Math.random() < 0.1) {
     // New path: forward to container
     return await dispatchToContainer(request, env, payload, token);
   } else {
     // Old path: enqueue to queue
     return await enqueueToOldQueue(request, env, payload, token);
   }
   ```

3. **Monitor for 48 hours:**
   - Check container logs (`wrangler tail`)
   - Compare review quality (findings count, relevance)
   - Monitor container cold start frequency
   - Check cost dashboard

4. **Full cutover:**
   - Remove traffic splitting logic
   - Delete queue handler code
   - Deploy final clean Worker

---

## 4. File Movement Map

```
FROM (Worker)                              TO (Container)
─────────────────────────────────────────────────────────────────
src/handlers/queue.ts                      container/src/pipeline.ts (merge)
src/lib/llm/index.ts                       container/src/llm/index.ts
src/lib/llm/adapter.ts                     container/src/llm/adapter.ts
src/lib/llm/adapters/claude.ts             container/src/llm/adapters/claude.ts
src/lib/llm/adapters/gemini.ts             container/src/llm/adapters/gemini.ts
src/lib/llm/error-handler.ts               container/src/llm/error-handler.ts
src/lib/llm/parse-findings.ts              container/src/llm/parse-findings.ts
src/lib/llm/distributed-rate-limiter.ts    [DELETE — uses DurableObject API, incompatible with container]
src/lib/finding-clusters.ts                container/src/finding-clusters.ts
src/lib/review-delta.ts                    container/src/review-delta.ts
src/lib/previous-review.ts                 container/src/previous-review.ts
src/lib/verdict.ts                         container/src/verdict.ts
src/lib/review-formatter.ts                container/src/review-formatter.ts
src/lib/stack-detector.ts                  container/src/stack-detector.ts
src/lib/repo-config.ts                     container/src/repo-config.ts
src/lib/web-search.ts                      container/src/web-search.ts
src/lib/github.ts                          container/src/github.ts
src/lib/github-auth.ts                     container/src/github-auth.ts
src/lib/cliq.ts                            container/src/cliq.ts
src/lib/usage-tracker.ts                   container/src/usage-tracker.ts
src/lib/progressive-chunking.ts            container/src/progressive-chunking.ts
src/lib/cache.ts                           container/src/cache.ts
src/lib/observability/tracer.ts            container/src/observability/tracer.ts
src/lib/plugins/*                          container/src/plugins/*
src/lib/cost-circuit-breaker.ts            container/src/cost-circuit-breaker.ts
src/lib/retry.ts                           container/src/retry.ts
src/lib/retry-with-backoff.ts              container/src/retry-with-backoff.ts
src/config/constants.ts                    container/src/config/constants.ts
src/config/usage-constants.ts              container/src/config/usage-constants.ts
src/config/prompts/*                       container/src/config/prompts/*
src/types/review.ts                        container/src/types/review.ts
src/types/stack.ts                         container/src/types/stack.ts
src/types/usage.ts                         container/src/types/usage.ts
src/types/github.ts                        container/src/types/github.ts

NEW FILES (no equivalent):
─                                          container/src/kv-proxy.ts
─                                          src/handlers/kv-proxy.ts
src/handlers/dashboard.ts (extract         ─ (stays in Worker)
  from index.ts)
```

**Files that stay in Worker (with modifications noted):**
- `src/index.ts` (simplified — stripped to ~150 lines, remove admin endpoints)
- `src/container-class.ts` (add `envVars` property for secrets)
- `src/lib/security.ts`
- `src/lib/security-headers.ts`
- `src/lib/cors.ts`
- `src/lib/errors.ts`
- `src/lib/health-check.ts` (⚠️ MODIFY: remove `checkQueueHealth()`, add container `/ping` probe)
- `src/lib/request-context.ts`
- `src/lib/logger.ts`
- `src/lib/validation.ts`
- `src/lib/payload-limit.ts`
- `src/handlers/dashboard-html.ts`
- `src/types/env.ts` (simplified — remove `REVIEW_QUEUE`, `RATE_LIMITER`, `ReviewMessage`)
- `test/` (⚠️ MODIFY: 11 test files import from `../src/` paths that will break — needs path migration)

---

## 5. Cost Impact

| Resource | Old (Worker + Container) | New (Container Only) | Delta |
|----------|------------------------|---------------------|-------|
| Workers Paid plan | $5/mo | $5/mo | $0 |
| Worker CPU time | ~30s per review (LLM wait time) | ~2s per review (proxy only) | **-93%** |
| Container instance | standard-1: 0.5 vCPU, 4 GB, 8 GB disk | standard-2: 1 vCPU, 6 GB, 12 GB disk | **2x** instance size |
| Container runtime | ~3 min/review (git + static analysis) | ~5 min/review (git + SAST + LLM + posting) | **+67%** runtime |
| Queue | $0 (included) | $0 (removed) | $0 |
| **Monthly estimate** (1000 reviews) | ~$15-25 | ~$20-35 | **+$5-10/mo** |

**Why the cost increase is worth it:**
- 50-subrequest cap eliminated — no chunk truncation on large PRs
- No 30s CPU limit — LLM calls with web search continuations work reliably
- Codebase shrinks by ~50% — ongoing maintenance cost plummets
- No dual-compute fallback complexity — one code path always

**Cost optimization notes:**
- `sleepAfter: '10m'` ensures warm containers for burst traffic
- Active-CPU pricing means container does not cost during LLM API wait time (only CPU used for actual compute)
- On low-traffic repos, container sleeps after 10min — pay only when active

---

## 6. Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Container cold start** (1-3s) | Adds latency to first review after idle | `sleepAfter: '10m'` — high-traffic repos always warm. 202 response already sent to GitHub — user doesn't wait. |
| **Container crash mid-review** | Review lost, no GitHub update | Worker catches HTTP 500, retries with fresh container. Partial findings still posted. |
| **KV proxy failure** | Usage metrics, dedup, auth cache unreachable | In-memory buffer in container — flush asynchronously. Non-fatal — review proceeds without tracking. |
| **Container OOM** | Instance killed, review lost | Upgrade instance type. Monitor memory via container metrics. |
| **Secret exposure** | Secrets in container env vars | Secrets flow through Container `envVars` (Worker secret → env var, same as current). Container disk is ephemeral — secrets never persisted. |
| **Rolling deploy kills running review** | Mid-review container terminated | Container receives `SIGTERM` + 15min grace period. Pipeline stores partial state, new container can resume. |
| **Proxy secret leak** | Unauthorized KV access | Rotate `PROXY_SECRET` via `wrangler secret put PROXY_SECRET`. Rate-limit `/proxy/kv` endpoint. |

---

## 7. Rollback Plan

If the migration causes issues, rollback is safe:

1. **Restore old `wrangler.jsonc`:**
   ```bash
   git checkout wrangler.jsonc  # Restores queues, RateLimiterDO, old container config
   ```

2. **Restore old `src/index.ts`:**
   ```bash
   git checkout src/index.ts src/handlers/ src/lib/ src/config/ src/types/
   ```

3. **Redeploy:**
   ```bash
   npx wrangler deploy  # Old Worker + queue handler are back
   ```

4. **Monitor:**
   - Queue backlog drains automatically
   - Old queue handler picks up any in-flight messages
   - No data loss — KV tables are shared

**Total rollback time:** ~5 minutes (one `git checkout` + `wrangler deploy`)

---

## 8. Gap Analysis

Gaps discovered during deep investigation of the original plan. Each gap includes impact severity and remediation.

### Gap 1: `cache.ts` — KV dependency embedded in `cachedGitHubFetch()`

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/cache.ts:162-239` |
| **Problem** | `cachedGitHubFetch()` takes `env: Env` and accesses `CACHE_KV` directly via `env.CACHE_KV.get/put`. This is called by `src/lib/github.ts` at lines 102 and 271. In the container, `env` is `ContainerEnv` (no KV bindings). |
| **Impact** | High — every GitHub API call in the container would fail without KV cache. |
| **Remediation** | Rewrite `cachedGitHubFetch()` to accept a `kvCache` interface that wraps the KV proxy. Container passes `kvProxy`-backed cache; Worker (if kept) passes direct `env.CACHE_KV`. |
| **Pattern** | ```typescript
interface KvCache { get(key: string): Promise<string | null>; put(key: string, val: string, ttl?: number): Promise<void>; }
// Container side:
const kvCache: KvCache = {
  get: async (key) => kvProxy(env, { namespace: 'CACHE_KV', action: 'get', key }),
  put: async (key, val, ttl) => kvProxy(env, { namespace: 'CACHE_KV', action: 'put', key, value: val, ttl }),
};
await cachedGitHubFetch<T>(kvCache, url, init, cacheConfig, fetchFn);
``` |

### Gap 2: `health-check.ts` — Queue check + LLM health uses Worker `env`

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/health-check.ts:199-232` (checkQueueHealth), lines 110-193 (checkLLMHealth) |
| **Problem** | `checkQueueHealth()` checks `env.REVIEW_QUEUE` binding (line 205) — must be removed. `checkLLMHealth()` reads `env.ANTHROPIC_API_KEY` / `env.GEMINI_API_KEY` from Worker `env` — in the container these are `process.env` vars. |
| **Impact** | Medium — health endpoint returns unhealthy for queue (false alarm) after migration. Worker health check should also probe container's `/ping`. |
| **Remediation** | Remove `checkQueueHealth()` entirely. Add `checkContainerHealth(proxyBase, proxySecret)` that calls container's `/ping` endpoint via KV proxy. LLM health check stays in Worker (it's a lightweight HTTP check, not CPU-intensive). |

### Gap 3: `distributed-rate-limiter.ts` — Incompatible with container

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/llm/distributed-rate-limiter.ts:154-314` |
| **Problem** | Uses `DurableObject` class with `this.state.storage.get/put/setAlarm` (lines 165, 182, 211, 221, 314). These are Worker-only runtime APIs. Cannot run in Node.js container. The original plan incorrectly listed this as "move to container." |
| **Impact** | High — without distributed rate limiting, 20 concurrent containers could each send simultaneous LLM requests → 429 rate limit errors from Anthropic/Gemini. |
| **Remediation** | Replace with light in-memory token bucket per container instance (each container handles one review at a time, so per-instance rate limiting is often sufficient). For stricter control, route LLM calls through a Worker-side proxy endpoint (`POST /proxy/llm`) that applies global rate limiting via a Durable Object — but this adds latency. **Recommendation:** Accept per-instance rate limiting initially; add DO-backed proxy only if 429s become a problem. |

### Gap 4: `container-class.ts` — Missing `envVars` property

| Aspect | Detail |
|--------|--------|
| **File** | `src/container-class.ts:14-44` |
| **Problem** | Current class has no `envVars` property. The plan references `envVars = {}` in Phase 7 but shows it empty with a comment saying secrets are passed in the POST body. Workers docs recommend putting secrets in `envVars` on the Container class, not in the request body. |
| **Impact** | Medium — secrets in POST body are visible in container logs and container process environ. `envVars` keeps secrets in the Docker environment only, never logged. |
| **Remediation** | Populate `envVars` with ALL Worker secrets that the container needs. The Container class copies these into the Docker container's `process.env` automatically. The `/review` POST body can reference `process.env` instead of carrying an `env` sub-object. |
| **Implementation** | ```typescript
export class ReviewContainer extends Container {
  envVars = {
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    CLIQ_CLIENT_ID: '',
    CLIQ_CLIENT_SECRET: '',
    CLIQ_REFRESH_TOKEN: '',
    CLIQ_BOT_NAME: '',
    CLIQ_CHANNEL_ID: '',
    CLIQ_DB_NAME: '',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    GITHUB_APP_INSTALLATION_ID: '',
    AI_PROVIDER: 'claude',
    ENABLE_WEB_SEARCH: 'false',
    HONEYCOMB_API_KEY: '',
    OTEL_EXPORTER_URL: '',
    PROXY_SECRET: '',
    PROXY_BASE: '',
  };
}
``` |

### Gap 5: `ReviewRequest` type — Missing `env` field in current type

| Aspect | Detail |
|--------|--------|
| **File** | `container/src/types.ts:5-18` |
| **Problem** | Current `ReviewRequest` has no `env` field. The plan's Phase 5 webhook sends an `env` sub-object with all secrets (lines 566-579). This will cause TypeScript errors at compile time. |
| **Impact** | High — builds fail until type is updated. |
| **Remediation** | Add optional `env` field to `ReviewRequest`. Or (preferred) use `Container.envVars` instead (see Gap 4), which means `env` is never passed in the request body — container reads from `process.env` directly. |
| **Resolution** | Choose one pattern: **A)** Use `envVars` only (cleaner, more secure) — remove `env` from POST body entirely. **B)** Use request-body `env` (simpler to debug) — add `env?: Record<string, string>` to `ReviewRequest`. |

### Gap 6: `ReviewResponse` type — Too narrow for unified pipeline

| Aspect | Detail |
|--------|--------|
| **File** | `container/src/types.ts:58-62` |
| **Problem** | Current response has only `staticFindings`, `blastRadius`, `metrics`. The unified pipeline needs `review` (text), `verdict` (approve/comment/request_changes), `findings` (LLM findings array), `chunkResults`, `failedChunks`, etc. |
| **Impact** | High — pipeline output doesn't fit the type; Worker can't post review results. |
| **Remediation** | Expand `ReviewResponse` to include unified pipeline output. Keep `staticFindings` and `blastRadius` as they were. Add: |
| **New type** | ```typescript
export interface ReviewResponse {
  staticFindings: StaticFinding[];
  blastRadius: BlastRadius;
  metrics: ReviewMetrics;
  review?: string;           // LLM-generated review text
  verdict?: 'approve' | 'comment' | 'request_changes' | 'pending';
  findings?: UnifiedFinding[];
  failedChunks?: number;
  totalChunks?: number;
  requestId?: string;
}
``` |

### Gap 7: Tests — 11 test files import from `../src/`

| Aspect | Detail |
|--------|--------|
| **Files** | `test/index.spec.ts`, `test/finding-clusters.spec.ts`, `test/map-reduce.spec.ts`, `test/performance.spec.ts`, `test/previous-review.spec.ts`, `test/review-delta.spec.ts`, `test/review-formatter.spec.ts`, `test/validation.spec.ts`, `test/verdict.spec.ts`, `test/web-search.spec.ts`, `test/env.d.ts` |
| **Problem** | All imports reference `../src/index`, `../src/lib/*`, `../src/types/*`. After migration, these paths won't resolve correctly — the code moved to `container/src/`. |
| **Impact** | High — test suite breaks after migration. |
| **Remediation** | Three options: **A)** Copy test files to `container/test/` and update imports to `../src/` (container's src). **B)** Keep tests in root `test/` but update `tsconfig.json` path aliases to resolve `src/*` → `container/src/*`. **C)** Make tests import from published package paths. **Recommendation:** Option A — copy to `container/test/` and use vitest's built-in for container. The root test `index.spec.ts` (Worker integration test) stays in root but imports from simplified Worker only. |
| **`test/env.d.ts`** | References `@cloudflare/vitest-pool-workers` (Worker-specific). Container tests need standard vitest. |

### Gap 8: OpenTelemetry — Different export configs

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/observability/tracer.ts:391-405` (initOTel), plus the lazy `import('@opentelemetry/api')` at line 34 |
| **Problem** | Worker uses Cloudflare's native OTel integration (span export via binding). Container needs HTTP OTLP exporter (send to Honeycomb, Grafana, etc.). The lazy import works in both, but `initOTel()` in the container must set up a different exporter. |
| **Impact** | Low-medium — no-op tracer works in both; telemetry loss until exporter is configured correctly for container. |
| **Remediation** | Move tracer to `container/src/observability/tracer.ts`. When running in container, check `process.env.OTEL_EXPORTER_URL` and configure HTTP OTLP exporter. Worker side can keep a light version that just calls Cloudflare's built-in tracing. |

### Gap 9: Admin metrics endpoints — Lose in-memory data

| Aspect | Detail |
|--------|--------|
| **File** | `src/index.ts:412-454` |
| **Problem** | Three admin endpoints read in-memory Worker state: `/admin/retry-metrics` (line 413), `/admin/concurrency-metrics` (line 428), `/admin/rate-limiter-metrics/{provider}` (line 443). After migration, these data sources no longer exist (no retry controller, no concurrency limiter, no RateLimiterDO). |
| **Impact** | Medium — operational visibility lost. |
| **Remediation** | Remove these three admin endpoints from the simplified Worker. If container-side LLM call metrics are needed, expose them on the container's own `/metrics` endpoint. |

### Gap 10: `RequestMessage` vs `ReviewMessage` — Type mismatch

| Aspect | Detail |
|--------|--------|
| **Files** | `src/types/env.ts:83-96` (ReviewMessage), `container/src/types.ts:5-18` (ReviewRequest) |
| **Problem** | The Worker's `ReviewMessage` (for queue) has fields like `prNumber`, `title`, `repoFullName`, `headSha`, `checkRunId`, `prAuthor`, `requestId`, `prDescription`. The container's `ReviewRequest` has all these but also `installationToken`, `allowedFiles`. After migration, the webhook dispatches directly to the container (no queue), so `ReviewMessage` becomes unused. But the webhook must construct a `ReviewRequest` that matches what the container expects. |
| **Impact** | Low — both types are similar; minor field mapping needed. |
| **Remediation** | Delete `ReviewMessage` from `src/types/env.ts` (no longer needed). Align `container/src/types.ts` `ReviewRequest` with what the webhook sends — add `env` if using request-body secrets, or document that container reads from `process.env`. |

### Gap 11: Git clone — No fallback after migration

| Aspect | Detail |
|--------|--------|
| **Logic** | Old architecture: failed container clone → Worker fallback (GitHub API-based review). New architecture: failed clone → entire review fails. |
| **Impact** | Medium — no safety net for clone failures. |
| **Remediation** | Make `cloneRepository()` more resilient: retry with exponential backoff (3 attempts), use `--depth 1` (already shallow), handle large repos with timeout increase (60s → 120s for large monorepos). Keep the worker fallback as an optional env toggle if reliability is critical. |

### Gap 12: `src/types/env.ts` — Must remove Worker-only bindings

| Aspect | Detail |
|--------|--------|
| **File** | `src/types/env.ts:59-77` |
| **Problem** | Contains `REVIEW_QUEUE: Queue<ReviewMessage>`, `RATE_LIMITER: DurableObjectNamespace`, `GITHUB_APP_INSTALLATION_ID` (not needed in simplified Worker). |
| **Impact** | Medium — TypeScript errors if bindings are referenced in the simplified Worker. |
| **Remediation** | Remove `REVIEW_QUEUE`, `RATE_LIMITER`, `ReviewMessage` interface from `Env`. `GITHUB_APP_INSTALLATION_ID` is still needed by the webhook to get installation tokens (GitHub App auth). Keep it. |

### Gap 13: Container needs `ContainerEnv` type

| Aspect | Detail |
|--------|--------|
| **File** | New file needed: `container/src/types/env.ts` |
| **Problem** | The container doesn't have a type for its environment variables. All secrets and proxy config come from `process.env` (set via `Container.envVars`), but there's no TypeScript type for this mapping. |
| **Impact** | Low — no runtime issue, but no type safety for env access in container code. |
| **Remediation** | Create `container/src/types/env.ts` with a `ContainerEnv` interface matching the `envVars` keys from Gap 4. |

### Gap 14: `src/lib/retry.ts` vs `retry-with-backoff.ts` — Two separate files, one unaccounted

| Aspect | Detail |
|--------|--------|
| **Files** | `src/lib/retry.ts` (390 lines), `src/lib/retry-with-backoff.ts` |
| **Problem** | The plan lists `retry-with-backoff.ts` for deletion (Phase 6: "Container handles retry natively") but never mentions `retry.ts`. These are different files! `retry.ts` contains `retryWithBackoff()` (used by LLM calls) AND `CircuitBreaker` class AND `circuitBreakers` singleton AND `getCircuitBreakerStates()`. `retry-with-backoff.ts` is a smaller wrapper (if it exists). The plan's reference to `retry-with-backoff.ts` is ambiguous — it may intend to refer to `retry.ts`. |
| **Impact** | High — if `retry.ts` is not moved to container, LLM calls lose retry logic and circuit breaker protection. |
| **Remediation** | Move `src/lib/retry.ts` AND `src/lib/retry-with-backoff.ts` to container (they have DIFFERENT function signatures — see Gap 26). Keep `circuitBreakers` singleton but note it's per-container-instance only. |

### Gap 15: Six `src/lib/` files completely unaccounted for

The following files exist in `src/lib/` but are never mentioned in ANY section of the plan (file movement map, delete phase, or "stays in Worker"):

| File | Lines | Purpose | Access Pattern | Recommended Action |
|------|-------|---------|---------------|-------------------|
| `degradation-levels.ts` | 371 | 5-level degradation system | `env.CACHE_KV` (KV reads) | **DELETE** — replaced by simpler in-container decision (no subrequest caps or CPU limits to degrade around) |
| `metrics.ts` | 241 | In-memory metrics + KV reads | `env.USAGE_METRICS`, dynamic import of `retry.ts` | **STAY in Worker** — dashboard needs it. KV access → KV proxy. Remove `circuitBreakers` import (those states are container-local now). |
| `rate-limit.ts` | 326 | Token bucket rate limiter | `env.CACHE_KV`, `env.USAGE_API_KEY`, `crypto.subtle` | **STAY in Worker** — protects dashboard/admin endpoints. `crypto.subtle` is Web API (available in Workers). Container doesn't need rate limiting (one review at a time). |
| `retry.ts` | 390 | `retryWithBackoff()` + `CircuitBreaker` | `setTimeout`, `Error` classes only | **MOVE to container** — pure utility, LLM calls need retry. Keep `circuitBreakers` singleton (per-instance). |
| `service-levels.ts` | 295 | 3-level service levels | `env.CACHE_KV` (KV reads) | **DELETE** — same rationale as `degradation-levels.ts`. Container has no subrequest caps, so no degradation needed. |
| `webhook-dedup.ts` | 81 | Dedup with `env.DEDUP_KV` | `env.DEDUP_KV` | **STAY in Worker** — webhook dedup happens before container dispatch. Already implicitly stays. |

### Gap 16: `rate-limiter-do-export.ts` — Re-export file that must be deleted

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/llm/rate-limiter-do-export.ts` (5 lines) |
| **Problem** | This file re-exports `RateLimiterDO` for DO registration: `export { RateLimiterDO } from './distributed-rate-limiter'`. When `distributed-rate-limiter.ts` is deleted, this breaks. |
| **Impact** | Medium — broken import until cleaned up. |
| **Remediation** | Delete `rate-limiter-do-export.ts`. Remove `export { RateLimiterDO }` from `src/index.ts` (line 7). Remove `RATE_LIMITER` binding from `wrangler.jsonc` DO bindings (already planned). |

### Gap 17: `cost-circuit-breaker.ts` — Listed as BOTH MOVE and DELETE

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/cost-circuit-breaker.ts` (408 lines) |
| **Problem** | File movement map says MOVE to container. Phase 6 delete list says DELETE with comment "Optional in container with KV proxy." These contradict. |
| **Impact** | Low — either action is fine, but the plan is inconsistent. |
| **Remediation** | **MOVE to container** — the cost circuit breaker is useful for container-side cost control. It uses KV for persistence (→ KV proxy). Delete phase should say "Optional — keep if cost control is needed; delete if relying on account-level budget alerts." |

### Gap 18: Worker routes not addressed

| Aspect | Detail |
|--------|--------|
| **Files** | `src/index.ts:347-720` |
| **Problem** | The plan's simplified Worker shows 4 routes (health, proxy/kv, dashboard, webhook). The current Worker has 9+ routes. These are unaccounted: |
| **Missing routes** | • `GET /metrics` (line 392) — Prometheus metrics endpoint<br>• `/usage/*` (line 476-479) — Usage tracking endpoints<br>• `GET /debug/cliq-mention` (line 703) — Debug endpoint |
| **Impact** | Medium — operational visibility tools lost if removed without replacement. |
| **Remediation** | • `GET /metrics` → **KEEP** in simplified Worker. Read metrics from KV via `getOperationalMetrics(env)` but remove `circuitBreakers` from output (container-local).<br>• `/usage/*` → **KEEP** or **PROXY** to container. Usage data stored in KV via `USAGE_METRICS`; Worker can still serve it.<br>• `GET /debug/cliq-mention` → **DELETE** (debug endpoint, not for production). |

### Gap 19: Documentation files need updating

| File | Lines | Problem |
|------|-------|---------|
| `ADMIN_ENDPOINTS.md` | 393 | References `/admin/retry-metrics`, `/admin/concurrency-metrics`, `/admin/rate-limiter-metrics/{provider}` — all being removed. Also references `RateLimiterDO` metrics. Must be rewritten. |
| `DEPLOYMENT_GUIDE.md` | 316 | References old architecture, queues, `RateLimiterDO` setup, `queue` consumer config. Must be updated to reflect simplified Worker + container-only pipeline. |
| `DOCUMENTATION_INDEX.md` | — | Should be reviewed for stale references. |
| `container/README.md` | 24 | "bridges the external Edge Worker to this container" — out of date with unified pipeline. Must be updated. |

### Gap 20: Scripts directory not addressed

| File | Purpose | Impact |
|------|---------|--------|
| `scripts/check-usage.sh` | Check usage metrics | Low — uses KV API, may need endpoint update |
| `scripts/verify-deployment.sh` | Verify deployment | Medium — checks for old config (queues, RateLimiterDO) |
| `scripts/fix-critical-issues.sh` | Auto-fix script | Medium — may reference files being deleted |
| `scripts/usage-client.ts` | Usage API client | Low — references `/usage/*` endpoints (staying) |
| `scripts/debug-cliq-mention.ts` | Debug Cliq mentions | Low — debug tool |
| `scripts/usage-dashboard.html` | Dashboard HTML | Low — reference copy |

**Action:** Review each script post-migration. `verify-deployment.sh` and `fix-critical-issues.sh` are most likely to need updates.

### Gap 21: Plugin files need explicit listing

| Aspect | Detail |
|--------|--------|
| **Files** | `src/lib/plugins/index.ts` + `secrets.ts` + `suspicious.ts` + `ts-strict.ts` |
| **Problem** | The plan's file movement map uses wildcard `src/lib/plugins/*` → `container/src/plugins/*`. This is correct, but the Phase 6 delete list doesn't mention plugins at all — they should be MOVED, not deleted. |
| **Impact** | Low — wildcard works, but explicit mention improves clarity. |
| **Remediation** | Add plugin files to Phase 6 delete list as "moved to container/src/plugins/". |

### Gap 22: Prompt subdirectories (covered by wildcard)

The plan uses `src/config/prompts/` → `container/src/config/prompts/` wildcard. Actual subdirectories:
- `architecture/`
- `ecosystem/`
- `frameworks/`
- `languages/`
- Plus files: `base.ts`, `composer.ts`, `output-format.ts`, `web-search.ts`

All covered by wildcard. No action needed.

### Gap 23: `vitest.config.mts` — Worker-specific config, container needs separate config

| Aspect | Detail |
|--------|--------|
| **File** | `vitest.config.mts` (24 lines) |
| **Problem** | Uses `@cloudflare/vitest-pool-workers/config` (Worker-specific). Provides dummy bindings for old `wrangler.jsonc` (queues, RateLimiterDO). After migration, root tests should be minimal (Worker integration test), and container tests need standard (non-Cloudflare) vitest config. |
| **Impact** | Medium — test suite breaks after migration until config is updated. |
| **Remediation** | For root `vitest.config.mts`: keep for Worker integration tests. Remove dummy bindings for `REVIEW_QUEUE` if no longer needed. For container: create `container/vitest.config.ts` with standard vitest config (no Cloudflare pool). |

### Gap 24: `tsconfig.json` (root) — Stale references

| Aspect | Detail |
|--------|--------|
| **File** | `tsconfig.json` (30 lines) |
| **Problem** | References `./worker-configuration.d.ts` (generated by `wrangler types`). After migration, this file changes (new bindings, removed bindings). Also `exclude: ["test"]` — if tests move to container, this is still fine but may need adjustment. |
| **Impact** | Low — `worker-configuration.d.ts` regeneration is already in Phase 7. |
| **Remediation** | Already covered by Phase 7: run `wrangler types` after config changes. |

### Gap 25: `src/index.ts` exports `RateLimiterDO`

| Aspect | Detail |
|--------|--------|
| **File** | `src/index.ts:7` |
| **Problem** | Line 7: `export { RateLimiterDO } from './lib/llm/distributed-rate-limiter'`. When `distributed-rate-limiter.ts` is deleted, this import breaks. |
| **Impact** | High — Worker deploy fails until removed. |
| **Remediation** | Remove this export line from `src/index.ts`. It's only needed for DO binding registration in `wrangler.jsonc`, which is being removed. |

### Gap 26: Two `retryWithBackoff()` functions — both needed in container

| Aspect | Detail |
|--------|--------|
| **Files** | `src/lib/retry.ts:158`, `src/lib/retry-with-backoff.ts:60` |
| **Problem** | There are **two separate files** exporting `retryWithBackoff()` with different signatures. The plan says `retry-with-backoff.ts` should be deleted (Phase 6: "Container handles retry natively") but `src/lib/llm/adapters/claude.ts:8` imports from it. The two files: <ul><li>`retry.ts` — signature `(fn, operationName, config?) → RetryResult<T>`. Used by: `github.ts`, `llm/index.ts`, `metrics.ts`, `previous-review.ts`</li><li>`retry-with-backoff.ts` — signature `(fn: (signal) => T, config?) → T` (different!). Used by: `claude.ts`, `src/index.ts` (admin metrics).</li></ul>Both have different callers that depend on their specific return types. |
| **Impact** | High — deleting `retry-with-backoff.ts` breaks the Claude adapter. |
| **Remediation** | Move **both** files to container: `container/src/retry.ts` and `container/src/retry-with-backoff.ts`. Update Phase 6 and file movement map to reflect this. Optionally consolidate into one file later (separate refactor). |

### Gap 27: `src/index.ts` stale imports silently break

| Aspect | Detail |
|--------|--------|
| **File** | `src/index.ts:12,29,30` |
| **Problem** | Three imports reference files that are deleted or moved: <ul><li>Line 12: `import { queueHandler } from './handlers/queue'` — queue.ts is deleted</li><li>Line 29: `import { getAllRetryMetrics } from './lib/retry-with-backoff'` — file moves to container</li><li>Line 30: `import { getAllConcurrencyMetrics } from './lib/adaptive-concurrency'` — file is deleted</li></ul> |
| **Impact** | High — Worker build fails if these imports remain. |
| **Remediation** | Remove all three imports from simplified Worker. Also remove `import { queueHandler }` since the simplified Worker has no queue handler export. |

### Gap 28: `usage-tracker.ts` has own retry + deep KV access (468 lines)

| Aspect | Detail |
|--------|--------|
| **File** | `src/lib/usage-tracker.ts` (468 lines) |
| **Problem** | Contains its own KV retry logic (`retryKVOperation` at lines 12-46), accesses `env.USAGE_METRICS` directly at lines 158, 162, 186, 246, 367, and more. When moved to container, **every method** needs KV proxy migration. The file also imports `Env`, `errors.ts`, `validation.ts`, `logger.ts`, and `usage-constants.ts`. |
| **Impact** | Medium-high — all 10+ KV access points need proxy conversion. |
| **Remediation** | When copying to container, replace all `env.USAGE_METRICS.get/put/delete/list` calls with `kvProxy(env, { namespace: 'USAGE_METRICS', ... })`. Replace `retryKVOperation` with retries from `retry.ts` (which is also moving). |

### Gap 29: Worker `export default` still exports `queue()` handler

| Aspect | Detail |
|--------|--------|
| **File** | `src/index.ts:12` (import) + export default object |
| **Problem** | The current Worker exports `queue: queueHandler` as part of its default handler object (for Cloudflare Queue consumer invocations). After migration, there is no queue consumer. The simplified Worker must not export a `queue` handler. Additionally, `wrangler.jsonc` must remove the `queues.consumers` section (already planned). |
| **Impact** | Medium — wrangler deploy may fail if queue consumer references non-existent handler. |
| **Remediation** | Remove `queue` from the `export default` object in simplified `src/index.ts`. Remove `queues.consumers` from `wrangler.jsonc`. |

### Gap 30: `container/package.json` missing `@opentelemetry/api`

| Aspect | Detail |
|--------|--------|
| **File** | `container/package.json:12-19` |
| **Problem** | Plan's Phase 1 says `@opentelemetry/api` should be "already available in container via npm" but the current `container/package.json` does NOT list it. The only dependencies are `@hono/node-server`, `execa`, `hono`, `tree-sitter`, `tree-sitter-typescript`, `uuid`. |
| **Impact** | Low — build succeeds (`@opentelemetry/api` lazy-loads and degrades gracefully) but OTel tracing silently no-ops. |
| **Remediation** | Add `"@opentelemetry/api": "^1.9.1"` and `"@opentelemetry/exporter-trace-otlp-http": "^0.200.0"` to `container/package.json` dependencies. Also mentioned in Phase 1 / step 9 of implementation order. |

### Gap 31: `docs/CONFIGURATION.md` references old architecture

| Aspect | Detail |
|--------|--------|
| **File** | `docs/CONFIGURATION.md:5` |
| **Problem** | Line 5: *"the Edge Worker reads this manifest at the start of the ReviewContainer Map-Reduce sequence"* — refers to old dual-compute architecture where Worker fetches `.codereview.yml` and container handles AST/SAST separately. |
| **Impact** | Low — documentation drift. |
| **Remediation** | Update to reflect unified container architecture: "The container reads the `.codereview.yml` manifest from the repo at the start of the review pipeline." |

### Gap 32: `ADMIN_ENDPOINTS.md` documents removed endpoints

| Aspect | Detail |
|--------|--------|
| **File** | `ADMIN_ENDPOINTS.md` (393 lines) |
| **Problem** | Documents `/admin/retry-metrics`, `/admin/concurrency-metrics`, `/admin/rate-limiter-metrics/{provider}` — all three endpoints are being removed (Gap 9). Also references `RateLimiterDO` metrics API. |
| **Impact** | Medium — operational documentation mismatch after migration. |
| **Remediation** | Rewrite to document only endpoints that remain: `GET /health`, `GET /metrics` (Prometheus), `GET/POST /dashboard/*`, `GET/POST /usage/*`. Remove references to retry, concurrency, and rate limiter admin endpoints. |

| G52 | 🟡 Medium | SIGTERM handler | (Already present in Phase 3 `server.ts` design) |
| G53 | 🔴 Critical | Tree-sitter build tools missing | Add `make` and `g++` to Alpine `apk add` in Dockerfile. `tree-sitter` npm install will fail without C compilers. |
| G54 | 🟡 Medium | OpenTelemetry SDK missing | Container `package.json` needs `@opentelemetry/sdk-node` and exporter packages to actually send traces. |
| G55 | 🔴 Critical | Container `env` missing vars | Add `HONEYCOMB_API_KEY`, `OTEL_EXPORTER_URL`, and `BUDGET_ALERT_WEBHOOK` to the `env` object constructed in Phase 4 `pipeline.ts`. Without these, OTel crashes and circuit breakers can't alert. |

## Implementation Order

> **Note:** The detailed step-by-step implementation order, including all 61 Gap Remediations (with the Queue retention fix), has been extracted into a centralized execution checklist. 
> 
> Please refer to `MIGRATION_TASKS.md` in the project root for the definitive execution plan.

---

*Generated: 2026-07-03*  
*Based on Cloudflare Containers GA pricing and features as of June 2026*
