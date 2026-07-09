# Implementation Plan: Build-Gated Dual-Agent Code Reviewer

**Status**: IMPLEMENTED ✅  
**Target Repository**: `gokulrajrz/code-reviewer`

---

## 1. Executive Summary & Design Overview

The code reviewer pipeline was transitioned to an asynchronous, build-gated, double-agent verification model with complete legacy cleanup.

```
[Webhook Event]
      │
      ▼
┌──────────────┐
│  Edge Worker │
└──────┬───────┘
       │ (Push to Queue)
       ▼
┌──────────────┐
│ REVIEW_QUEUE │ ◄── [visibility_timeout = 900s]
└──────┬───────┘
       │ (De-queue: Await container execution)
       ▼
┌────────────────────────────────────────────────────────┐
│               Container DO Sandbox                     │
│                                                        │
│ 1. Mount persistent .git cache & pull delta commits   │
│ 2. Execute compiler & SAST Gate (Biome, Oxlint, etc.)  │
│    ├── FAIL: Send Zoho Cliq Alert Card & Terminate     │
│    └── PASS: Run local "graphify ." indexing           │
│ 3. Stage 1 Review (Claude Sonnet 4 + YAGNI Prompts)    │
│ 4. Stage 2 Verifier (Gemini 2.0 Flash + Smart Dedup)   │
│ 5. Post inline comments & Consolidated PR Checklist   │
└────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Technical Changes

### Component 1: Cloudflare Edge Worker Configuration

#### [MODIFIED] [wrangler.jsonc](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/wrangler.jsonc)
- Increased `visibility_timeout` to 900s on the queue consumer via Wrangler CLI (removed statically from `wrangler.jsonc` to resolve wrangler schema warning).

---

### Component 2: Container Sandbox Provisioning

#### [MODIFIED] [Dockerfile](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/Dockerfile)
- Installed Alpine packages: `py3-numpy`, `py3-scipy`, `py3-matplotlib`, `py3-networkx`.
- Added `pip3 install graphifyy && graphify install` at build time.

---

### Component 3: Concurrency-Safe Git Reference Cache

#### [MODIFIED] [git-ops.ts](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/src/git-ops.ts)
- Implements bare mirror at `/mnt/git-cache/{repo}.git`.
- `--reference` clone with `--depth=50`, `--filter=blob:none`, `--single-branch`.
- SHA checkout with abort signal handling.

---

### Component 4: Build, SAST, and Graphify Gates

#### [MODIFIED] [pipeline.ts](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/src/pipeline.ts)
- **Build Gate**: Auto-detects package manager (npm/yarn/pnpm), installs deps, runs build. On failure posts Cliq card + CheckRun failure, returns 200 OK with `buildFailed: true`. Includes `/tmp` cleanup via `sh -c 'rm -rf /tmp/*'` after build (success and failure paths).
- **Graphify Indexing**: Runs `graphify .`, reads `graphify-out/graph.json`, injects graph context.
- **Stage 1**: Claude Sonnet 4 (`claude-sonnet-4-20250514`) with Architect/SRE/Security personas, concurrency 3.
- **Stage 2**: Gemini 2.0 Flash verification of Stage 1 findings.
- **Heartbeat**: 30s interval CheckRun progress updates during Stage 1 to prevent timeout.
- **Token Budget Gate**: Hard limit of 100k tokens (`MAX_STAGE1_TOKENS`) — skips remaining chunks when exceeded.

---

### Component 5: Smart Deduplication & Dual-Agent Prompts

#### [MODIFIED] [dual-agent.ts](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/src/lib/llm/dual-agent.ts)
- Stage 1: Claude Sonnet 4 with Architect/SRE/Security personas, concurrency 3.
- Stage 2: Gemini 2.0 Flash verification.
- 100k token budget gate.

#### [MODIFIED] [smart-dedup.ts](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/src/lib/smart-dedup.ts)
- Fetches existing GitHub PR review comments.
- 3 rules: suppress on unmodified active thread, re-post on modified/outdated line, re-post on resolved-but-broken.

#### [MODIFIED] [dual-agent prompts](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/container/src/config/prompts/dual-agent.ts)
- YAGNI validation ladder, zero-trust policy, 3 persona prompts, Stage 2 verifier prompt.

---

### Component 6: Legacy Code Cleanup

~800 lines of dead code removed across the following:

| File | Changes |
|------|---------|
| `container/src/pipeline.ts` | Removed `ReviewMessage` dead import, removed `totalSuppressedCount`/`dualAgentSuppressedCount` dead vars |
| `container/src/lib/llm/dual-agent.ts` | Removed dead `retryWithBackoff` import |
| `gemini.ts` adapters (both `src/` + `container/src/`) | Removed dead `Env` type import |
| `claude.ts` adapters (both `src/` + `container/src/`) | Removed dead `retryWithBackoff` + `Env` imports |
| `container/src/config/constants.ts` | Removed `MAX_LLM_CHUNKS`, `MAX_SYNTHESIZER_INPUT_CHARS`, `REVIEWABLE_ACTIONS`, `WORKER_VERSION` |
| `container/src/types/env.ts` | Removed `DASHBOARD_SESSION_SECRET`, `ALLOWED_TARGET_BRANCHES`, `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, `ReviewMessage` |
| `container/src/lib/github.ts` + `src/lib/github.ts` | Removed dead `importGraph` param from `buildGlobalContext` + stub at call sites |
| `usage.ts` (both `src/` + `container/src/`) | Removed "Legacy" comments from pricing table |
| `src/lib/retry-with-backoff.ts` + `container/src/lib/retry-with-backoff.ts` | Deleted entire files (265 lines each, fully dead) |
| `src/lib/observability/tracer.ts` | Deleted (Edge Worker copy — 408 lines, never imported). Container copy kept. |
| `src/index.ts` | Fixed: dashboard credential guard moved inside dashboard route handler (was blocking ALL endpoints including webhooks) |
| `src/lib/health-check.ts` | Fixed: Gemini API key now passed via `x-goog-api-key` header instead of URL query param |

---

## 3. Verification & Testing

### 3.1 All Tests Pass

```
Edge Worker: 22 files, 352 tests passed
Container:    7 files,  95 tests passed
Total:       29 files, 447 tests passed
```

### 3.2 TypeScript Compilation

Both projects compile cleanly with `tsc --noEmit` (0 errors).

### 3.3 Manual Test Scenarios (Post-Implementation)

1. **Compilation Breakage**: Build gate catches syntax errors, posts Cliq card + CheckRun failure, terminates before any LLM call.
2. **Floating Promise (SRE Persona)**: Stage 1 flags, Stage 2 verifies, inline comment posted.
3. **Smart Comment Deduplication**: Modified-line re-posts, unmodified-line suppresses, resolved-but-broken re-posts.
