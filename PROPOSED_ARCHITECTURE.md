# Proposed Architecture: Dual-Agent Agentic Code Reviewer

## 1. Executive Summary

This document proposes a major evolution of the AI Code Reviewer architecture. We are transitioning from a **static, custom Map-Reduce parser pipeline** to a **Hardened, Build-Gated, Dual-Agent (Reviewer + Verifier) Pipeline** powered by Claude Code (or similar agentic CLI loops) running within an isolated Docker Sandbox.

The new model guarantees high-precision reviews by letting the agent dynamically explore the codebase (searching for context, utility files, configurations, and schemas on demand). It mitigates the risk of hallucinations and noisy critiques through a secondary verification agent that validates findings directly against the codebase.

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
        Consumer -->|6. Start Review DO| Sandbox[Container DO Sandbox]
        Consumer -->|7. Immediate Ack| Queue
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
            Agent -->|11. Spawn Subagents| R_Sub1[Subagent A: System Architect - 30+ Yrs Persona]
            Agent -->|11. Spawn Subagents| R_Sub2[Subagent B: SRE & Reliability - 30+ Yrs Persona]
            Agent -->|11. Spawn Subagents| R_Sub3[Subagent C: Security Engineer - 30+ Yrs Persona]
            
            R_Sub1 -->|Compile findings| PrimaryMerge[Raw Findings JSON]
            R_Sub2 -->|Compile findings| PrimaryMerge
            R_Sub3 -->|Compile findings| PrimaryMerge
        end

        %% Stage 2: Secondary Agent Loop (False Positive Investigator)
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
    Stage1 -->|Invoke LLM: Claude 3.5 Sonnet| LLM[LLM APIs: Sonnet / Flash]
    Stage2 -->|Invoke LLM: Gemini 2.0 Flash| LLM
    
    FinalMerge -->|14. Post Clean Reviews| PR[GitHub PR Comments]
    FinalMerge -->|15. Notify Zoho Cliq| Zoho[Zoho Cliq API domains: cliq.zoho.in, accounts.zoho.in]
    FailResult -->|Post Compiler Log| PR
    FailResult -->|Notify Zoho Cliq| Zoho
    
    class LLM provider;
    class PR,Zoho storage;

    %% Storage & KV
    Edge -->|Read/Write| KV[(Cloudflare KV namespaces: USAGE_METRICS, AUTH_KV, CACHE_KV, DEDUP_KV)]
    class KV storage;
```

### 2.1 Edge Worker Isolate Tier
Acts as the secure entry point and high-throughput routing layer.
* **Webhook Signature Auth**: Cryptographically verifies incoming GitHub payloads using HMAC-SHA256.
* **Asynchronous Queue Handoff**: The Queue Consumer starts the Container DO instance and **immediately acknowledges (`ack`)** the queue message. This decouples the 15-minute queue timeout boundary from the review execution window, preventing duplicate review loops.
* **Telemetry & Circuit Breakers**: Manages rate-limiting and budget allocations before spawning container environments.

### 2.2 Hardened Container Sandbox Tier
An ephemeral Docker container environment orchestrated by Cloudflare Containers.
* **Shallow Git Checkout (Delta Fetch & Patch Caching)**: Accesses the repository's `.git` folder from a persistent shared volume inside the container cluster. If it exists, the container runs `git fetch` to download only the new delta commits and checks out the target branch. If not cached, it performs a shallow clone (`--depth=50`) of both the PR and base branch (`main`), saving it to the shared volume. This reduces checkout times to milliseconds.
* **Build & SAST Verification Stage (Gatekeeper)**: Runs a single, whitelisted compilation build command (e.g., `npm run build` or `go build`) alongside local, zero-cost static analysis and SAST tools (`oxlint`, `biome`, `semgrep`).
  * If the compilation build **fails**, or if critical security vulnerabilities are flagged by the SAST tools, the logs/violations are written directly to the GitHub Check Run, **a Zoho Cliq notification containing the build error logs is sent**, and the review aborts immediately. **Zero LLM tokens are expended.**
  * If the stage **passes**, the static linter findings are consolidated and passed to the Stage 1 Agent as ground-truth inputs, allowing the agent to focus on logic and architectural issues.
* **Stage 1 (Primary Reviewer)**: The Review Coordinator CLI (Claude Code) dynamically searches the workspace and writes the initial code review findings.
* **Stage 2 (Secondary Verifier)**: The Verifier Coordinator investigates the reviewer's output to filter out false positives.

---

## 3. The Double-Agent Pipeline

### 3.0 Core Directive: Active Code Investigation (Zero-Trust)
To prevent agents from making assumptions based on outdated documentation or misleading inline comments, both Stage 1 (Reviewer) and Stage 2 (Verifier) coordinators and subagents operate under a strict **Zero-Trust Comments and Documentation Policy**:
* **Verify by Direct Code Sweep**: The agents must never trust assertions in comments or documents (e.g., *"This parameter is sanitized in the middleware"* or *"This API key is encrypted by default"*). Every claim must be verified by physically locating and reading the actual implementing source code.
* **Code is the Sole Source of Truth**: Inline comments, docstrings, and README markdown files are treated as untrusted historical assertions. If a comment contradicts the actual runtime code logic, the agent must flag the contradiction and review the code based strictly on the running code structure.

### 3.1 Stage 1: The Primary Review Coordinator
Spawns specialized subagents focusing on systemic and architectural issues under a **30+ Year Distinguished Principal Engineer** persona:
1. **The System Architect**: Inspects component boundaries, feature decoupling (e.g. FSD slices), API modularity, and backward compatibility.
2. **The SRE & Reliability Engineer**: Scans for async race conditions, unhandled promises (floating promises), resource leaks, memory footprint limits, structured logging, and tracer bindings.
3. **The Principal Security Engineer**: Audits JWT signatures, cryptographic validations, raw input verification, credential leakage, and authorization controls.

### 3.2 Stage 2: The Secondary Verification Coordinator
Analyzes each raw finding to filter out hallucinations and pedantic noise, ensuring developers only receive high-quality feedback:
1. **Context & Line Validator**: Performs read-only operations (`cat` / `grep`) to inspect the target file and lines, validating if the described issue physically exists.
2. **Policy & Rule Checker**: Audits findings against the repository's `.codereview.yml` configurations to suppress critiques that contradict team policies.
3. **Code Fix Verifier**: Audits the recommended refactored code blocks to ensure they do not introduce syntax errors or call invalid APIs.

Only findings validated by the Stage 2 Coordinator are posted back as inline reviews on the GitHub PR.

---

## 4. Execution Boundaries and Security

To run compilation builds and agent loops safely on untrusted PR code, the container implements the following security posture:

* **Privilege Demotion**: Switches context to a non-root system user (e.g., `node`) inside the Docker container immediately after initialization.
* **Read-Only Agentic Commands**: While the compilation stage can run a build script, the subsequent Agent Loops are strictly restricted to a whitelist of read-only terminal commands:
  * `find` and `ls` (locating and listing files)
  * `grep` / `ripgrep` (searching symbols/queries)
  * `cat` (reading files)
  * `git diff` and `git show` (to compare the PR head branch against the base branch / merge-base)
  * `graphify` (to query AST symbol paths and context mappings)
* **Outbound Whitelisting**: Outbound internet access is restricted using strict egress firewall rules. 
  * **Compilation Stage**: Permitted to reach only whitelisted package registries (e.g., `registry.npmjs.org` or the Go module proxy) to resolve dependencies.
  * **Agent Review Stage**: Outbound traffic is blocked for all destinations except the whitelisted LLM API gateways, GitHub API, Zoho Cliq API domains (`cliq.zoho.in` and `accounts.zoho.in`), and **authoritative search domains** (e.g., official docs like MDN, react.dev, typescriptlang.org, and CVE databases). This prevents untrusted PR files from exfiltrating secrets, while the container's egress whitelist permits Claude Code to natively execute its built-in web search tools and allows Zoho Cliq alerts to be dispatched successfully.
* **Internal KV Interception**: Outbound requests to KV namespaces are intercepted by the worker's DO proxy (`outboundByHost` mapping `kv.internal`), preventing direct exposure of the database credentials inside the container environment.

---

## 5. Token Budget Gating and SLA Policies

* **PR Budget Limit**: The container wrapper monitors token consumption across both agent stages. If cumulative usage reaches **100k tokens** (~$2.00), the loop is gracefully terminated, and findings are compiled from the current progress.
* **Tiered Model Strategy**: To optimize cost and latency, we run Claude 3.5 Sonnet (or Gemini 1.5 Pro) for the high-reasoning Primary Review Coordinator. The subagents and Stage 2 Verifier Coordinator use a faster, cheaper model (like Gemini 2.0 Flash or Claude 3.5 Haiku) for bulk verification.
* **Step-Level Timeouts**: Each subagent step is guarded by a maximum execution time (e.g., **90 seconds**). If a single command hangs (e.g., a test suite loop), it is killed.
* **Active Progress Heartbeats**: The container streams progress updates back to the GitHub Check Run API every **30 seconds** (e.g., `"Stage 1: Architect auditing auth.ts..."`), keeping the PR state alive and providing transparency.

### 5.1 Concurrency and Abort Semantics

* **Auto-Abort on Newer Commits**: If a developer pushes a new commit to the branch while a review is actively running inside the container DO, the container server receives the new request, triggers `AbortController.abort()`, terminates the active review pipeline immediately to free up resources/prevent token waste, and boots up the new review request.
* **Graceful SIGTERM Handling**: The container captures SIGTERM shutdown events, closes the HTTP listener socket immediately to prevent new requests, and waits up to 14 minutes for any active request pipelines to clean up and exit gracefully.

### 5.2 Retriggering and Smart Comment Deduplication

When a review is re-triggered (either by a new commit, a manual "Re-run" button click in GitHub, or a PR comment request), the pipeline handles it as follows to prevent spam and save resources:
* **Active Review Preemption**: The container's HTTP server intercepts the retrigger request, cancels the previous active pipeline running for that PR using its `AbortController`, and releases thread resources immediately.
* **Smart Inline Comment Deduplication**: Rather than blindly suppressing all repeated findings, the Verifier Coordinator queries GitHub for both **active** and **outdated/resolved** conversations:
  * **Unmodified Line with Active Comment**: If an unresolved AI comment is already open on the target line, the finding is suppressed to avoid creating duplicate threads (the developer can already see and interact with the existing thread).
  * **Code Modified but Still Broken**: If the developer pushed a commit editing the target file/line (which makes the old GitHub comment "outdated" or collapsed), but the issue remains unresolved, the Verifier **re-posts** the finding.
  * **Comment Manually Resolved but Code Still Broken**: If the developer marked the previous AI conversation as "Resolved" without actually fixing the code, the Verifier **re-posts** the critique to enforce compliance.
  * **Consolidated PR Review Comment**: The final, top-level PR review comment (the latest comment posted by the bot) compiles and lists *all* unresolved issues—including those whose inline comments were suppressed because their target code lines were unmodified—as a single, actionable checklist for the developer.

---

## 6. The "Lazy Senior Developer" (YAGNI) Review Philosophy

To prevent the agentic reviewer from over-engineering recommendations, adding unnecessary dependencies, or bloating PR review comments with pedantic noise, the pipeline adopts the YAGNI-first (You Ain't Gonna Need It) philosophy inspired by the **DietrichGebert/ponytail** guidelines:

### 6.1 The Decision Ladder for AI Critique Validation
Before the Stage 1 Reviewer raises a critique, or when the Stage 2 Verifier audits it, the agent must check findings against the following validation ladder:
1. **Is this issue truly critical?** (Does it fix a real bug, security vulnerability, or performance bottleneck? If it is just a stylistic preference, discard).
2. **Can it be done with existing code?** (Instead of proposing a new utility function, did they miss a helper that is already in the codebase? Enforce reuse).
3. **Can it use the Standard Library?** (Reject suggestions to add new external packages or dependencies for simple tasks that native language functions can solve).
4. **Is it a one-line fix?** (Prefer small, surgical, low-risk changes over wide-scale refactorings of correct code).

This "Lazy Senior Developer" model keeps code comments highly focused, keeps diffs clean, and ensures that suggested refactorings are simple and native.

---

## 7. Graphify Knowledge Graph Integration

To drastically reduce token usage and give the agents mathematically correct architectural awareness, the sandbox container integrates the **Graphify** toolchain (`pip install graphifyy`).

### 7.1 Automated Codebase Mapping (Gatekeeper Stage)
Immediately after the shallow clone and build verification steps complete:
1. The container runs `graphify .` locally to parse the codebase using Tree-sitter.
2. It generates `graphify-out/graph.json` (a queryable NetworkX knowledge graph) and `GRAPH_REPORT.md` (highlighting God Nodes and Surprising Connections).
3. The **Primary Review Coordinator** reads `GRAPH_REPORT.md` to identify the most highly connected nodes affected by the PR. This focuses subagent auditing on the highest-risk architectural code paths.

### 7.2 Querying via Graphify CLI (Token Optimization)
Instead of feeding raw files into the LLM context, the subagents use the Graphify query tools for targeted lookups:
* **Symbol Pathing**: Subagents execute `graphify path "AuthService" "UserSchema"` to trace paths between changed classes and dependency layers.
* **Semantic Querying**: Subagents execute `graphify query "Where is the webhook signature verified?"` to quickly find functional alignments without parsing directories manually.

By using Graphify's query-response model, the agents avoid dumping large volumes of codebase files into the LLM context window, reducing token usage by up to **70x** on large repositories and staying well within the $2.00 / 100k token PR budget.

---

## 8. Operational Gaps and Mitigation Strategies

During architectural design, we identified four operational gaps that must be mitigated for reliability at scale:

### 8.1 LLM Client Rate Limit Saturation (HTTP 429)
* **The Gap**: Spawning up to 6 concurrent subagents (coordinators, auditors, and verifiers) can trigger a burst of concurrent LLM API calls, easily saturating the model's Rate-Limit (RPM/TPM limits) and crashing the pipeline.
* **The Mitigation**: The container's local LLM client must implement a **local semaphore/concurrency queue** (e.g., capping concurrent outgoing API requests to `maxConcurrency = 3`) with automatic jittered retry-on-429.

### 8.2 JSON Parse Reliability on CLI Output
* **The Gap**: Claude Code CLI output is generated as text. Getting the primary reviewer to write *strictly valid* JSON (free of markdown fences or trailing prose) to `/tmp/raw_findings.json` is notoriously fragile.
* **The Mitigation**: Force JSON schema generation via System prompts, and wrap the JSON reader in a **defensive parser layer** (similar to `salvagedTruncatedArray` in `parse-findings.ts`) to strip code fences, clean leading/trailing prose, and handle minor structural errors.

### 8.3 Sandbox Disk Space Exhaustion (ENOSPC)
* **The Gap**: Ephemeral container environments have tight disk size limits. Shallow cloning massive monorepos or generating huge build outputs can exceed available space, causing system failures.
* **The Mitigation**: Configure Git checkouts with partial clone filters (`--filter=blob:none`) so only files touched by the PR or requested by the agent are downloaded, and configure a strict cleanup hook to prune `/tmp` builds immediately.

### 8.4 Redundant KV Proxied Calls
* **The Gap**: Since the container retrieves caches and usage trackers via `kv.internal` HTTP calls routed through the Durable Object, making repeated queries for identical cache keys during a review causes high network latency.
* **The Mitigation**: Implement a local, in-memory **LRU cache** inside the container process to cache read-only KV responses for the lifetime of the review request.
