export type AIProvider = 'claude' | 'gemini';

/**
 * Cloudflare Worker environment bindings.
 * Secrets set via: wrangler secret put <KEY>
 * Vars set via: wrangler.jsonc vars block or wrangler deploy --var
 */
export interface Env {
  // --- Secrets (never committed, set via wrangler secret put) ---
  /** Anthropic API key for Claude */
  ANTHROPIC_API_KEY: string;
  /** Google AI API key for Gemini */
  GEMINI_API_KEY: string;
  /** GitHub App ID (from GitHub Developer Settings → GitHub Apps) */
  GITHUB_APP_ID: string;
  /** GitHub App Private Key (PEM format, generated on the App settings page) */
  GITHUB_APP_PRIVATE_KEY: string;
  /** GitHub App Installation ID (from the URL after installing the App on a repo) */
  GITHUB_APP_INSTALLATION_ID: string;
  /** GitHub Webhook Secret (configured in the GitHub App webhook settings) */
  GITHUB_WEBHOOK_SECRET: string;
  /** Secret used to sign Dashboard session cookies (must be 32+ chars) */
  DASHBOARD_SESSION_SECRET: string;

  // --- Vars (non-secret, safe to set in wrangler.jsonc) ---
  /** Which LLM provider to use. Defaults to "claude". */
  AI_PROVIDER: AIProvider;
  /** Comma-separated list of target branches to review (e.g., "dev,main"). If unset, all branches are reviewed. */
  ALLOWED_TARGET_BRANCHES?: string;
  /** Optional API key for usage endpoints. If set, requires Bearer token authentication. */
  USAGE_API_KEY?: string;
  /** Dashboard username (plain-text var in wrangler.jsonc). Required for CLI/UI. */
  DASHBOARD_USERNAME?: string;
  /** Dashboard password (plain-text var in wrangler.jsonc). Required for CLI/UI. */
  DASHBOARD_PASSWORD?: string;
  /** Zoho OAuth Client ID */
  CLIQ_CLIENT_ID?: string;
  /** Zoho OAuth Client Secret */
  CLIQ_CLIENT_SECRET?: string;
  /** Zoho OAuth Refresh Token */
  CLIQ_REFRESH_TOKEN?: string;
  /** Zoho Cliq unique Bot Name */
  CLIQ_BOT_NAME?: string;
  /** Zoho Cliq Target ID (Channel ID, Chat ID, or User ID) to route reviews to */
  CLIQ_CHANNEL_ID?: string;
  /** Zoho Cliq Database name for GitHub↔Cliq user mapping (default: 'githubusermap') */
  CLIQ_DB_NAME?: string;

  // --- Industrial-Grade Systems (New) ---
  /** Webhook URL for budget alerts (Slack, PagerDuty, etc.) */
  BUDGET_ALERT_WEBHOOK?: string;
  /** Honeycomb API key for OpenTelemetry traces */
  HONEYCOMB_API_KEY?: string;
  /** OpenTelemetry exporter URL (alternative to Honeycomb) */
  OTEL_EXPORTER_URL?: string;
  /** Enable web search grounding for LLM reviews ("true" to enable). Default: "false". */
  ENABLE_WEB_SEARCH?: string;

  // --- Queues ---
  /** The Queue responsible for processing reviews in the background */
  REVIEW_QUEUE: Queue<ReviewMessage>;

  // --- Containers (Durable Object binding) ---
  /** The ReviewContainer DO namespace for dispatching reviews to ephemeral containers */
  REVIEW_CONTAINER: DurableObjectNamespace<import('../container-class').ReviewContainer>;

  // --- KV Namespaces (isolated by concern) ---
  /** KV for usage metrics and cost tracking (TTL: 30 days) */
  USAGE_METRICS: KVNamespace;
  /** KV for GitHub auth tokens (TTL: 30 min) */
  AUTH_KV: KVNamespace;
  /** KV for file content and repo config caching (TTL: 5 min) */
  CACHE_KV: KVNamespace;
  /** KV for webhook deduplication IDs (TTL: 1 hour) */
  DEDUP_KV: KVNamespace;
}

/**
 * The message payload sent from the HTTP webhook handler to the Queue Consumer
 */
export interface ReviewMessage {
  prNumber: number;
  title: string;
  repoFullName: string;
  headSha: string;
  /** The Check Run ID created by the webhook, so the queue consumer can update it */
  checkRunId?: number;
  /** GitHub username of the PR author */
  prAuthor: string;
  /** Request ID for distributed tracing across webhook → queue → LLM calls */
  requestId?: string;
  /** PR body/description for intent context. Capped at 2KB by the webhook handler. */
  prDescription?: string;
}
