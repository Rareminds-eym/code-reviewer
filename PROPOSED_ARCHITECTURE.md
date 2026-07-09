# Architecture: Dual-Agent Build-Gated Code Reviewer

## 1. Executive Summary

The AI Code Reviewer uses a **Hardened, Build-Gated, Dual-Agent (Reviewer + Verifier) Pipeline** running within an isolated Docker Sandbox on Cloudflare Containers. The architecture guarantees high-precision reviews through a secondary verification agent that validates findings directly against the codebase, with operational mitigations for reliability at scale.

---

## 2. Key Architecture Components

```mermaid
graph TD
    classDef worker fill:#ffccff,stroke:#333,stroke-width:2px;
    classDef DO fill:#cce6ff,stroke:#333,stroke-width:2px;
    classDef agent fill:#d2ffd2,stroke:#333,stroke-width:2px;
    classDef subagent fill:#ffd9b3,stroke:#333,stroke-width:2px;
    classDef verifiersub fill:#e6ccff,stroke:#333,stroke-width:2px;
    classDef error fill:#ffd2d2,stroke:#333,stroke-width:2px;
    classDef provider fill:#ffd6d6,stroke:#333,stroke-width:2px;
    classDef storage fill:#ffffcc,stroke:#333,stroke-width:2px;

    %% Entry
    GH[GitHub PR Event] -->|Webhook POST| Edge[Edge Worker Isolate]
    
    %% Isolate Tier
    subgraph Isolate ["Edge Worker Isolate Tier (Cloudflare Isolate)"]
        Edge -->|1. HMAC Verify| Auth[Webhook Signature Auth]
        Edge -->|2. Push| Queue[code-reviewer-queue]
        Edge -->|3. Coord| DO[RateLimiterDO (Durable Object)]
        Edge -->|4. Log & Track| Cost[Cost Circuit Breaker]
        Queue -->|5. De-queue| Consumer[Queue Consumer]
        Consumer -->|6. Sync Review DO| Sandbox[Container DO Sandbox]
        Sandbox -->|7. Ack Success| Queue
    end
    class Isolate,Edge,Auth,Queue,DO,Cost,Consumer worker;

    %% Container Sandbox Tier
    subgraph ContainerSandbox ["Container Sandbox (Hardened Docker Container)"]
        Sandbox -->|8. Git Checkout| Checkout[PR Code Checkout: Delta Cache / Fetch]
        Checkout -->|9. Execute Build & SAST| Build[Build & SAST Stage: Oxlint, Biome, Semgrep]
        
        %% Build short-circuit
        Build -->|Build Fails| FailResult[Post Build Error & Abort]
        
        %% Graphify
        Build -->|Build Passes| Graphify[10. Run Graphify: Index Codebase AST]
        Graphify -->|Generate graph.json| Agent[Claude Code Agent]
        
        %% Stage 1: Primary Agent Loop
        subgraph Stage1 ["Stage 1: Primary Review Coordinator (YAGNI & Ponytail)"]
            Agent -->|11. Spawn Subagents| R_Sub1[Subagent A: System Architect]
            Agent -->|11. Spawn Subagents| R_Sub2[Subagent B: SRE & Reliability]
            Agent -->|11. Spawn Subagents| R_Sub3[Subagent C: Security Engineer]
            
            R_Sub1 -->|Compile findings| PrimaryMerge[Raw Findings JSON]
            R_Sub2 -->|Compile findings| PrimaryMerge
            R_Sub3 -->|Compile findings| PrimaryMerge
        end

        %% Stage 2: Secondary Agent Loop
        subgraph Stage2 ["Stage 2: Secondary Verification Coordinator"]
            PrimaryMerge -->|12. Hand off| Verifier[Verifier Agent]
            Verifier -->|13. Spawn Subagents| V_Sub1[Subagent X: Context & Line Validator]
            Verifier -->|13. Spawn Subagents| V_Sub2[Subagent Y: Policy & Rule Checker]
            Verifier -->|13. Spawn Subagents| V_Sub3[Subagent Z: Code Fix Verifier]
            
            V_Sub1 -->|Filter out false positives| FinalMerge[Verified Findings JSON]
            V_Sub2 -->|Filter out false positives| FinalMerge
            V_Sub3 -->|Filter out false positives| FinalMerge
        end
    end
    class ContainerSandbox,Sandbox,Checkout,Build,FailResult,Agent,Graphify sandbox;
    class R_Sub1,R_Sub2,R_Sub3 subagent;
    class V_Sub1,V_Sub2,V_Sub3 verifiersub;
    class PrimaryMerge,FinalMerge,Verifier agent;

    %% Outgoing API calls (Container Egress Whitelist)
    Stage1 -->|Invoke LLM: Claude Sonnet 4| LLM[LLM APIs: Sonnet / Flash]
    Stage2 -->|Invoke LLM: Gemini 2.0 Flash| LLM
    
    FinalMerge -->|14. Post Clean Reviews| PR[GitHub PR Comments]
    FinalMerge -->|15. Notify Zoho Cliq| Zoho[Zoho Cliq API]
    FailResult -->|Post Compiler Log| PR
    FailResult -->|Notify Zoho Cliq| Zoho
    
    class LLM provider;
    class PR,Zoho storage;

    %% Storage & KV
    Edge -->|Read/Write| KV[(Cloudflare KV namespaces)]
    class KV storage;
```

### 2.1 Edge Worker Isolate Tier

- **Webhook Signature Auth**: HMAC-SHA256 verification of GitHub payloads.
- **Queue Visibility**: `visibility_timeout = 900s` prevents duplicate executions.
- **Telemetry & Circuit Breakers**: Rate-limiting and budget allocation before spawning containers.

### 2.2 Container Sandbox Tier

- **Git Checkout**: Bare mirror at `/mnt/git-cache/{repo}.git` with `--reference` clone, `--depth=50`, `--filter=blob:none` to prevent ENOSPC, and `--single-branch`.
- **Build & SAST Gate**: Runs build command, short-circuits on failure with Cliq alert. `/tmp` cleanup after build via `sh -c 'rm -rf /tmp/*'`.
- **Stage 1**: Claude Sonnet 4 (`claude-sonnet-4-20250514`) with 3 concurrent persona calls.
- **Stage 2**: Gemini 2.0 Flash verification with smart dedup against existing PR comments.

---

## 3. The Double-Agent Pipeline

### 3.0 Core Directive: Zero-Trust Code Investigation

Both stages operate under strict Zero-Trust: verify every claim by direct code sweep; comments and docs are untrusted historical assertions.

### 3.1 Stage 1: Primary Review Coordinator

Three personas (Architect, SRE, Security) run concurrently (concurrency: 3) on each chunk with YAGNI/Ponytail validation.

### 3.2 Stage 2: Secondary Verification Coordinator

Validates each finding context, checks team policies, verifies fix code correctness.

---

## 4. Operational Mitigations (Implemented)

| Gap | Mitigation | Status |
|-----|-----------|--------|
| 8.1 LLM Rate Limiting (HTTP 429) | Local semaphore `maxConcurrency = 3` with jittered retry | ✅ Implemented |
| 8.2 JSON Parse Reliability | Defensive parser layer (`parseFindings`) strips fences, handles truncation | ✅ Implemented |
| 8.3 ENOSPC (Disk Space) | `--filter=blob:none` on git clone + `sh -c 'rm -rf /tmp/*'` after build | ✅ Implemented |
| 8.4 Redundant KV Calls | In-memory LRU cache for KV responses | ✅ Implemented |

---

## 5. Token Budget Gating & SLA

| Policy | Value | Status |
|--------|-------|--------|
| Token Budget Gate | 100k tokens hard cap (`MAX_STAGE1_TOKENS`) | ✅ Implemented |
| CheckRun Heartbeat | 30s interval during Stage 1 | ✅ Implemented |
| Stage 1 Timeout | 300s per chunk | ✅ Implemented |
| Smart Dedup Rules | 3 rules (suppress/re-post/re-post) | ✅ Implemented |
| Active Review Preemption | AbortController on new commit | ✅ Implemented |

---

## 6. Model Selection

| Stage | Provider | Model | Purpose |
|-------|----------|-------|---------|
| Stage 1 | Claude | `claude-sonnet-4-20250514` ($3/$15 per 1M tokens) | Deep reasoning, 3 personas |
| Stage 2 | Gemini | `gemini-2.0-flash` ($0.15/$0.60 per 1M tokens) | Low-cost verification |

---

## 7. Testing

- **447 total tests** (352 Edge Worker + 95 Container) all passing.
- Both projects compile with **0 TypeScript errors**.
- Legacy cleanup removed ~800 lines of dead code, 3 dead files, and 5 dead exports.
- Bug fixes: dashboard credentials no longer block webhook/health endpoints; Gemini API key no longer leaked in URL.
