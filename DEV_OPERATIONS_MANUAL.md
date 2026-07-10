# Developer & Operations Manual: Build-Gated Dual-Agent Code Reviewer

This manual provides the comprehensive specifications, local testing protocols, multi-environment setups, and GitHub App configurations for the containerized double-agent code reviewer system.

---

## 1. System Architecture Overview

The system operates on a parallelized dual-compute pipeline:
1. **Edge Worker (V8 Isolate)**: Intercepts incoming webhooks (HMAC-SHA256 verified), manages rate limits, and pushes PR events to a Cloudflare Message Queue.
2. **Review Sandbox (Docker Container)**: Ephemeral Docker containers booted dynamically by Cloudflare. Handles heavy operations: `git clone`, `tree-sitter`, Biome/Oxlint/Semgrep checks, Graphify indexing, and multi-persona reviews.

```text
GitHub Webhook 
      │ (HMAC Verified)
      ▼
┌──────────────┐
│ Edge Worker  │
└──────┬───────┘
       │ (Push Queue)
      ▼
┌──────────────┐
│ REVIEW_QUEUE │ ◄── [visibility_timeout = 900s via CLI]
└──────┬───────┘
       │ (De-queue: Await DO container startup)
       ▼
┌────────────────────────────────────────────────────────┐
│ Review Sandbox Container (Hono / Node.js)              │
│ 1. Git clone usingbare mirror cache & blob filtering   │
│ 2. Compile projects and run Biome/Oxlint/Semgrep SAST  │
│    ├── FAIL: Send Zoho Cliq Failure card & exit 200    │
│    └── PASS: Run Graphify AST indexing                 │
│ 3. Stage 1: Claude Sonnet (Architect/SRE/Security)     │
│ 4. Stage 2: Gemini Flash verifier & false-positive gate│
│ 5. Smart Deduplication against existing PR comment logs│
│ 6. Post consolidated checklist and inline comments     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Multi-Environment Infrastructure Setup

To isolate development testing from production reviews, configure separate queues, KV namespaces, and secrets in Cloudflare using the `--env` flag.

### 2.1 Provisioning Development Resources
Run these commands in your authenticated terminal to create your development sandbox resources:

```bash
# 1. Create the dev Queue
npx wrangler queues create code-reviewer-queue-dev

# 2. Create the dev KV Namespaces
npx wrangler kv namespace create USAGE_METRICS --env dev
npx wrangler kv namespace create AUTH_KV --env dev
npx wrangler kv namespace create CACHE_KV --env dev
npx wrangler kv namespace create DEDUP_KV --env dev
```

### 2.2 Updating `wrangler.jsonc` Configuration
Bind the newly generated KV namespace IDs under the `env.dev` block inside `wrangler.jsonc`:

```json
	"env": {
		"dev": {
			"name": "code-reviewer-dev",
			"vars": {
				"AI_PROVIDER": "claude",
				"ALLOWED_TARGET_BRANCHES": "dev",
				"CLIQ_BOT_NAME": "codereviewbot-dev",
				"CLIQ_CHANNEL_ID": "prweb-dev",
				"CLIQ_DB_NAME": "githubusermap-dev",
				"ENABLE_WEB_SEARCH": "true"
			},
			"kv_namespaces": [
				{
					"binding": "USAGE_METRICS",
					"id": "1698dbe950604758b2ed4839bcd56a5e"
				},
				{
					"binding": "AUTH_KV",
					"id": "f976db7cdf154dcb89082bdf993f26f5"
				},
				{
					"binding": "CACHE_KV",
					"id": "0533a77b4a3841e7beb5ced6e7d5a42f"
				},
				{
					"binding": "DEDUP_KV",
					"id": "42b79bc174c04323bde728942c0cf200"
				}
			]
		}
	}
```

### 2.3 Configuring Operational Parameters (Visibility Timeout)
Cloudflare Queues static properties like visibility timeout must be set via the CLI rather than the configuration file (to avoid schema validation warnings). Set the dev queue lease visibility to 900 seconds (15 minutes):

```bash
npx wrangler queues update code-reviewer-queue-dev --visibility-timeout-secs 900
```

---

## 3. GitHub App Registration

Using **GitHub App Manifests**, you can create a test GitHub App with all required permissions pre-configured.

### 3.1 Quick Registration
Click this link to open the registration page on GitHub with the correct permissions pre-selected:

👉 **[Register pre-configured GitHub App](https://github.com/settings/apps/new?manifest=%7B%22name%22%3A%22Code%20Reviewer%20Agent%20%28Dev%29%22%2C%22url%22%3A%22https%3A%2F%2Fexample.com%22%2C%22hook_attributes%22%3A%7B%22url%22%3A%22https%3A%2F%2Fexample.com%22%2C%22active%22%3Atrue%7D%2C%22public%22%3Afalse%2C%22default_permissions%22%3A%7B%22checks%22%3A%22write%22%2C%22contents%22%3A%22read%22%2C%22metadata%22%3A%22read%22%2C%22pull_requests%22%3A%22write%22%7D%2C%22default_events%22%3A%5B%22pull_request%22%5D%7D)**

1. Scroll to the bottom and click **Create GitHub App**.
2. Go to **Private keys** at the bottom of the App Details page and click **Generate a private key**.
3. Download the `.pem` file and copy its contents.
4. Go to **Install App** on the left menu, install the app on your test repository, and copy the **Installation ID** from the trailing end of the URL page.

---

## 4. Local Development & Secrets Management

Wrangler uses environment variables configured locally in `.dev.vars` for development.

### 4.1 Secrets Configuration (`.dev.vars`)
Create a [`.dev.vars`](file:///mnt/E230EB0F30EAEA0D/Rareminds/agents/code-reviewer/.dev.vars) file in the root directory (this file is excluded from git commits by `.gitignore`):

```env
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIzaSy...
GITHUB_APP_INSTALLATION_ID=118659113
GITHUB_APP_ID=4244498
GITHUB_WEBHOOK_SECRET=my-test-secret
AI_PROVIDER=gemini

# Note: Escape PEM newlines using \n as a single-line double-quoted string:
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAsMeoAL6PAD2Ap...your-key-lines...\n-----END RSA PRIVATE KEY-----\n"

DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=admin123
```

### 4.2 Cloudflare Remote Secrets Deployment
To populate the production/dev environment secrets directly on Cloudflare's server, run:
```bash
npx wrangler secret put ANTHROPIC_API_KEY --env dev
npx wrangler secret put GEMINI_API_KEY --env dev
npx wrangler secret put GITHUB_APP_ID --env dev
npx wrangler secret put GITHUB_APP_INSTALLATION_ID --env dev
npx wrangler secret put GITHUB_WEBHOOK_SECRET --env dev
npx wrangler secret put GITHUB_APP_PRIVATE_KEY --env dev
```

---

## 5. Local Testing & Webhook Simulation

You can test the entire pipeline end-to-end locally using simulated payloads:

### 5.1 Run the local dev server
Start the local worker runtime (which automatically builds and binds your local Docker container):
```bash
npm run dev
```

### 5.2 Simulate a signed GitHub PR Webhook
To bypass the Worker's HMAC-SHA256 signature check, send a request signed with the secret `my-test-secret` using this `curl` command:

```bash
curl -X POST http://localhost:8787/ \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-delivery-123" \
  -H "X-Hub-Signature-256: sha256=0cab85fbf009939470a02bdada6b00ce08228f80b1842ffc7a7ea1f7450d2a48" \
  -d '{"action":"opened","number":42,"pull_request":{"number":42,"title":"feat: verify CI-deferred review pipeline","body":"Verifying CI-deferred review pipeline.","html_url":"https://github.com/gokulrajrz/code-reviewer/pull/42","diff_url":"https://github.com/gokulrajrz/code-reviewer/pull/42.diff","patch_url":"https://github.com/gokulrajrz/code-reviewer/pull/42.patch","commits":1,"additions":5,"deletions":0,"changed_files":1,"head":{"ref":"dev","sha":"a0dbe13e8b0d268593414986520e0ffad05eb6db"},"base":{"ref":"dev","sha":"a0dbe13e8b0d268593414986520e0ffad05eb6db"},"user":{"login":"developer"}},"repository":{"id":1,"full_name":"gokulrajrz/code-reviewer","html_url":"https://github.com/gokulrajrz/code-reviewer","default_branch":"main"},"sender":{"login":"developer","id":1}}'
```

---

## 6. Pipeline Stages & Verification Features

### 6.1 Concurrency-Safe Git Reference Cache
* Clones workspaces using `git clone --reference /mnt/git-cache/[repo].git` to avoid duplicate bandwidth and disk space usage.
* Uses `--depth=50` and `--filter=blob:none` to keep commits light and avoid `ENOSPC` disk depletion.
* The reference updates are bare (append-only), protecting concurrent sandbox runs from writing/reading collisions.

### 6.2 Codebase AST Indexing (Graphify)
* Runs `graphify .` after clone, parsing class/interface structures into `graphify-out/graph.json`.
* Injects God nodes (highly connected hubs) as context for review coordinators.

### 6.3 Stage 1 Persona Review (Claude Sonnet 4)
* Runs Claude Sonnet 4 (`claude-sonnet-4-20250514`) as the primary reviewer.
* Invokes three personas concurrently in parallel (Architect, SRE, Security).
* Enforces the **YAGNI (Ponytail) Validation Ladder** (Rung 1: Criticality, Rung 2: Existential checks, Rung 3: Stdlib usage, Rung 4: Surgical fix) and a **Zero-Trust Comments Policy** (direct verification of code, treating inline doc assertions as untrusted).
* Tracks a hard **100k Token ceiling** (`MAX_STAGE1_TOKENS`); stops reviews if exceeded.
* Runs a **30s heartbeat check** to prevent Check Run from timing out.

### 6.4 Stage 2 Verification & Smart Deduplication (Gemini 2.0 Flash)
* Gemini 2.0 Flash (`gemini-2.0-flash`) acts as a verification gate, validating Stage 1 findings in batches of 20 to eliminate false positives.
* **Smart Deduplication**: Checks existing PR review threads. Suppresses comment if the line is unmodified and an active thread is open; re-posts comment if the line was modified but code remains broken; re-posts comment if the thread was marked resolved but code is still broken.
* Consolidates all open/suppressed issues in a single unified markdown checklist.
