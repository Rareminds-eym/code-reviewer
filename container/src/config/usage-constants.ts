/**
 * Configuration constants for usage tracking system.
 * Extracted from magic numbers for maintainability.
 */

/**
 * KV Storage Configuration
 */
export const KV_CONFIG = {
    /** TTL for usage metrics in KV (90 days in seconds) */
    METRICS_TTL_SECONDS: 90 * 24 * 60 * 60, // 7,776,000 seconds
    
    /** Maximum number of items to return in list operations */
    MAX_LIST_LIMIT: 1000,
    
    /** Default number of items to return if not specified */
    DEFAULT_LIST_LIMIT: 100,
    
    /** Maximum retries for KV operations */
    MAX_RETRIES: 3,
    
    /** Initial retry delay in milliseconds */
    INITIAL_RETRY_DELAY_MS: 100,
    
    /** Maximum retry delay in milliseconds */
    MAX_RETRY_DELAY_MS: 5000,
} as const;

/**
 * Validation Limits
 */
export const VALIDATION_LIMITS = {
    /** Maximum length for repo owner/name */
    MAX_REPO_IDENTIFIER_LENGTH: 100,
    
    /** Maximum PR number */
    MAX_PR_NUMBER: 999_999_999,
    
    /** Maximum token count (10M tokens) */
    MAX_TOKEN_COUNT: 10_000_000,
    
    /** Maximum cost per review ($1000) */
    MAX_COST_PER_REVIEW: 1000,
    
    /** Maximum string length for safe logging */
    MAX_LOG_STRING_LENGTH: 100,
} as const;

/**
 * API Configuration
 */
export const API_CONFIG = {
    /** Request timeout in milliseconds */
    REQUEST_TIMEOUT_MS: 30_000,
    
    /** Maximum concurrent KV operations */
    MAX_CONCURRENT_KV_OPS: 10,
} as const;

/**
 * Schema Version
 * Increment when making breaking changes to PRUsageMetrics structure
 */
export const SCHEMA_VERSION = 1;

/**
 * Key Prefixes for KV Storage
 */
export const KV_KEY_PREFIXES = {
    USAGE: 'usage',
    LATEST: 'latest',
} as const;
