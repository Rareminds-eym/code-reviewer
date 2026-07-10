# Task Checklist: Dual-Agent Build-Gated Reviewer

## Phases 1-7 — Implementation

- `[x]` **Phase 1: Configuration & Environment Setup**
  - `[x]` Configure queue `visibility_timeout` to 900 seconds using Wrangler CLI (removed from `wrangler.jsonc` to resolve schema warning).
  - `[x]` Modify `container/Dockerfile` to install Alpine packages: `py3-numpy`, `py3-scipy`, `py3-matplotlib`, `py3-networkx`.
  - `[x]` Modify `container/Dockerfile` to run `pip3 install --break-system-packages graphifyy && graphify install`.

- `[x]` **Phase 2: Concurrency-Safe Git Reference Cache (`container/src/git-ops.ts`)**
  - `[x]` Bare mirror at `/mnt/git-cache/[repoFullName].git`.
  - `[x]` Mirror bootstrapping: bare clone if missing, fetch updates if present.
  - `[x]` Reference checkout: `git clone --reference` into container local workspace.
  - `[x]` Added `--filter=blob:none` to prevent ENOSPC.
  - `[x]` Checkout to target commit (`git checkout [headSha]`).

- `[x]` **Phase 3: SAST Gatekeeper (`container/src/pipeline.ts`)**
  - `[x]` Run SAST linters (`oxlint`, `biome`, `semgrep`).

- `[x]` **Phase 4: AST Graphing with Graphify (`container/src/pipeline.ts`)**
  - `[x]` Run `graphify .` after clone.
  - `[x]` Inject `graphify-out/graph.json` into review context.

- `[x]` **Phase 5: Stage 1 Review Coordinator & Personas**
  - `[x]` Claude Sonnet 4 (`claude-sonnet-4-20250514`) as Primary Reviewer.
  - `[x]` Architect, SRE, Security persona prompts.
  - `[x]` YAGNI/Ponytail validation.
  - `[x]` Concurrency: 3 parallel persona calls per chunk.

- `[x]` **Phase 6: Stage 2 Verifier & Smart Deduplication**
  - `[x]` Gemini 2.0 Flash (Verifier).
  - `[x]` Fetch historical PR comment threads from GitHub API.
  - `[x]` Smart Dedup rules: suppress on unmodified line, re-post on modified/outdated, re-post on resolved-but-broken.
  - `[x]` Consolidate all unresolved issues as unified checklist.

- `[x]` **Phase 7: Validation and Integration Tests**
  - `[x]` Container test suite: `npm run test --prefix container` — **95 tests pass**.
  - `[x]` Edge Worker test suite: `npm run test` — **352 tests pass**.
  - `[x]` **Total: 447 tests passing**, both projects compile with 0 TypeScript errors.

## Operational Hardening (Post-Implementation)

- `[x]` **--filter=blob:none** — Added to git clone to prevent ENOSPC (Architecture §8.3).
- `[x]` **100k Token Budget Gate** — `MAX_STAGE1_TOKENS` in `dual-agent.ts`, skips remaining chunks when exceeded (Architecture §5).
- `[x]` **30s Heartbeat** — CheckRun progress updates during Stage 1 to prevent timeout (Architecture §8.6).
- `[x]` **Legacy Code Cleanup** — ~800 lines dead code removed across 14 files.
  - `[x]` Dead imports (ReviewMessage, retryWithBackoff, Env type)
  - `[x]` Dead exports (MAX_LLM_CHUNKS, MAX_SYNTHESIZER_INPUT_CHARS, REVIEWABLE_ACTIONS, WORKER_VERSION)
  - `[x]` Dead interface fields (DASHBOARD_SESSION_SECRET, ALLOWED_TARGET_BRANCHES, DASHBOARD_USERNAME, DASHBOARD_PASSWORD)
  - `[x]` Dead files (retry-with-backoff.ts x2, Edge Worker tracer.ts)
  - `[x]` Dead buildGlobalContext importGraph param
  - `[x]` Dead ReviewMessage interface in container types
  - `[x]` Pricing table "Legacy" comments

- `[x]` **Bug Fixes**
  - `[x]` Dashboard credential guard now scoped to dashboard routes (not blocking webhook/health).
  - `[x]` Gemini API key passed via `x-goog-api-key` header instead of URL query param.
  - `[x]` Filtered out deleted files in static analysis and AST parser using `existsSync` to avoid Biome/Oxlint file I/O errors (`No such file or directory (os error 2)`).
  - `[x]` Configured prompt composer rules to strictly forbid conversational/clarification questions in synthesizer outputs.

- `[x]` **Audit fixes**
  - `[x]` `/tmp` cleanup uses `sh -c 'rm -rf /tmp/*'` (execa doesn't expand globs without shell).
  - `[x]` Removed redundant double `clearInterval(heartbeat)`.

