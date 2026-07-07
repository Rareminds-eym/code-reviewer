/**
 * Token usage data returned by LLM providers
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/**
 * Schema version for usage metrics
 * Increment when making breaking changes to enable migrations
 */
export const USAGE_METRICS_SCHEMA_VERSION = 1;

/**
 * Usage data for a single LLM call (chunk review or synthesis)
 */
export interface LLMCallUsage {
    phase: 'map' | 'reduce';
    chunkLabel?: string; // Only for map phase
    model: string;
    usage: TokenUsage;
    timestamp: string;
}

/**
 * Complete usage metrics for a PR review
 */
export interface PRUsageMetrics {
    /** Schema version for forward compatibility */
    schemaVersion: number;
    
    prNumber: number;
    repoFullName: string;
    headSha: string;
    provider: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    
    // LLM call details
    calls: LLMCallUsage[];
    
    // Aggregated token counts
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    
    // Cost estimation (in USD)
    estimatedCost: number;
    
    // Review metadata
    filesReviewed: number;
    chunksProcessed: number;
    findingsCount: number;
    status: 'success' | 'partial' | 'failed';
}

/**
 * Pricing per million tokens (as of March 2026)
 * Update these based on current provider pricing
 */
export const TOKEN_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
    // Claude Haiku - cheaper, faster model
    'claude-haiku-4-5-20251001': {
        inputPer1M: 0.80,   // $0.80 per 1M input tokens
        outputPer1M: 4.00,  // $4 per 1M output tokens
    },
    // Claude Sonnet - balanced model (default)
    'claude-sonnet-4-6': {
        inputPer1M: 3.00,   // $3 per 1M input tokens
        outputPer1M: 15.00, // $15 per 1M output tokens
    },
    // Legacy Claude 3.5 models
    'claude-3-5-haiku': {
        inputPer1M: 0.80,
        outputPer1M: 4.00,
    },
    'claude-3-5-sonnet': {
        inputPer1M: 3.00,
        outputPer1M: 15.00,
    },
    // Gemini models
    'gemini-2.5-flash-preview-04-17': {
        inputPer1M: 0.15,   // $0.15 per 1M input tokens
        outputPer1M: 0.60,  // $0.60 per 1M output tokens
    },
    'gemini-2.5-pro-preview-05-06': {
        inputPer1M: 1.25,   // $1.25 per 1M input tokens
        outputPer1M: 10.00, // $10 per 1M output tokens
    },
    // Legacy Gemini models
    'gemini-1.5-flash': {
        inputPer1M: 0.075,  // $0.075 per 1M input tokens
        outputPer1M: 0.30,  // $0.30 per 1M output tokens
    },
};

/**
 * Default pricing by provider (fallback when model not found)
 */
export const DEFAULT_PRICING = {
    claude: { inputPer1M: 3.00, outputPer1M: 15.00 },  // Sonnet 4 as default
    gemini: { inputPer1M: 0.15, outputPer1M: 0.60 },   // 2.5 Flash as default (our configured model)
};

/**
 * Calculate cost based on token usage and model
 */
export function calculateCost(
    provider: 'claude' | 'gemini',
    model: string,
    inputTokens: number,
    outputTokens: number
): number {
    // Try to find exact model pricing
    const pricing = TOKEN_PRICING[model] || DEFAULT_PRICING[provider];
    const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;
    return inputCost + outputCost;
}
