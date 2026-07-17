# Code Reviewer Agent

An **Industrial-Grade** AI Code Reviewer powered by **Cloudflare Workers** and ephemeral **Docker Container Sandbox**. Automatically review GitHub Pull Requests using **Claude Sonnet 4** (default) or **Gemini 2.0 Flash**.

Built with battle-tested patterns from Netflix, AWS, Google SRE, and Stripe for production reliability at scale.

## 🏆 Industrial-Grade Features

- **🚦 Distributed Rate Limiting** - KV-backed distributed rate limiters to prevent IP and API credential abuse
- **💰 Cost Circuit Breaker** - Real-time budget tracking with hourly/daily limits and automatic circuit opening
- **🔄 Retry with Backoff** - Exponential backoff with jitter for transient provider failures
- **📊 Full Observability** - Health check, usage statistics, and Prometheus metrics endpoints active at the edge worker
- **📦 Isolated Sandbox Compute** - Secure Docker containers running tree-sitter AST parses and static analysis tools

---

## 🏗️ Architecture: Dual-Compute Model

This project operates on a heavily parallelized Dual-Compute pipeline:

1. **The Edge Worker (Isolate):** A heavily secured, incredibly fast routing tier handling Webhook ingestion (HMAC-SHA256 verified), PR queuing, JWT App Authentication, usage metrics tracking, and rate-limiting.
2. **The Review Sandbox (Docker Container):** Ephemeral Node.js containers orchestrated dynamically by Cloudflare. Handles heavy OS-level dependencies required for massive AST analysis: `git clone`, `tree-sitter`, `Biome`, `Oxlint`, and `Semgrep`.

```text
GitHub PR Event → Webhook POST → Worker Isolate Tier
                                   ├── Verify Signature
                                   ├── Push to Queue (code-reviewer-queue)
                                   └── Return 202 Accepted
                                        ↓
                         Worker Queue Consumer (Up to 15 min runtime)
                                   ├── Execute `.codereview.yml` filtering rules
                                   └── Dispatch `ReviewContainer` Durable Object
                                        ↓
                           Container Sandbox (Hono/Docker)
                                   ├── 📦 Git Clone (Shallow depth)
                                   ├── 🌳 Tree-Sitter AST Blast Radius computation
                                   └── 🛡️ Execute SAST (Semgrep, Oxlint, Biome)
                                        ↓
                         Worker Orchestrator (Map-Reduce)
                                   ├── Split files into scaling Cloudflare limits chunks
                                   ├── Map: Synthesize Chunks across LLMs using Blast Radius Context
                                   ├── Reduce: Deduplicate LLM Findings with SAST Errors
                                   └── Post PR Inline Comment via GitHub API
```

---

## 🌟 Capabilities

- **🧠 Ephemeral Container Checkouts**: Pulls your raw repository into an isolated sandbox to run native CLI operations.
- **🌳 AST Dependency Trees**: Generates a Tree-sitter powered codebase "blast radius" context so the LLM perfectly understands function relationships across unaffected files.
- **🛡️ SAST & Linter Guards**: Natively executes `oxlint`, `biome`, and `semgrep` alongside the AI agents to guarantee mathematically correct syntax validations.
- **⚙️ `.codereview.yml` Overrides**: Fully bypass zero-LLM tech stack inferences by throwing a `.codereview.yml` into your repo to enforce your team's custom codebase architecture standards.
- **📊 Metric Observability**: Complete JSON logging, REST APIs, and automated token counting budget thresholds.
- **💼 Zoho Cliq**: Pushes custom Rich-Card payloads to Cliq groups to announce merge-blocking check run outcomes. 

---

## 📖 Documentation

**[📚 Complete Documentation Index](./DOCUMENTATION_INDEX.md)** - Full guide to all documentation

### Quick Start
- **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** - Complete deployment procedures with verification
- **[ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md)** - API reference for monitoring and metrics

### Operations
- **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** - Incident response and troubleshooting procedures
- **[PHASE_COMPLETION_STATUS.md](./PHASE_COMPLETION_STATUS.md)** - Implementation status and roadmap

### Configuration
- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** - `.codereview.yml` setup and custom rules
- **[docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md)** - Zoho Cliq, Slack, and OAuth setup

---

## 🚀 Setup & Deployment

To deploy this entire multi-tier system to your own Cloudflare environment, strictly follow this execution order:

### 1. Requirements

Ensure you have a Cloudflare Account attached to a **Workers Paid Plan**. The heavy OS-level dependencies executed within the ephemeral sandbox significantly crush the Free-tier 50-subrequest ceilings (we leverage the Paid Plan's 1000 subrequest boundaries).

### 2. Environment Setup

```bash
# Clone and install
npm install
```

### 3. Build & Compile The Container Sandbox [CRITICAL 🛑]

The Cloudflare Container runs independently in Docker from the Javascript `dist/` directory. **You MUST transpile your TypeScript logic before deploying the worker.**

```bash
cd container/
npm run build
cd ..
```

*Warning: If you skip running `npm run build` inside the container folder, Cloudflare will build the Docker container using stale JavaScript files, breaking GitHub progress updates and telemetry!*

### 4. Create the Infrastructure Bindings

Configure the Cloudflare Message Queue and the isolated memory Key-Value namespaces:

```bash
npx wrangler queues create code-reviewer-queue

npx wrangler kv:namespace create USAGE_METRICS
npx wrangler kv:namespace create AUTH_KV
npx wrangler kv:namespace create CACHE_KV
npx wrangler kv:namespace create DEDUP_KV
```

Paste the generated Binding IDs directly into your `wrangler.jsonc` file.

### 5. Configure GitHub App & Secure Secrets

Register a GitHub App on your Developer Settings with *Checks (Read/Write)* and *Pull requests (Read/Write)* permissions. Subscribe it to *Pull request* webhook events.

Save all heavily secured production secrets natively into Cloudflare (DO NOT place these in plain-text configs):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY

# Paste the raw generated PEM file text string verbatim
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   

npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 6. Generate Types & Ignite Deploy

Create the isolated TypeScript environment boundaries, then push the Worker, Queue Consumers, and Container Registry securely to Cloudflare.

```bash
npx wrangler types
npx wrangler deploy
```

---

## 💸 Cost Structure & Controls

Industrial-grade cost controls with real-time budget tracking and automatic circuit breaking.

| Provider | Cost (per 1M tokens) | Budget Limits |
|---|---|---|
| **Cloudflare Runtime** | $0.00 | Unlimited |
| **Claude Sonnet 4** | $3.00 input / $15.00 output | $50/hour, $500/day |
| **Gemini 2.0 Flash** | $0.075 input / $0.30 output | $20/hour, $200/day |

**Cost Reduction**: 30-40% savings via rate limiting, adaptive concurrency, and graceful degradation.

## 📊 Monitoring & Observability

Access real-time metrics and system state via edge endpoints:

```bash
# General health check
curl https://your-worker.workers.dev/health

# Prometheus metrics
curl https://your-worker.workers.dev/metrics?format=prometheus

# Historical usage dashboard
curl -u "username:password" https://your-worker.workers.dev/dashboard
```

See [ADMIN_ENDPOINTS.md](./ADMIN_ENDPOINTS.md) for complete API reference.

## 🎯 Performance & Reliability

### Before Industrial-Grade Implementation
- ❌ 529 error rate: ~40%
- ❌ Chunk failure rate: 22%
- ❌ No rate limiting
- ❌ No cost controls
- ❌ Fixed concurrency

### After Industrial-Grade Implementation
- ✅ 529 error rate: <5%
- ✅ Chunk failure rate: <5%
- ✅ KV-backed rate limiting prevents 429s
- ✅ Cost circuit breaker prevents overruns
- ✅ Ephemeral sandbox container checkouts isolate compute
