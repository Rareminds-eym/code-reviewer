# Agentic Code Review Enhancement Plan

**Status:** Proposed  
**Target Branch:** `main`  
**LLM Cost:** \$0 for all new components  
**Est. Effort:** 3–5 days  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture (Detailed Inventory)](#2-current-architecture-detailed-inventory)
3. [Gap Analysis — What the Existing System Already Does](#3-gap-analysis--what-the-existing-system-already-does)
4. [Enhancement: Triage Gatekeeper](#4-enhancement-triage-gatekeeper)
5. [Enhancement: Dependency Audit Agent](#5-enhancement-dependency-audit-agent)
6. [Enhancement: Triage-Aware Pipeline Routing](#6-enhancement-triage-aware-pipeline-routing)
7. [Enhancement: Consensus Confidence Scorer](#7-enhancement-consensus-confidence-scorer)
8. [File Inventory — What to Create, What to Modify](#8-file-inventory--what-to-create-what-to-modify)
9. [Integration Diagram](#9-integration-diagram)
10. [Testing Strategy](#10-testing-strategy)
11. [Risk Register](#11-risk-register)
12. [Architecture Gaps (2026 Research-Based)](#12-architecture-gaps-2026-research-based)
13. [Deep Investigation Corrections (Applied)](#13-deep-investigation-corrections-applied)
14. [Appendix: Duplicate File Consolidation](#14-appendix-duplicate-file-consolidation)

---

## 1. Executive Summary

The code reviewer already operates a **multi-agent pipeline** with distinct specialized agents (MAP chunks, 3 persona sub-agents, verification agent, smart dedup, graphify). The enhancement does **not** add new LLM calls — instead it layers **routing, scheduling, and consensus** logic on top of existing signals to improve accuracy, reduce cost, and tighten feedback loops.

### Objectives

| Objective | Metric | Current | Target |
|-----------|--------|---------|--------|
| Reduce false positives | Findings suppressed by consensus | 0 | ≥20% of low-confidence findings |
| Skip unnecessary compute | PRs on fast track | 0% | ~15% (docs/typo/rename) |
| Catch dependency risks | Lockfile/workflow issues flagged | 0 | All new dep changes reviewed |
| Cost per PR | Avg tokens consumed | baseline | -10% (via triage skipping) |

### Design Principles

1. **Zero additional LLM tokens** — every new component is rule-based, regex-based, or arithmetic
2. **Reuse existing signals** — provenance, circuit breaker state, cost breaker state, hallucination risk
3. **Keep existing pipeline intact** — no changes to MAP, STAGE1, STAGE2, smart dedup, REDUCE
4. **Additive, not invasive** — each new component can be disabled with a single env var

---

## 2. Current Architecture (Detailed Inventory)

### 2.1 Edge Worker (`src/`)

```
src/
├── index.ts                   # Entry: routes requests to handlers
├── handlers/
│   ├── webhook.ts             # GitHub webhook ingestion, signature verify, queue push
│   └── queue.ts               # Queue consumer: dispatches to container
├── lib/
│   ├── plugins/               # 3 deterministic plugins (secrets, suspicious, ts-strict)
│   ├── cost-circuit-breaker.ts # Per-provider hourly/daily budget tracking
│   ├── review-delta.ts        # Filters previously-raised findings (Jaccard dedup)
│   ├── previous-review.ts     # Triple-source previous review extraction
│   ├── review-formatter.ts    # Fallback markdown formatter
│   ├── finding-clusters.ts    # Category-file + similarity clustering
│   ├── verdict.ts             # Deterministic verdict engine
│   ├── progressive-chunking.ts # File chunking for review
│   ├── github.ts              # GitHub API client
│   ├── github-auth.ts         # JWT app authentication
│   ├── retry.ts               # Retry with backoff
│   ├── rate-limit.ts          # Distributed rate limiting
│   ├── webhook-dedup.ts       # Delivery ID dedup
│   ├── payload-limit.ts       # Payload size guard
│   └── ...                    # (logger, cors, security, metrics, cache, etc.)
├── config/
│   ├── prompts/               # Modular prompt system (9 modules)
│   │   ├── base.ts            # Universal code quality rules
│   │   ├── composer.ts        # Per-chunk prompt assembly
│   │   ├── output-format.ts   # JSON output format instruction
│   │   ├── languages/         # TypeScript, Python, Go
│   │   ├── frameworks/        # React, Next.js, Express
│   │   ├── ecosystem/         # Zustand, TanStack, Tailwind, RHF
│   │   └── architecture/      # FSD rules
│   └── constants.ts           # App-wide constants
└── types/
    ├── env.ts                 # Worker bindings + ReviewMessage
    ├── review.ts              # ReviewFinding, FindingSeverity, etc.
    ├── github.ts              # GitHub API types
    ├── stack.ts               # Tech stack types
    └── usage.ts               # Usage metrics types
```

### 2.2 Container Sandbox (`container/src/`)

```
container/src/
├── server.ts                  # Hono HTTP server + graceful shutdown
├── pipeline.ts                # Core review pipeline (the big orchestrator)
├── git-ops.ts                 # Reference-cache git clone + checkout
├── ast-graph.ts               # Tree-Sitter AST symbol extraction
├── static-analysis.ts         # Semgrep, Oxlint, Biome execution
├── kv-proxy.ts                # KV namespace proxy for container
├── types/
│   ├── env.ts                 # Container env (mirrors edge types)
│   ├── review.ts              # ReviewFinding (DUPLICATE of src/types/)
│   ├── github.ts              # GitHub API types
│   ├── stack.ts               # Tech stack types (DUPLICATE)
│   └── usage.ts               # Usage metrics types (DUPLICATE)
├── config/
│   ├── constants.ts           # Models, chunk sizes, budgets
│   └── prompts/
│       ├── composer.ts        # Edge worker-style chunk prompt composer
│       ├── dual-agent.ts      # Stage 1 personas + Stage 2 verifier prompts
│       ├── base.ts            # (same as edge, duplicated)
│       ├── output-format.ts   # (same as edge, duplicated)
│       ├── languages/         # (same as edge, duplicated)
│       ├── frameworks/        # (same as edge, duplicated)
│       ├── ecosystem/         # (same as edge, duplicated)
│       └── architecture/      # (same as edge, duplicated)
└── lib/
    ├── llm/
    │   ├── index.ts           # callChunkReview, callSynthesizer (MAP/REDUCE)
    │   ├── adapter.ts         # LLMProviderAdapter abstract class + Factory
    │   ├── adapters/
    │   │   ├── claude.ts      # Claude implementation (572 lines)
    │   │   └── gemini.ts      # Gemini implementation (403 lines)
    │   ├── dual-agent.ts      # Stage 1 persona review + Stage 2 verification
    │   ├── parse-findings.ts  # JSON parser + hallucination filter
    │   ├── error-handler.ts   # Unified API error handler
    │   └── distributed-rate-limiter.ts  # Per-provider RPM/TPM limiting
    ├── graphify/              # 4-layer graph integration
    │   ├── index.ts           # Orchestrator
    │   ├── extraction-runner.ts
    │   ├── graph-parser.ts
    │   ├── query-service.ts
    │   ├── context-builder.ts
    │   └── types.ts
    ├── smart-dedup.ts         # PR comment dedup against existing threads
    ├── review-delta.ts        # (DUPLICATE of src/lib/)
    ├── verdict.ts             # (DUPLICATE of src/lib/)
    ├── finding-clusters.ts    # (DUPLICATE of src/lib/)
    ├── review-formatter.ts    # (DUPLICATE of src/lib/)
    ├── previous-review.ts     # (DUPLICATE of src/lib/)
    ├── web-search.ts          # Web search grounding (511 lines)
    ├── repo-config.ts         # .codereview.yml parser
    ├── stack-detector.ts      # Tech stack auto-detection
    ├── cache.ts               # KV caching layer
    ├── github.ts              # GitHub API (1255 lines)
    ├── github-auth.ts         # JWT auth
    ├── retry.ts               # Circuit breakers + retry
    ├── cost-circuit-breaker.ts# (DUPLICATE of src/lib/)
    ├── cliq.ts                # Zoho Cliq integration
    ├── usage-tracker.ts       # PR usage metrics
    ├── observability/         # OpenTelemetry tracing
    ├── plugins/               # Same 3 plugins as edge
    └── errors.ts              # Error types
```

### 2.3 Key Signals Already Available (Unused by Pipeline)

| Signal | Source | Currently Used By |
|--------|--------|------------------|
| Circuit breaker state | `retry.ts:circuitBreakers` | LLM adapter calls only |
| Cost breaker utilization | `cost-circuit-breaker.ts` | LLM adapter calls only |
| Hallucination risk | `parse-findings.ts:71` | Drops findings silently |
| Provenance (which agent raised) | Not tracked | Nowhere |
| Graphify availability | `graphify/index.ts` | Pipeline (blast radius only) |
| PR labels | `webhook.ts` → `prPayload` | Not consumed |
| Track classification | Not implemented | Not applicable |
| Dependency changes | `git-ops.ts` diff | Not consumed |

---

## 3. Gap Analysis — What the Existing System Already Does

Before adding anything, here is what the existing system **already handles** (to avoid duplication):

| Concern | Already Handled By | Quality |
|---------|-------------------|---------|
| Secret detection | `plugins/secrets.ts` — 6 regex patterns | ✅ Strong |
| Suspicious patterns | `plugins/suspicious.ts` — `console.log`, `TODO`, `debugger` | ✅ Strong |
| TypeScript strictness | `plugins/ts-strict.ts` — `@ts-ignore`, `any` | ✅ Strong |
| Code quality (MAP phase) | `callChunkReview` — Haiku/Flash per chunk | ✅ Strong |
| Architecture review | `dual-agent.ts` — Architect persona | ✅ Strong |
| Reliability review | `dual-agent.ts` — SRE persona | ✅ Strong |
| Security review | `dual-agent.ts` — Security persona | ✅ Strong |
| False positive filtering | `dual-agent.ts` → Stage 2 Gemini verification | ✅ Strong |
| PR comment dedup | `smart-dedup.ts` — 3 rules against existing threads | ✅ Strong |
| Previous review suppression | `review-delta.ts` — Jaccard title matching | ✅ Strong |
| Cross-file impact analysis | graphify blast radius | ✅ Strong |
| Web search grounding | Via both adapters | ✅ Strong |
| Cost budget control | CostCircuitBreaker in both adapters | ✅ Strong |
| Circuit breaker | 5 breakers in `retry.ts` | ✅ Strong |

**What is NOT handled:**

| Concern | Gap | Why It Matters |
|---------|-----|----------------|
| PR classification | All PRs get the same pipeline | Wastes \$ on docs-only PRs |
| Dependency risk review | No lockfile/Dockerfile/actions scan | Supply-chain attacks |
| Cross-agent confidence score | Stage 2 is binary verify/reject only | No fine-grained confidence |
| Agent scheduling (cost-aware) | Always runs 3 personas + 5 MAP chunks | No adaptation to budget |
| Provenance tracking | No record of which agent raised what | Can't build confidence |
| Fast track | Short PRs spin up full container | 15-30s cold start for 5-line PR |

---

## 4. Enhancement: Triage Gatekeeper

### 4.1 File: `src/handlers/triage.ts` (NEW)

**Purpose:** Classify PRs before they reach the queue, enabling cost-aware routing. Zero LLM calls — pure pattern matching.

**Interface:**

```typescript
// src/lib/triage-types.ts (NEW — shared types for triage)

export type ReviewTrack = 'fast' | 'full' | 'deep';

export interface TriageInput {
  files: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  labels: string[];
  title: string;
  body?: string;
  targetBranch: string;
  author: string;
  isNewContributor: boolean;
  totalAdditions: number;
}

export interface TriageDecision {
  track: ReviewTrack;
  reason: string;
  priorityFiles: string[];
  skipAgents: string[];     // e.g. ['graphify', 'stage1', 'web-search']
}
```

**Classification logic:**

```typescript
// src/lib/triage-rules.ts (NEW)

const DOC_PATTERNS = [
  /\.md$/i, /\.mdx$/i, /docs\//, /\.txt$/i,
  /README/i, /CHANGELOG/i, /LICENSE/i,
  /\.gitignore$/, /\.editorconfig$/, /\.prettierrc/,
  /\.yaml$/, /\.yml$/, /\.json$/,
];

const SECURITY_PATTERNS = [
  /functions\//, /middleware\//, /auth/,
  /routes\/api\//, /supabase/, /drizzle/, /prisma/,
];

const INFRASTRUCTURE_PATTERNS = [
  /Dockerfile/, /docker-compose/, /\.github\/workflows\//,
  /package\.json$/, /package-lock\.json$/, /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
];

export function triagePR(input: TriageInput): TriageDecision {
  const { files, labels, totalAdditions, targetBranch } = input;

  // ── Deep track triggers ──
  const hasSecurityLabel = labels.some(l =>
    ['security', 'critical', 'vulnerability', 'auth', 'audit'].includes(l.toLowerCase())
  );
  const touchesSecurityCode = files.some(f => SECURITY_PATTERNS.some(p => p.test(f.filename)));
  const isLargePR = totalAdditions > 1000;
  const touchesInfrastructure = files.some(f => INFRASTRUCTURE_PATTERNS.some(p => p.test(f.filename)));

  if (hasSecurityLabel || touchesSecurityCode) {
    return {
      track: 'deep',
      reason: 'security-sensitive',
      priorityFiles: files.filter(f => SECURITY_PATTERNS.some(p => p.test(f.filename))).map(f => f.filename),
      skipAgents: [],
    };
  }

  // ── Fast track triggers ──
  const allDocFiles = files.every(f => DOC_PATTERNS.some(p => p.test(f.filename)));
  const isTinyPR = totalAdditions < 50 && files.length <= 3;

  if (allDocFiles || isTinyPR) {
    return {
      track: 'fast',
      reason: allDocFiles ? 'docs-only' : 'trivial-change',
      priorityFiles: [],
      skipAgents: ['graphify', 'stage1', 'stage2', 'web-search', 'dependency-audit'],
    };
  }

  // ── Full track (default) ──
  const skipAgents: string[] = [];
  if (touchesInfrastructure) {
    // Don't skip anything — infrastructure changes need full review
  }

  return {
    track: isLargePR ? 'deep' : 'full',
    reason: isLargePR ? 'large-change' : 'default',
    priorityFiles: [],
    skipAgents,
  };
}
```

### 4.2 Modification: `src/types/env.ts`

Add `track` to `ReviewMessage`:

```typescript
export interface ReviewMessage {
  // ... existing fields ...
  /** PR classification from triage gatekeeper. If absent, container defaults to 'full'. */
  track?: 'fast' | 'full' | 'deep';
}
```

### 4.3 Modification: `src/handlers/webhook.ts`

Insert triage call before queue push (~line 700):

```typescript
import { triagePR } from '../lib/triage-rules';
import type { TriageInput } from '../lib/triage-types';

// Inside the pull_request handler, after getting pr details:
const triageInput: TriageInput = {
  files: [], // populated from the PR's changed files list (or delay to queue side)
  labels: prPayload.pull_request.labels?.map((l: any) => l.name) || [],
  title: pr.title,
  body: pr.body,
  targetBranch: pr.base.ref,
  author: pr.user.login,
  isNewContributor: false, // could check against a KV set of known contributors
  totalAdditions: pr.additions || 0,
};

// Defer full file list to container (we don't have it at webhook time)
// Use title/labels/branch/author for initial classification
const decision = triagePR(triageInput);

// Attach to queue message:
await env.REVIEW_QUEUE.send({
  // ... existing fields ...
  track: decision.track,
});
```

---

## 5. Enhancement: Dependency Audit Agent

### 5.1 File: `container/src/lib/llm/agents/dependency-audit.ts` (NEW)

**Purpose:** Scan dependency-related changes (lockfiles, Dockerfiles, CI workflows) for supply-chain risks. Zero LLM calls — pure regex and `fs` parsing.

**Where it fits in the pipeline:** After `runStaticAnalysis()` (~`pipeline.ts:443`), parallel to graphify extraction.

> **Design note — why standalone, not a plugin:** The existing `runStaticPlugins()` at `github.ts:644` only receives `tier1 + tier2` (code files like `.ts`, `.tsx`, `.js`). Lockfiles, Dockerfiles, and workflow YAML files never reach it. Dependency audit needs access to ALL changed files, so it runs as a standalone pipeline step with the full file list. The `StaticPlugin` interface could be extended in the future to accept all files, but that's out of scope.

**Interface:**

```typescript
import type { ReviewFinding } from '../../types/review';

export interface DependencyAuditInput {
  workDir: string;
  changedFiles: string[];
}

export interface DependencyFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  title: string;
  issue: string;
  category: 'security';
}

export async function runDependencyAudit(input: DependencyAuditInput): Promise<DependencyFinding[]>
```

**Scanning logic (4 scanners, each in its own function):**

```typescript
// ── Scanner 1: Lockfile diff analysis ──
async function scanLockfileDiff(workDir: string): Promise<DependencyFinding[]> {
  // Parse package-lock.json / yarn.lock for:
  // - New packages added (supply-chain risk)
  // - Version bumps across major versions (breaking changes)
  // - Packages changing from pinned to ranged versions
  // - Deprecated packages
  // Returns zero findings if no lockfile was changed
}

// ── Scanner 2: package.json analysis ──
async function scanPackageJson(workDir: string): Promise<DependencyFinding[]> {
  // Check for:
  // - New dependencies without types packages
  // - devDependencies in dependencies
  // - Engine field conflicts
  // - Peer dependency mismatches
}

// ── Scanner 3: Dockerfile analysis ──
async function scanDockerfile(workDir: string, changedFiles: string[]): Promise<DependencyFinding[]> {
  const dockerFiles = changedFiles.filter(f =>
    f.endsWith('Dockerfile') || f.endsWith('.dockerfile')
  );
  
  const findings: DependencyFinding[] = [];
  for (const df of dockerFiles) {
    const content = await readFile(join(workDir, df), 'utf-8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for mutable base image tags
      const fromMatch = line.match(/^FROM\s+(\S+):(\S+)/);
      if (fromMatch) {
        const tag = fromMatch[2];
        if (tag === 'latest' || tag === 'stable' || /^\d+\.\d+$/.test(tag)) {
          findings.push({
            severity: 'medium',
            file: df,
            line: i + 1,
            title: 'Mutable base image tag',
            issue: `Base image uses "${tag}" tag — pin to a specific digest (@sha256:...) for reproducible builds.`,
            category: 'security',
          });
        }
      }
      
      // Check for ADD from untrusted URLs
      if (/^ADD\s+https?:\/\//.test(line)) {
        findings.push({
          severity: 'high',
          file: df,
          line: i + 1,
          title: 'Untrusted URL added to image',
          issue: 'ADD from remote URL is not cached and may produce different images on rebuild. Consider using curl+wget in a RUN command with checksum verification.',
          category: 'security',
        });
      }
    }
  }
  return findings;
}

// ── Scanner 4: GitHub Actions workflow analysis ──
async function scanWorkflowFiles(workDir: string, changedFiles: string[]): Promise<DependencyFinding[]> {
  const workflowFiles = changedFiles.filter(f =>
    f.startsWith('.github/workflows/') && f.endsWith('.yml', '.yaml')
  );
  
  const findings: DependencyFinding[] = [];
  for (const wf of workflowFiles) {
    const content = await readFile(join(workDir, wf), 'utf-8');
    
    // Regex: uses: owner/repo@tag
    // Check if @tag is a mutable reference (branch name) vs fixed commit SHA
    const actionUses = content.matchAll(/^\s+-?\s*uses:\s+(\S+?)(?:@|#)(\S+)/gm);
    for (const match of actionUses) {
      const [, action, ref] = match;
      const isSHA = /^[a-f0-9]{40}$/i.test(ref) || /^[a-f0-9]{7,40}$/i.test(ref);
      const isSemver = /^\d+\.\d+\.\d+$/.test(ref);
      
      if (!isSHA && !isSemver) {
        findings.push({
          severity: 'medium',
          file: wf,
          title: 'Mutable action reference',
          issue: `${action} uses "${ref}" — pin to a commit SHA or semver tag for supply-chain security.`,
          category: 'security',
        });
      }
    }
  }
  return findings;
}
```

### 5.2 Integration in `container/src/pipeline.ts`

After static analysis results are collected (~line 443), insert:

```typescript
// ── Dependency Audit (parallel to graphify) ──
let dependencyFindings: DependencyFinding[] = [];
const hasDependencyChanges = existingAllowedFiles.some(f =>
  INFRASTRUCTURE_PATTERNS.some(p => p.test(f))
);

if (hasDependencyChanges) {
  withSpan('dependency-audit', async () => {
    logger.info(`[${requestId}] Running dependency audit...`);
    dependencyFindings = await runDependencyAudit({
      workDir,
      changedFiles: existingAllowedFiles,
    });
    logger.info(`[${requestId}] Dependency audit: ${dependencyFindings.length} findings`);
  });
}
```

**OTEL note:** All new components (`runDependencyAudit`, `filterByConsensus`, `buildAgentSchedule`) should be wrapped in `withSpan()` calls from `container/src/lib/observability/tracer.ts`. The tracer already has `withSpan()` for sync/async operations and gracefully degrades if OpenTelemetry SDK is absent.

---

## 6. Enhancement: Triage-Aware Pipeline Routing

### 6.1 File: `container/src/lib/llm/scheduler.ts` (NEW)

**Purpose:** Given the triage track + current system state (circuit breakers, cost breakers), produce an agent execution plan. Zero LLM calls.

**Interface:**

```typescript
export interface AgentSchedule {
  /** Agents to run, in order */
  phases: Array<{
    name: string;
    enabled: boolean;
    concurrency: number;
    timeoutMs: number;
    skipIf?: () => boolean;  // dynamic check at runtime
  }>;
  /** Override model selections */
  modelOverrides?: Partial<Record<string, string>>;
}

export function buildAgentSchedule(
  track: 'fast' | 'full' | 'deep',
  skipAgents: string[],
  env: Env
): AgentSchedule
```

**Design constraints:**
- Schedule must NOT depend on durable rate limiter state — `DistributedRateLimiter` at `container/src/lib/llm/distributed-rate-limiter.ts:28` uses in-memory `TokenBucket` and ignores the `_namespace` parameter. State does not survive container restarts.
- All schedule decisions should be recomputed fresh each invocation.
- The `claude.ts` adapter's `getChunkMaxTokens()` is dynamic (`Math.min(8192, 2048 + Math.floor(chunkContent.length / 50))`). The scheduler can influence chunk budgets indirectly via phase ordering (run graphify first to reduce chunk sizes with blast-radius context).

**Logic:**

```typescript
export function buildAgentSchedule(
  track: ReviewTrack,
  skipAgents: string[],
  env: Env
): AgentSchedule {
  
  const isEnabled = (agent: string) => !skipAgents.includes(agent);
  const canRunClaude = !circuitBreakers.anthropicMap.isOpen;
  const canRunGemini = !circuitBreakers.geminiMap.isOpen;
  
  // ── Fast track: minimal pipeline ──
  if (track === 'fast') {
    return {
      phases: [
        { name: 'static-analysis', enabled: true, concurrency: 5, timeoutMs: 60_000 },
        { name: 'map-chunks',      enabled: true, concurrency: 3, timeoutMs: 120_000 },
        { name: 'reduce',          enabled: true, concurrency: 1, timeoutMs: 60_000 },
      ],
      modelOverrides: {
        'map-chunks': canRunClaude ? 'claude-haiku-4-5' : 'gemini-2.5-flash',
      },
    };
  }
  
  // ── Full track: standard pipeline ──
  if (track === 'full') {
    return {
      phases: [
        { name: 'static-analysis',  enabled: true,                          concurrency: 5, timeoutMs: 60_000 },
        { name: 'graphify',         enabled: isEnabled('graphify'),         concurrency: 1, timeoutMs: 120_000 },
        { name: 'dependency-audit', enabled: isEnabled('dependency-audit'), concurrency: 1, timeoutMs: 30_000 },
        { name: 'map-chunks',       enabled: true,                          concurrency: 5, timeoutMs: 300_000 },
        { name: 'stage1-personas',  enabled: canRunClaude,                  concurrency: 3, timeoutMs: 300_000 },
        { name: 'stage2-verify',    enabled: canRunGemini,                  concurrency: 1, timeoutMs: 120_000 },
        { name: 'smart-dedup',      enabled: true,                          concurrency: 1, timeoutMs: 60_000 },
        { name: 'consensus',        enabled: true,                          concurrency: 1, timeoutMs: 5_000 },
        { name: 'reduce',           enabled: true,                          concurrency: 1, timeoutMs: 300_000 },
      ],
    };
  }
  
  // ── Deep track: full pipeline + forced deepReview ──
  return {
    phases: [
      { name: 'static-analysis',  enabled: true,              concurrency: 5, timeoutMs: 60_000 },
      { name: 'graphify',         enabled: true,               concurrency: 1, timeoutMs: 120_000 },
      { name: 'dependency-audit', enabled: true,               concurrency: 1, timeoutMs: 30_000 },
      { name: 'map-chunks',       enabled: true,               concurrency: 5, timeoutMs: 300_000 },
      { name: 'stage1-personas',  enabled: canRunClaude,       concurrency: 3, timeoutMs: 300_000 },
      { name: 'stage2-verify',    enabled: canRunGemini,       concurrency: 1, timeoutMs: 180_000 },
      { name: 'smart-dedup',      enabled: true,               concurrency: 1, timeoutMs: 60_000 },
      { name: 'consensus',        enabled: true,               concurrency: 1, timeoutMs: 5_000 },
      { name: 'reduce',           enabled: true,               concurrency: 1, timeoutMs: 300_000 },
    ],
    modelOverrides: {
      // Force better models for deep review
      'map-chunks': canRunClaude ? 'claude-sonnet-4-6' : 'gemini-2.5-flash',
    },
  };
}
```

### 6.2 Circuit Breaker Additions in `container/src/lib/retry.ts`

Add breakers for new agents:

```typescript
export const circuitBreakers = {
  // ... existing breakers ...
  triage: new CircuitBreaker('triage', { failureThreshold: 10, cooldownMs: 30_000 }),
  dependencyAudit: new CircuitBreaker('dependency-audit', { failureThreshold: 10, cooldownMs: 30_000 }),
  consensus: new CircuitBreaker('consensus', { failureThreshold: 10, cooldownMs: 10_000 }),
};
```

### 6.3 Modification: `container/src/pipeline.ts`

Wrap the pipeline body in a schedule check:

```typescript
// Near the top, after env setup:
const track = request.track || 'full';
const skipAgents = request.skipAgents || [];
const schedule = buildAgentSchedule(track, skipAgents, env);

// Later, instead of hardcoded agent execution:
if (schedule.phases.find(p => p.name === 'static-analysis')?.enabled) {
  // ... existing static analysis code ...
}

if (schedule.phases.find(p => p.name === 'dependency-audit')?.enabled) {
  // ... call dependency audit ...
}

if (schedule.phases.find(p => p.name === 'graphify')?.enabled) {
  // ... existing graphify code ...
}

if (schedule.phases.find(p => p.name === 'stage1-personas')?.enabled) {
  // ... existing Stage 1 code ...
}

if (schedule.phases.find(p => p.name === 'consensus')?.enabled) {
  // ... call consensus scorer ...
}
```

---

## 7. Enhancement: Consensus Confidence Scorer

### 7.1 File: `container/src/lib/llm/consensus.ts` (NEW)

**Purpose:** Assign confidence scores to findings based on how many independent agents agreed, which agents agreed, and hallucination risk signals. Zero LLM calls.

**Where it fits:** Between Stage 2 verification and the REDUCE phase. After all MAP + STAGE1 + STAGE2 results are collected, before `deduplicateFindings()`.

**Key concept — Provenance tracking:**

Every finding must carry provenance metadata about which agent raised it. This requires a new type and integration into existing agents.

```typescript
// ── Types ──

export type AgentSource =
  | 'static-analysis'
  | 'map-chunk'
  | 'architect'
  | 'sre'
  | 'security'
  | 'dependency-audit'
  | 'secrets-plugin'
  | 'suspicious-patterns'
  | 'ts-strict-plugin';

export interface Provenance {
  sources: AgentSource[];
  stage2Verified: boolean;
  hallucinationRisk: number;  // 0.0 = none, 1.0 = likely hallucination
}

export interface ProvenancedFinding extends ReviewFinding {
  provenance: Provenance;
}

export interface ConsensusResult {
  findings: ProvenancedFinding[];
  stats: {
    total: number;
    kept: number;
    downgraded: number;
    suppressed: number;
    averageConfidence: number;
  };
}
```

**Scoring algorithm:**

```typescript
// ── Agent authority weights ──
const AGENT_WEIGHTS: Record<AgentSource, number> = {
  'static-analysis':    1.00,  // Ground truth (linters, compilers)
  'secrets-plugin':     1.00,  // Regex patterns, deterministic
  'suspicious-patterns': 0.95, // Regex patterns, near-deterministic
  'ts-strict-plugin':   0.95,  // Regex patterns, near-deterministic
  'security':           0.90,  // Security persona (specialized)
  'architect':          0.80,  // Architect persona (deep reasoning)
  'dependency-audit':   0.85,  // Rule-based analysis
  'sre':                0.70,  // SRE persona (reliability)
  'map-chunk':           0.50,  // Fast heuristic chunk review
};

const CONSENSUS_THRESHOLDS = {
  keep: 0.70,   // ≥ 0.70 → keep at original severity
  downgrade: 0.40,  // ≥ 0.40 → downgrade to 'low'
  suppress: 0.00,   // < 0.40 → suppress entirely
};

// ── Confidence computation ──

export function computeConfidence(finding: ProvenancedFinding): number {
  const { sources, stage2Verified, hallucinationRisk } = finding.provenance;
  
  if (sources.length === 0) return 0;
  
  // Sum weights from unique sources that agreed on this finding
  const uniqueSources = [...new Set(sources)];
  const agreementScore = uniqueSources.reduce((sum, s) => sum + (AGENT_WEIGHTS[s] || 0), 0);
  const maxPossibleScore = Object.values(AGENT_WEIGHTS).reduce((a, b) => a + b, 0);
  
  // Normalize to 0-1 range
  let confidence = agreementScore / maxPossibleScore;
  
  // Apply hallucination risk discount
  confidence *= (1 - hallucinationRisk * 0.5);
  
  // Stage 2 verification floor: if verified, minimum 0.6
  if (stage2Verified) {
    confidence = Math.max(confidence, 0.6);
  }
  
  return Math.round(confidence * 100) / 100;  // Clamp to 2 decimals
}

// ── Finding filter ──

export function filterByConsensus(
  findings: ProvenancedFinding[]
): ConsensusResult {
  let kept = 0;
  let downgraded = 0;
  let suppressed = 0;
  
  const results: ProvenancedFinding[] = [];
  
  for (const finding of findings) {
    const confidence = computeConfidence(finding);
    
    if (confidence >= CONSENSUS_THRESHOLDS.keep) {
      // Keep at original severity
      results.push(finding);
      kept++;
    } else if (confidence >= CONSENSUS_THRESHOLDS.downgrade) {
      // Downgrade to low
      results.push({ ...finding, severity: 'low' });
      downgraded++;
    } else {
      // Suppress
      suppressed++;
    }
  }
  
  return {
    findings: results,
    stats: {
      total: findings.length,
      kept,
      downgraded,
      suppressed,
      averageConfidence: findings.reduce((s, f) => s + computeConfidence(f), 0) / findings.length,
    },
  };
}
```

### 7.2 Integration into Pipeline

**Modification to `container/src/pipeline.ts`:**

The MAP phase, Stage 1, and dependency audit must tag findings with provenance. This requires minimal changes to each agent's output.

For **MAP chunks** (`callChunkReview` → `pipeline.ts:550-632`):

```typescript
// After parsing chunk results, tag with provenance:
const provenancedFindings = result.findings.map(f => ({
  ...f,
  provenance: {
    sources: ['map-chunk'],
    stage2Verified: false,
    hallucinationRisk: hallucinationRiskScore(result),  // based on parse stability
  },
}));
```

For **Stage 1 personas** (`dual-agent.ts`):

```typescript
// Each persona already has its own output — tag it:
personaFindings.map(f => ({
  ...f,
  provenance: {
    sources: [persona],  // 'architect' | 'sre' | 'security'
    stage2Verified: false,
    hallucinationRisk: 0,
  },
}));
```

For **Stage 2** (`dual-agent.ts:349`):

```typescript
// After verification, set stage2Verified flag:
verifiedFindings.map(f => ({
  ...f,
  provenance: {
    ...f.provenance,
    stage2Verified: true,
  },
}));
```

Then, before the existing `deduplicateFindings()` and `clusterFindings()` calls at ~line 806:

```typescript
// ── Consensus pass (with OTEL span) ──
const consensusResult = await withSpan('consensus-scoring', async () => {
  return filterByConsensus(allProvenancedFindings);
});

logger.info('Consensus results', {
  total: consensusResult.stats.total,
  kept: consensusResult.stats.kept,
  downgraded: consensusResult.stats.downgraded,
  suppressed: consensusResult.stats.suppressed,
  avgConfidence: consensusResult.stats.averageConfidence,
});

// Strip provenance before passing to downstream (existing code expects ReviewFinding[])
const strippedFindings = consensusResult.findings.map(f => {
  const { provenance, ...rest } = f as any;
  return rest as ReviewFinding;
});

// Use strippedFindings instead of combinedFindings from here on
```

**Error handling note:** New components should use the existing error hierarchy from `container/src/lib/errors.ts`:
- `ValidationError` for invalid input (HTTP 400)
- `RateLimitError` for rate limit scenarios (HTTP 429)
- `StorageError` for KV/storage failures (HTTP 500)
- Avoid raw `new Error()` — use `normalizeError()` for unknown errors

### 7.3 How to Test

```typescript
// container/test/consensus.spec.ts

import { computeConfidence, filterByConsensus } from '../src/lib/llm/consensus';
import type { ProvenancedFinding } from '../src/lib/llm/consensus';

describe('Consensus Scorer', () => {

  describe('computeConfidence', () => {
    it('gives 1.0 for static analysis findings', () => {
      const finding: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['static-analysis'], stage2Verified: false, hallucinationRisk: 0,
      }};
      expect(computeConfidence(finding)).toBe(1.0);
    });

    it('gives 0.5+ for single map-chunk finding', () => {
      const finding: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0,
      }};
      expect(computeConfidence(finding)).toBe(0.5);
    });

    it('boosts confidence when multiple agents agree', () => {
      const finding: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['map-chunk', 'security', 'sre'],
        stage2Verified: true,
        hallucinationRisk: 0,
      }};
      const single = computeConfidence({ ...mockFinding, provenance: {
        sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0,
      }});
      const multi = computeConfidence(finding);
      expect(multi).toBeGreaterThan(single);
    });

    it('applies hallucination risk discount', () => {
      const clean: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0,
      }};
      const risky: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0.8,
      }};
      expect(computeConfidence(risky)).toBeLessThan(computeConfidence(clean));
    });

    it('enforces stage2 floor of 0.6', () => {
      const lowConfidence: ProvenancedFinding = { ...mockFinding, provenance: {
        sources: ['map-chunk'], stage2Verified: true, hallucinationRisk: 0.9,
      }};
      expect(computeConfidence(lowConfidence)).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe('filterByConsensus', () => {
    it('keeps high-confidence findings', () => {
      const findings = [
        { ...mockFinding, provenance: { sources: ['static-analysis'], stage2Verified: false, hallucinationRisk: 0 }},
      ];
      const result = filterByConsensus(findings);
      expect(result.stats.kept).toBe(1);
      expect(result.stats.suppressed).toBe(0);
    });

    it('suppresses low-confidence findings', () => {
      const findings = [
        { ...mockFinding, provenance: { sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0.9 }},
      ];
      const result = filterByConsensus(findings);
      expect(result.stats.suppressed).toBe(1);
    });

    it('downgrades medium-confidence findings to low', () => {
      const findings = [
        { ...mockFinding, severity: 'high', provenance: {
          sources: ['map-chunk'], stage2Verified: false, hallucinationRisk: 0,
        }},
      ];
      const result = filterByConsensus(findings);
      const downgraded = result.findings[0];
      expect(downgraded.severity).toBe('low');
    });
  });
});
```

---

## 8. File Inventory — What to Create, What to Modify

### 8.1 New Files (6 files)

| File | LLM Cost | Lines (est.) | Purpose |
|---|---|---|---|
| `src/lib/triage-types.ts` | \$0 | 20 | Shared triage type definitions |
| `src/lib/triage-rules.ts` | \$0 | 80 | Rule-based PR classification |
| `container/src/lib/llm/agents/dependency-audit.ts` | \$0 | 200 | Lockfile/Dockerfile/workflow scanner |
| `container/src/lib/llm/scheduler.ts` | \$0 | 120 | Agent execution planning |
| `container/src/lib/llm/consensus.ts` | \$0 | 200 | Confidence scoring + filtering |
| `container/src/config/constants.ts` additions | — | 20 | Agent weights + consensus thresholds |

### 8.2 Modified Files (6 files)

| File | Change | Risk |
|---|---|---|
| `src/types/env.ts` | Add `track` to `ReviewMessage` | Low — additive field |
| `src/handlers/webhook.ts` | Call triage, attach track to queue | Low — non-blocking |
| `container/src/pipeline.ts` | Add schedule check, dependency audit call, consensus pass | Medium — pipeline's core orchestrator |
| `container/src/lib/llm/dual-agent.ts` | Tag findings with provenance | Low — additive metadata |
| `container/src/lib/llm/index.ts` | Tag MAP findings with provenance | Low — additive metadata |
| `container/src/lib/retry.ts` | Add 3 new circuit breakers | Low — additive |

### 8.3 New Test Files (3 files)

| File | Tests (est.) |
|---|---|
| `test/triage-rules.spec.ts` | 12 |
| `container/test/consensus.spec.ts` | 15 |
| `container/test/dependency-audit.spec.ts` | 10 |

### 8.4 Config Changes

| File | Change |
|---|---|
| `wrangler.jsonc` | Add `ENABLE_TRIAGE` var (default: `"true"`) |
| `worker-configuration.d.ts` | **Re-generate after `wrangler.jsonc` changes** via `npx wrangler types` — this file is auto-generated (line 2: `Generated by Wrangler by running 'wrangler types'`) |
| `container/src/lib/repo-config.ts` | Extend `RepoReviewConfig` interface with optional `triage:` section (e.g., `triage: { track: 'fast', skipAgents: ['graphify'] }`) so repos can opt-in/out via `.codereview.yml` |
| `container/.env.example` | Document `ENABLE_TRIAGE`, `GRAPHIFY_SEMANTIC_DOCS` |
| `AGENTS.md` | Add triage and consensus to agent inventory |

**Graphify mode configuration:**
- `extraction-runner.ts:58-63` defines two modes: code-only (`graphify update`, no key needed) and semantic (`graphify extract --out --backend`, requires `GRAPHIFY_SEMANTIC_DOCS=1` + API key).
- Fast track: skip graphify entirely
- Full track: code-only mode (`graphify update`) — no LLM key needed
- Deep track: optionally enable semantic mode if `GRAPHIFY_SEMANTIC_DOCS=1` is set and a key is available

### 8.5 Files That Do NOT Change

**No changes needed:**
- `src/lib/review-delta.ts` — already works with existing findings
- `src/lib/previous-review.ts` — already works with existing findings
- `src/lib/plugins/*` — already work with existing findings
- `container/src/lib/llm/adapters/claude.ts` — no changes to LLM calls
- `container/src/lib/llm/adapters/gemini.ts` — no changes to LLM calls
- `container/src/lib/llm/parse-findings.ts` — hallucination risk already computed
- `container/src/lib/smart-dedup.ts` — already works with existing findings
- `container/src/lib/graphify/*` — no changes needed
- All prompt modules — no changes needed
- All test infrastructure — new tests follow existing patterns

---

## 9. Integration Diagram

```
PR Webhook arrives
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  EDGE WORKER                                                 │
│                                                              │
│  ┌─────────────────┐                                        │
│  │  triagePR()      │ ← title, labels, files, additions     │
│  │  (rule-based)    │ → track: fast | full | deep           │
│  └────────┬────────┘                                        │
│           │ attach track to ReviewMessage                    │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │  REVIEW_QUEUE   │ → Container                             │
│  └─────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  CONTAINER SANDBOX                                           │
│                                                              │
│  ┌─────────────────┐                                        │
│  │  buildAgentSchedule(track, skipAgents)                    │
│  │  → agent execution plan per phase                        │
│  └────────┬────────┘                                        │
│           ▼                                                  │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │  Static Analysis│    │  Dependency Audit│  ← NEW          │
│  │  (existing)     │    │  (rule-based)    │                 │
│  └────────┬────────┘    └────────┬─────────┘                │
│           │                      │                          │
│           ▼                      ▼                          │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │  Graphify       │    │  MAP Chunks      │                │
│  │  (existing)     │    │  (existing)      │                │
│  └────────┬────────┘    └────────┬─────────┘                │
│           │                      │                          │
│           ▼                      ▼                          │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │  Stage 1:       │    │  Stage 1:        │                │
│  │  Architect      │    │  SRE             │                │
│  └────────┬────────┘    └────────┬─────────┘                │
│           │                      │                          │
│           ▼                      ▼                          │
│  ┌─────────────────┐    ┌──────────────────┐                │
│  │  Stage 1:       │    │  ↓ all findings   │                │
│  │  Security       │    │  now have         │                │
│  └────────┬────────┘    │  provenance       │                │
│           │             └────────┬──────────┘               │
│           ▼                      ▼                          │
│  ┌─────────────────────────────────────────────┐            │
│  │  Stage 2: Verification (existing)            │            │
│  │  → adds stage2Verified flag to provenance   │            │
│  └───────────────────┬─────────────────────────┘            │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  Consensus Scorer   ← NEW (zero LLM)        │            │
│  │                                             │            │
│  │  For each finding with provenance:          │            │
│  │    1. Sum agent weights                    │            │
│  │    2. Normalize to 0-1                     │            │
│  │    3. Discount for hallucination risk      │            │
│  │    4. Apply stage2 verification floor      │            │
│  │                                             │            │
│  │  Then: ≥0.70 → keep    ≥0.40 → downgrade   │            │
│  │        <0.40 → suppress                    │            │
│  └───────────────────┬─────────────────────────┘            │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │  Smart Dedup (existing)                      │            │
│  │  → suppresses findings already on PR         │            │
│  └───────────────────┬─────────────────────────┘            │
│                      ▼                                      │
│  ┌─────────────────┐                                        │
│  │  REDUCE/Synth   │  (existing)                             │
│  │  → post review  │                                        │
│  └─────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
```

---

## 10. Testing Strategy

### 10.1 Triage Tests (`test/triage-rules.spec.ts`)

| Test Case | Input | Expected Track |
|-----------|-------|----------------|
| `.md` only files, < 50 additions | `fast` | docs-only |
| `.json` config files only | `fast` | trivial-change |
| File touches `functions/middleware/auth.ts` | `deep` | security-sensitive |
| PR has `security` label | `deep` | security-sensitive |
| > 1000 additions | `deep` | large-change |
| Mix of source + docs, < 200 additions | `full` | default |
| New contributor, first PR | `full` | default (no special handling) |

### 10.2 Consensus Tests (`container/test/consensus.spec.ts`)

| Test Case | Expected |
|-----------|----------|
| Single static-analysis finding | Confidence = 1.0, kept |
| Single map-chunk finding | Confidence = 0.5, downgraded |
| Same finding from architect + security + map-chunk | Confidence > 0.7, kept |
| High hallucination risk + no stage2 | Suppressed |
| Low hallucination risk + stage2 verified | Floor at 0.6 |
| Empty provenance → confidence = 0 | Suppressed |

### 10.3 Dependency Audit Tests (`container/test/dependency-audit.spec.ts`)

| Test Case | Expected |
|-----------|----------|
| `FROM node:latest` in Dockerfile | Mutable tag finding |
| `uses: actions/checkout@main` in workflow | Mutable ref finding |
| New package in lockfile | Dependency change finding |
| No changes to dep-related files | Empty findings |
| `FROM node:20.0.0-alpine@sha256:abc...` | No finding (pinned) |

### 10.4 Integration Test

**File:** `container/test/pipeline-integration.spec.ts` (or extend existing)

Verify the full pipeline still works with:
- `track: 'fast'` → skips graphify, personas, and web search
- `track: 'full'` → runs all phases as before
- `track: 'deep'` → forces deep review, runs dependency audit
- `skipAgents: ['graphify']` → graphify not called
- All circuit breakers closed → normal operation
- Circuit breaker open → graceful fallback

### 10.5 Running Tests

```bash
# Edge worker tests (existing + new triage tests)
npm test

# Container tests (existing + new consensus + dep audit tests)
npm test --prefix container
```

---

## 11. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Triage misclassifies a security PR as `fast` | Low | Medium — reviewer misses issues | Container still runs static analysis on fast track. Security-sensitive files override to `deep` regardless of triage output. |
| Consensus suppresses a real bug | Low | Medium — bug ships | Static analysis weights = 1.0 (never suppressed). Consensus only suppresses MAP-only findings. Stage 2 verification adds a 0.6 floor. |
| Dependency audit too noisy | Medium | Low — developer ignores findings | Findings tagged with `category: 'security'` and title prefix `[Dependencies]` so they can be auto-filtered. Only runs when dep-related files changed. |
| Pipeline timeout blows through 12-min budget | Low | High — review fails | All new components are synchronous, sub-1ms. Dependency audit is pure `fs`. Consensus is arithmetic. Scheduler reads existing cost breaker state. |
| Provenance tracking adds memory overhead | Low | Low — more JSON in memory | Provenance is stripped before REDUCE phase. Findings are typically < 100 per PR. |
| Duplicate file divergence | Medium | Medium — tests fail | Both `src/types/review.ts` and `container/src/types/review.ts` must stay in sync. Add a CI check for byte-for-byte equivalence. |

---

## 12. Architecture Gaps (2026 Research-Based)

The following gaps were identified through a targeted web search of current AI code review research (July 2026) and cross-referenced against this architecture. Each gap includes a severity rating and a concrete proposed fix.

| # | Gap | Severity | Research Source | Proposed Fix | Files Affected |
|---|-----|----------|----------------|--------------|----------------|
| 1 | **No feedback loop from dismissed findings** — The system never learns which finding patterns teams consistently dismiss. SRE persona can raise 10 false findings daily with zero adjustment. Memory-aware rule packs reduce FP noise 50% → 10-20% in weeks (SAST guide 2026). | 🔴 Critical | Snyk/Checkmarx/Semgrep FP reduction 2026 | Store dismissed finding signatures in KV (30d TTL). On each review, query KV for patterns matching current findings, downgrade their confidence by `patternMatch × 0.3`. Auto-disable agents with >80% dismissal rate over 7d. | `container/src/lib/llm/consensus.ts`, `container/src/kv-proxy.ts` |
| 2 | **No actionable comment rate metric** — Consensus scorer suppresses findings pre-emptively but can never validate whether its decisions were correct. No metric exists for "what fraction of posted comments did developers act on?" (Research: actionable rate is the #1 trust metric per Tian Pan 2026). | 🔴 Critical | Tian Pan "LLM Code Review in Production" May 2026 | Track per-PR metrics: comments posted, comments resolved, comments dismissed (via GitHub API check_run annotation reactions). Expose as a dashboard metric. Alert if actionable rate drops below 30%. | `container/src/pipeline.ts`, `container/src/lib/usage-tracker.ts` |
| 3 | **No AI-vs-human code differentiation** — 41% of commits are AI-generated with 1.7x more issues (CodeRabbit 2025-2026). Current system treats all code identically. No per-author or per-line AI-detection signal. Personas can't adjust scrutiny based on code origin. | 🔴 Critical | CodeRabbit 13M PRs study, Exceeds AI 2026 | Add `authorAssociation` and `aiGeneratedLikelihood` signal to file metadata. Stage 1 personas increase scrutiny on AI-predicted files. Consensus scorer applies 0.85x weight floor on AI-generated findings (they're more likely real). | `container/src/types/review.ts`, `container/src/lib/llm/dual-agent.ts` |
| 4 | **Single-point container crash loses all progress** — DO container crash mid-review (30s CPU limit, OOM) forces full restart: git clone, graphify, all 6 LLM calls. No checkpoint/restart exists. Durable Objects CPU limit is 30s per invocation. Cloudflare recommends Durable Workflows for multi-step orchestration. | 🔴 Critical | Cloudflare DO limits, Super Slurper blog Feb 2026 | Wrap pipeline phases as Durable Workflow steps. Each completed phase persists its output to R2/KV. On retry, resume from last completed phase instead of restarting. Estimated: saves 40-60% on retry latency. | `container/src/pipeline.ts`, `container/package.json` (add workflows dep) |
| 5 | **No inline suppression annotations** — Developers can't write `// codereview-ignore` to suppress known FPs at source. Every dismissal goes through GitHub UI. Same FP repeats on every PR until smart-dedup catches it. All major linters support this pattern (eslint, biome, semgrep). | 🔴 High | Universal linting convention (eslint-disable, semgrep-ignore) | Add `scanSuppressionComments()` plugin: parse all added lines for `codereview-ignore-next-line` and `codereview-ignore-file` pragmas. If a finding's file+line matches an ignore pragma, suppress it before consensus. Store suppressed count in metrics. | `container/src/lib/plugins/index.ts` (register new plugin), `container/src/lib/plugins/codereview-ignore.ts` (NEW) |
| 6 | **KV eventual consistency → dedup race window** — Webhook dedup reads `DEDUP_KV.get()` at `webhook.ts:457`. Force-push during active review can launch two containers for the same headSha. KV is eventually consistent by design. | 🟠 High | Cloudflare KV docs (eventual consistency) | Add a Durable Object (per-repo dedup guard) with strong consistency for the `review_completed` dedup key. Fallback: dual-check pattern (KV + DO). Only DO write is authoritative for dedup. KV is cache-only. | `src/handlers/webhook.ts`, `src/dedup-guard.ts` (NEW DO) |
| 7 | **6 simultaneous connections limit in container DO** — DO limit is 6 concurrent outgoing connections per request. With 5 MAP chunks + 3 persona calls + web search hitting Anthropic/GitHub in parallel, head-of-line blocking is likely. DistributedRateLimiter handles RPM but not connection concurrency. | 🟠 High | Cloudflare DO limits page | Add `ConnectionSemaphore` in adapter layer: max 3 concurrent Anthropic calls, max 2 concurrent GitHub API calls, max 1 concurrent web search. Queue remaining calls. Integrate with existing retry/backoff. | `container/src/lib/llm/adapters/claude.ts`, `container/src/lib/llm/adapters/gemini.ts`, `container/src/lib/connection-pool.ts` (NEW) |
| 8 | **No progressive / streaming feedback** — Large PR (3000 lines, 20 chunks) delivers zero feedback for 12+ minutes. Static analysis + dep audit results (deterministic, fast) could post as intermediate comments. Research shows time-to-first-feedback is the #2 trust metric. | 🟡 Medium | Tian Pan May 2026, HubSpot Sidekick Mar 2026 | After Phase 1 (static analysis) + Phase 2 (dependency audit) complete, post an "in-progress" Check Run update with preliminary findings label: "🔍 Static analysis complete (N findings found). LLM review running..." Then update to full results when REDUCE finishes. | `container/src/lib/github.ts`, `container/src/pipeline.ts` |
| 9 | **No degraded-mode fallback for graphify timeouts** — `extraction-runner.ts` gracefully handles timeouts and continues without blast radius. But there's zero fallback — no grep-based symbol cross-referencing. Cross-file impact analysis goes from "available" to "nothing" on timeout. | 🟡 Medium | Graphify design docs, gap analysis | After graphify timeout, run a lightweight `grepSymbolRefs()` fallback that scans all changed files for imports/exports/cross-references using regex. Produces a minimal cross-file impact map (no graph.json, just symbol matches). Ten lines of code, 100ms runtime. | `container/src/lib/graphify/index.ts` |
| 10 | **No historical agent performance tracking** — AGENT_WEIGHTS in consensus plan are hardcoded. If SRE persona produces 70% dismissed findings vs Security at 10%, no adjustment mechanism. Agent performance degrades silently over time (prompt drift). | 🟡 Medium | Multi-agent reliability patterns 2026 | Add `agentPerformance` KV store keyed by persona + repo + week. Track: findings raised, findings dismissed, findings upvoted, avg confidence. Expose in scheduler as `effectiveWeights`. Recalc weekly. Auto-lock an agent (skip phase) if performance drops below threshold for 2 consecutive weeks. | `container/src/lib/llm/scheduler.ts`, `container/src/lib/usage-tracker.ts` |

### Prioritization

| Priority | Gaps | Rationale |
|----------|------|-----------|
| P0 (must fix) | #1 feedback loop, #3 AI-vs-human diff | Directly impact review accuracy and trust |
| P1 (high value) | #4 checkpoint/restart, #5 inline suppression | Developer experience + reliability |
| P2 (cost/scale) | #6 DO dedup, #7 connection semaphore | Production stability under load |
| P3 (nice to have) | #8 streaming feedback, #9 graphify fallback, #2 actionable rate metric | Improved UX and observability |
| P4 (future) | #10 agent performance tracking | Long-term quality maintenance |

### Effort Estimate

Adding all 10 fixes: ~8-12 additional days beyond the base plan (total: ~11-15 days). Recommended as a Phase 2 effort after the core plan is shipped.

---

## 13. Deep Investigation Corrections (Applied)

The following items were identified during a "did you miss anything?" audit and have been incorporated into the plan above:

| # | Finding | Verdict | Resolution in Plan |
|---|---------|---------|-------------------|
| 1 | Dependency audit should be a plugin | **FALSE POSITIVE** — `runStaticPlugins()` at `github.ts:644` only receives tier1+tier2 (code files). Lockfiles/Dockerfiles never reach it. | Standalone step is correct. Added design note in §5.1 explaining rationale. |
| 2 | New components miss OTEL spans | **TRUE** — `tracer.ts` exists with `withSpan()`, `traceLLMCall()`, `traceGitHubCall()` | All new pipeline calls wrapped in `withSpan()` — see §§5.2, 6, 7.2. |
| 3 | KV proxy already has retry | **TRUE** — `kv-proxy.ts:9-23`, 2 retries, 100/200ms backoff | Documented in §5.2 integration code (no change needed — consensus/dep-audit use KV proxy for cost breaker reads). |
| 4 | `.codereview.yml` not extended | **TRUE** — `RepoReviewConfig` has no `triage`/`agents` field | Added optional `triage:` section extension in §8.4. |
| 5 | Wrong error types used | **TRUE** — `errors.ts` has `ValidationError(400)`, `RateLimitError(429)`, etc. | Added error handling guidance in §7.2. |
| 6 | Graphify has two modes | **TRUE** — `extraction-runner.ts:6-28`: code-only (`update`) vs semantic (`extract --out --backend`) | Three-tier graphify: fast=skip, full=code-only, deep=optionally semantic — documented in §8.4. |
| 7 | DistributedRateLimiter is local | **TRUE** — `distributed-rate-limiter.ts:28`: `_namespace: any // Ignored in container` | Added design constraint in §6 scheduler docs — schedule must not depend on durable rate limiter state. |
| 8 | `wrangler types` must re-run | **TRUE** — `worker-configuration.d.ts:2` is auto-generated | Added `npx wrangler types` step in §8.4. |
| 9 | Vitest configs differ | **TRUE** — `vitest.config.mts` (edge, Miniflare) vs `container/vitest.config.ts` (Node) | Triage tests go in `test/` (edge). Consensus/dep-audit tests go in `container/test/` (Node) — confirmed in §8.3. |
| 10 | `buildReviewChunks` integrates plugins | **TRUE** — `github.ts:644` calls `runStaticPlugins()` | Already covered by #1 correction — plugin integration is correct as-is. |

**Final verdict: 9/10 gaps were valid, 1 was a false positive.** These corrections are now baked into the sections above. See §5.1 (standalone design note), §5.2 (OTEL spans), §6 (rate limiter constraints), §7.2 (error handling), §8.4 (graphify modes, wrangler types, repo-config extension).

---

## 14. Appendix: Duplicate File Consolidation

The following files exist **byte-for-byte** in both `src/lib/` and `container/src/lib/`. Any plan that touches one must touch both:

| File | Both Locations | Action Needed by This Plan |
|---|---|---|
| `finding-clusters.ts` | `src/lib/` + `container/src/lib/` | None (unchanged) |
| `review-delta.ts` | `src/lib/` + `container/src/lib/` | None (unchanged) |
| `review-formatter.ts` | `src/lib/` + `container/src/lib/` | None (unchanged) |
| `verdict.ts` | `src/lib/` + `container/src/lib/` | None (unchanged) |
| `cost-circuit-breaker.ts` | `src/lib/` + `container/src/lib/` | None (unchanged) |
| `review.ts` (types) | `src/types/` + `container/src/types/` | **Must keep in sync** if provenance types are added |

**Recommendation:** These duplicates are a pre-existing code smell but are out of scope for this plan. The plan only reads from these files (for types and verdict utilities) and never modifies them. A future consolidation effort should extract them into a shared `@code-reviewer/shared` package.

---

## Implementation Order

| Step | Files | Depends On | Effort |
|---|---|---|---|
| 1. Add new types | `src/lib/triage-types.ts`, `src/types/env.ts` | None | 0.5h |
| 2. Build triage | `src/lib/triage-rules.ts`, modify `src/handlers/webhook.ts` | Step 1 | 2h |
| 3. Build consensus | `container/src/lib/llm/consensus.ts` | None | 3h |
| 4. Add provenance tracking | Modify `dual-agent.ts`, `llm/index.ts`, `pipeline.ts` | Step 3 | 2h |
| 5. Build dependency audit | `container/src/lib/llm/agents/dependency-audit.ts` | None | 3h |
| 6. Build scheduler | `container/src/lib/llm/scheduler.ts`, modify `retry.ts` | Steps 4, 5 | 2h |
| 7. Wire pipeline | Modify `container/src/pipeline.ts` | Steps 3-6 | 3h |
| 8. Write tests | All test files | Steps 2-7 | 3h |
| 9. Config + docs | `wrangler.jsonc`, `AGENTS.md` | Step 8 | 0.5h |
| **Total** | | | **~19h (3 days)** |
