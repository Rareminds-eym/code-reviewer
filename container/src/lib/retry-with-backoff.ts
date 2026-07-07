/**
 * RETRY WITH EXPONENTIAL BACKOFF
 * 
 * Replaces request hedging which wastes money on duplicate LLM calls.
 * For LLM calls, retry with backoff is more cost-effective than hedging.
 * 
 * Based on patterns from:
 * - AWS SDK Retry Strategy
 * - Google Cloud Client Libraries
 * - Stripe API Client
 * 
 * Key Features:
 * - Exponential backoff with jitter
 * - Configurable max retries
 * - Only retries transient errors (429, 503, 529)
 * - Metrics for retry effectiveness
 */

import { logger } from './logger';

export interface RetryConfig {
    /** Maximum number of retry attempts */
    maxRetries: number;
    /** Initial delay in ms */
    initialDelayMs: number;
    /** Maximum delay in ms */
    maxDelayMs: number;
    /** Backoff multiplier */
    backoffMultiplier: number;
    /** Add jitter to prevent thundering herd */
    jitter: boolean;
}

export interface RetryMetrics {
    totalRequests: number;
    retriedRequests: number;
    successAfterRetry: number;
    failedAfterRetries: number;
    averageRetries: number;
}

const DEFAULT_CONFIG: RetryConfig = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitter: true,
};

/**
 * Execute a request with exponential backoff retry.
 * Only retries on transient errors (429, 503, 529).
 * 
 * @example
 * const result = await retryWithBackoff(
 *   () => fetch('https://api.anthropic.com/v1/messages', { ... }),
 *   { maxRetries: 3 }
 * );
 */
export async function retryWithBackoff<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    config: Partial<RetryConfig> = {}
): Promise<T> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        const controller = new AbortController();
        
        try {
            const result = await fn(controller.signal);
            
            if (attempt > 0) {
                logger.info('[Retry] Request succeeded after retry', {
                    attempt,
                    totalAttempts: attempt + 1,
                });
            }
            
            return result;
        } catch (error) {
            lastError = error as Error;
            
            // Don't retry on last attempt
            if (attempt === cfg.maxRetries) {
                break;
            }
            
            // Only retry on transient errors
            if (!isTransientError(error)) {
                logger.debug('[Retry] Non-transient error, not retrying', {
                    error: lastError.message,
                });
                throw error;
            }
            
            // Calculate delay with exponential backoff
            const baseDelay = cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
            const cappedDelay = Math.min(baseDelay, cfg.maxDelayMs);
            
            // Add jitter to prevent thundering herd
            const delay = cfg.jitter
                ? cappedDelay * (0.5 + Math.random() * 0.5)
                : cappedDelay;
            
            logger.warn('[Retry] Transient error, retrying', {
                attempt: attempt + 1,
                maxRetries: cfg.maxRetries,
                delayMs: Math.round(delay),
                error: lastError.message,
            });
            
            await sleep(delay);
        }
    }
    
    logger.error('[Retry] All retry attempts failed', lastError, {
        totalAttempts: cfg.maxRetries + 1,
    });
    
    throw lastError!;
}

/**
 * Check if error is transient and should be retried.
 */
function isTransientError(error: any): boolean {
    // HTTP status codes that indicate transient errors
    const transientStatuses = [429, 503, 529, 502, 504];
    
    if (error.status && transientStatuses.includes(error.status)) {
        return true;
    }
    
    // Network errors
    if (error.name === 'NetworkError' || error.name === 'TimeoutError') {
        return true;
    }
    
    // Connection errors
    const transientMessages = [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'socket hang up',
    ];
    
    if (error.message && transientMessages.some(msg => error.message.includes(msg))) {
        return true;
    }
    
    return false;
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry controller with metrics tracking.
 */
export class RetryController {
    private metrics: RetryMetrics = {
        totalRequests: 0,
        retriedRequests: 0,
        successAfterRetry: 0,
        failedAfterRetries: 0,
        averageRetries: 0,
    };
    
    private totalRetries = 0;

    constructor(
        private readonly name: string,
        private readonly config: RetryConfig = DEFAULT_CONFIG
    ) {}

    /**
     * Execute request with retry and metrics tracking.
     */
    async execute<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
        this.metrics.totalRequests++;
        let attempts = 0;
        
        try {
            const result = await retryWithBackoff(fn, this.config);
            
            if (attempts > 0) {
                this.metrics.retriedRequests++;
                this.metrics.successAfterRetry++;
                this.totalRetries += attempts;
                this.metrics.averageRetries = this.totalRetries / this.metrics.retriedRequests;
            }
            
            return result;
        } catch (error) {
            if (attempts > 0) {
                this.metrics.retriedRequests++;
                this.metrics.failedAfterRetries++;
                this.totalRetries += attempts;
                this.metrics.averageRetries = this.totalRetries / this.metrics.retriedRequests;
            }
            throw error;
        }
    }

    /**
     * Get current metrics.
     */
    getMetrics(): RetryMetrics {
        return { ...this.metrics };
    }
}

/**
 * Global retry controllers per operation type.
 */
export const retryControllers = {
    claudeChunkReview: new RetryController('claude-chunk-review', {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitter: true,
    }),

    claudeSynthesis: new RetryController('claude-synthesis', {
        maxRetries: 3,
        initialDelayMs: 2000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
        jitter: true,
    }),

    geminiChunkReview: new RetryController('gemini-chunk-review', {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
        jitter: true,
    }),

    geminiSynthesis: new RetryController('gemini-synthesis', {
        maxRetries: 3,
        initialDelayMs: 2000,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
        jitter: true,
    }),
};

/**
 * Get all retry metrics for monitoring dashboard.
 */
export function getAllRetryMetrics(): Record<string, RetryMetrics> {
    return {
        claudeChunkReview: retryControllers.claudeChunkReview.getMetrics(),
        claudeSynthesis: retryControllers.claudeSynthesis.getMetrics(),
        geminiChunkReview: retryControllers.geminiChunkReview.getMetrics(),
        geminiSynthesis: retryControllers.geminiSynthesis.getMetrics(),
    };
}
