# Code Reviewer Migration Task List

This task list breaks down the implementation of the Container migration plan into trackable steps, incorporating all 54 gap remediations.

## Phase 0: Prerequisites & Gap Fixes
- [x] **0a. Fix ReviewResponse Type**: Expand `container/src/types.ts` to include full pipeline output (verdict, findings, metrics).
- [x] **0b. Create ContainerEnv Type**: Add `container/src/types/env.ts` matching Worker secrets passed to `process.env`.
- [x] **0c. Fix ReviewRequest Type**: Remove `env` from body type (relying on `process.env` instead).
- [x] **0d. Replace Rate Limiter**: Write simple in-memory token bucket rate limiter for container.
- [x] **0e. Update Health Check**: Remove `checkQueueHealth()` from Worker; add `/ping` probe to container via KV proxy.
- [x] **0f. Clean Worker Env Type**: Remove `RATE_LIMITER` from `src/types/env.ts` (Keep `REVIEW_QUEUE` and `ReviewMessage`).
- [x] **0g. Delete Unused Libs**: Delete `degradation-levels.ts`, `service-levels.ts`, `subrequest-budget.ts`, `request-hedging.ts`, `adaptive-concurrency.ts`.
- [x] **0h. Remove DO Exports**: Delete `rate-limiter-do-export.ts` and remove DO export from `src/index.ts`.
- [x] **0i. Worker Routes Planning**: Document keeping `/metrics` and `/usage/*`, but deleting `/debug/cliq-mention`.
- [x] **0j. Script Updates**: Review `verify-deployment.sh` and `fix-critical-issues.sh` for stale architecture references.
- [x] **0k. Config & Build**: Create `container/vitest.config.ts`.
- [x] **0l. PKCS#8 Conversion (`crypto.subtle`)**: Update `github-auth.ts` to auto-detect and convert PKCS#1 keys to PKCS#8 for Node.js 20 compatibility.
- [x] **0m. Dockerfile Updates**: Add `make` and `g++` to Alpine `apk add` (for `tree-sitter` build), and ensure all 30+ new src files are copied.
- [x] **0n. Check Run Reaper**: Draft cron script to clean up orphaned `in_progress` checks if containers die unexpectedly.

## Phase 1: Environment & Config
- [x] **1a. `outboundByHost` Config**: Update `src/container-class.ts` with `ReviewContainer.outboundByHost` mapping `kv.internal`.
- [x] **1b. Container `envVars` Fix**: Implement `constructor(ctx, env)` in `container-class.ts` to explicitly map `env` to `this.envVars`. Without this, container `process.env` will be empty.
- [x] **1c. ContainerProxy Export**: Export `ContainerProxy` from `src/index.ts` to enable outbound interceptions.
- [x] **1d. Package.json Updates**: Add `@opentelemetry/api`, `@opentelemetry/sdk-node`, and `@opentelemetry/exporter-trace-otlp-http` to container. Add `build:container` script to root.
- [x] **1e. Wrangler Config**: Remove `RATE_LIMITER` DO from `wrangler.jsonc` (Keep the `queues` config!).

## Phase 2: KV Proxy & Core Libs
- [x] **2a. Rewrite `cachedGitHubFetch`**: Modify `src/lib/cache.ts` to accept a `KvCache` interface.
- [x] **2b. Create `kvProxy` Handler**: Implement `container/src/kv-proxy.ts` to make HTTP requests to the Worker.
- [x] **2c. Convert Lib KV Usage**: Update `src/lib/usage-tracker.ts`, `src/lib/webhook-dedup.ts`, and `src/lib/rate-limit.ts` to use the `kvProxy` when running in the container.
- [x] **2d. PEM Newline Parsing Fix**: Fix `importPrivateKey` in `src/lib/github-auth.ts` to parse literal `\n` from `.dev.vars` (Gap 60).
- [x] **2e. Fix Errors Dependency**: Ensure `errors.ts` is COPIED (not moved) to container.
- [x] **2f. Fix Retry Dependency**: Move BOTH `retry.ts` and `retry-with-backoff.ts` to the container.

## Phase 3: Container Pipeline Rewrite
- [x] **3a. Server Setup**: Rewrite `container/src/server.ts` to accept POST `/review`.
- [x] **3b. SIGTERM Handler**: Verify graceful shutdown logic (`isShuttingDown` flag + 14 min timeout) is in place.
- [x] **3c. Merge Pipeline Phase 1**: Combine git clone, AST, and SAST steps.
- [x] **3d. Merge Pipeline Phase 2**: Implement file classification, chunks, LLM calls.
- [x] **3e. Fix Pipeline Signatures**: Update `classifyFiles`, `fetchPreviousReviewFindings`, and `deriveVerdict` to match actual arguments.
- [x] **3f. MAP Concurrency Control**: Wrap `Promise.allSettled` for chunk reviews with `p-limit` (max 5 concurrent) to prevent 429s.
- [x] **3g. GitHub & Cliq Posting**: Wire up `updateCheckRun`, `postPRReview`, and `postToCliq` in the container.
- [x] **3h. OTel Config**: Update `container/src/observability/tracer.ts` to use HTTP OTLP exporter if running in container.
- [x] **3i. Env Mapping Fix**: Ensure `HONEYCOMB_API_KEY`, `OTEL_EXPORTER_URL`, and `BUDGET_ALERT_WEBHOOK` are mapped from `process.env` in `pipeline.ts`.
- [x] **3j. Runtime Env Validation**: Add explicit checks for missing critical environment variables at the top of `runReviewPipeline` to fail fast.

## Phase 4: Worker Simplification
- [x] **4a. Dispatch from Queue Consumer**: Update `src/handlers/queue.ts` (Queue Consumer) to `fetch()` the Container. Do **NOT** touch `webhook.ts` enqueueing logic (Gap 61).
- [x] **4b. Remove Secrets from Queue Payload**: Ensure `env: { ... }` block is entirely deleted from the `container.fetch()` POST body dispatched by the queue consumer. Secrets must pass via `Container.envVars`.
- [x] **4c. Queue Error Handling**: Update `queue.ts` to retry the message if the container returns a 5xx error or times out.
- [x] **4d. Remove Stale Admin Routes**: Delete `/admin/retry-metrics`, `/admin/concurrency-metrics`, `/admin/rate-limiter-metrics`.
- [x] **4e. Clean `index.ts`**: Delete stale imports, but **KEEP** the `queue: queueHandler` export!
- [x] **4f. Worker Env Validation**: Add runtime environment validation to the Edge Worker `fetch` handler to validate `GITHUB_WEBHOOK_SECRET` and dashboard credentials (Gap 59).

## Phase 5: Verification & Rollout
- [x] **5a. Migrate Tests**: Move applicable tests to `container/test/` and run `vitest`.
- [x] **5b. Local Build Test**: Run `npm run build:container` and verify TS compiles cleanly.
- [x] **5c. Update Docs**: Clean up `ADMIN_ENDPOINTS.md` and `CONFIGURATION.md`.
- [ ] **5d. Phased Rollout**: Implement 10% traffic split in worker for 48-hour monitoring.
