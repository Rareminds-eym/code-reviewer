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
  ENABLE_DUAL_AGENT?: string;

  // --- Agentic Review Pipeline Feature Flags (all default "false") ---
  /** Enable rule-based PR triage / track finalization ("true" to enable). Default: "false". */
  ENABLE_TRIAGE?: string;
  /** Enable the supply-chain dependency audit stage ("true" to enable). Default: "false". */
  ENABLE_DEPENDENCY_AUDIT?: string;
  /** Enable the consensus confidence router ("true" to enable). Default: "false". */
  ENABLE_CONSENSUS?: string;
  /** Enable the bounded agentic verifier ("true" to enable). Default: "false". */
  ENABLE_AGENTIC_VERIFIER?: string;
}

import type { KvProxy } from '../kv-proxy';

export type AIProvider = 'claude' | 'gemini';

/**
 * The classification of a PR determining how much review effort it receives.
 * Mirrors the edge worker's `ReviewTrack` (`src/types/env.ts`) — keep in sync.
 */
export type ReviewTrack = 'fast' | 'full' | 'deep';

/**
 * Independent feature flags for the hybrid two-tier review pipeline (R11.1).
 * Every flag defaults to `false`. Mirrors the edge worker's `PipelineFlags`.
 */
export interface PipelineFlags {
  /** Rule-based track finalization in the container. Default: false. */
  enableTriage: boolean;
  /** Standalone supply-chain scanner over all changed files. Default: false. */
  enableDependencyAudit: boolean;
  /** Rule-based confidence router over LLM findings. Default: false. */
  enableConsensus: boolean;
  /** Bounded LLM tool-use verification loop. Default: false. */
  enableAgenticVerifier: boolean;
}

export interface Env extends ContainerEnv {
  USAGE_METRICS: KvProxy;
  AUTH_KV: KvProxy;
  CACHE_KV: KvProxy;
  DEDUP_KV: KvProxy;
}

