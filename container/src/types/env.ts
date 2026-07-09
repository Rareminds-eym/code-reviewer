export interface ContainerEnv {
  // --- Secrets mapped via process.env ---
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_WEBHOOK_SECRET: string;
  // --- Configuration ---
  AI_PROVIDER?: 'claude' | 'gemini';
  USAGE_API_KEY?: string;
  CLIQ_CLIENT_ID?: string;
  CLIQ_CLIENT_SECRET?: string;
  CLIQ_REFRESH_TOKEN?: string;
  CLIQ_BOT_NAME?: string;
  CLIQ_CHANNEL_ID?: string;
  CLIQ_DB_NAME?: string;

  // --- Industrial-Grade Systems ---
  BUDGET_ALERT_WEBHOOK?: string;
  HONEYCOMB_API_KEY?: string;
  OTEL_EXPORTER_URL?: string;
  ENABLE_WEB_SEARCH?: string;
}

import type { KvProxy } from '../kv-proxy';

export type AIProvider = 'claude' | 'gemini';

export interface Env extends ContainerEnv {
  USAGE_METRICS: KvProxy;
  AUTH_KV: KvProxy;
  CACHE_KV: KvProxy;
  DEDUP_KV: KvProxy;
}

