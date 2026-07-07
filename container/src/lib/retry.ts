/**
 * Industrial-grade retry utility with exponential backoff and jitter.
 * Used for resilient LLM API calls and external service interactions.
 */

import { logger } from './logger';
import { RateLimitError } from './errors';

export interface RetryConfig {
    /**
     * Maximum number of retry attempts. Default: 3
     */
    maxAttempts: number;
    /**
     * Initial delay in milliseconds. Default: 1000
     */
    initialDelayMs: number;
    /**
     * Maximum delay between retries in milliseconds. Default: 30000
     */
    maxDelayMs: number;
    /**
     * Exponential backoff multiplier. Default: 2
     */
    backoffMultiplier: number;
    /**
     * Add random jitter to prevent thundering herd. Default: true
     */
    jitter: boolean;
    /**
     * Retry only on these error classes (empty = retry all). Default: []
     */
    retryableErrors?: Array<new (...args: unknown[]) => Error>;
    /**
     * Custom function to determine if error is retryable. Default: retry network/timeout errors
     */
    isRetryable?: (error: unknown) => boolean;
    /**
     * Extract retry delay from error (for rate limit headers). Return undefined to use backoff.
     */
    getRetryDelayMs?: (error: unknown) => number | undefined;
}

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    jitter: true,
    retryableErrors: [],
    isRetryable: defaultIsRetryable,
    getRetryDelayMs: defaultGetRetryDelayMs,
};

/**
 * Default retryable error detection.
 * Retries on: network errors, timeouts, rate limits (429), server errors (5xx)
 */
function defaultIsRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();

    // Network errors
    const networkErrors = [
        'fetch failed',
        'network error',
        'connection refused',
        'connection reset',
        'econnrefused',
        'econnreset',
        'enotfound',
        'etimedout',
        'socket hang up',
    ];

    if (networkErrors.some(e => message.includes(e))) {
        return true;
    }

    // Timeout errors
    if (message.includes('timeout') || message.includes('abort')) {
        return true;
    }

    // HTTP status codes that are retryable
    const retryableStatusCodes = ['429', '500', '502', '503', '504'];
    if (retryableStatusCodes.some(code => message.includes(code))) {
        return true;
    }

    // Anthropic/Gemini specific retryable errors
    if (message.includes('overloaded') || message.includes('rate limit')) {
        return true;
    }

    return false;
}

/**
 * Default retry delay extraction - checks for RateLimitError with retry-after.
 */
function defaultGetRetryDelayMs(error: unknown): number | undefined {
    if (error instanceof RateLimitError) {
        return error.retryAfterMs;
    }
    return undefined;
}

/**
 * Calculate delay with exponential backoff and optional jitter.
 */
function calculateDelay(attempt: number, config: Required<RetryConfig>): number {
    const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

    if (!config.jitter) {
        return cappedDelay;
    }

    // Add ±25% random jitter
    const jitterAmount = cappedDelay * 0.25;
    const jitter = (Math.random() * 2 - 1) * jitterAmount;
    return Math.max(0, Math.floor(cappedDelay + jitter));
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RetryResult<T> {
    result: T;
    attempts: number;
    totalDelayMs: number;
}

/**
 * Execute an async function with exponential backoff retry logic.
 *
 * @param fn - The async function to execute
 * @param operationName - Name of the operation for logging
 * @param config - Retry configuration
 * @returns The result of the function execution
 * @throws The last error encountered after all retries are exhausted
 *
 * @example
 * const result = await retryWithBackoff(
 *   () => callLLM(prompt),
 *   'LLM chunk review',
 *   { maxAttempts: 3, initialDelayMs: 1000 }
 * );
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    operationName: string,
    config: Partial<RetryConfig> = {}
): Promise<RetryResult<T>> {
    const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
    let lastError: unknown;
    let totalDelayMs = 0;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        try {
            const result = await fn();

            if (attempt > 1) {
                logger.info(`${operationName} succeeded after ${attempt} attempts`, {
                    operation: operationName,
                    attempts: attempt,
                    totalDelayMs,
                });
            }

            return {
                result,
                attempts: attempt,
                totalDelayMs,
            };
        } catch (error) {
            lastError = error;

            // Check if this error type should be retried
            const shouldRetry = cfg.isRetryable(error);

            if (!shouldRetry || attempt === cfg.maxAttempts) {
                // Don't retry - propagate the error
                logger.error(`${operationName} failed permanently`, error instanceof Error ? error : undefined, {
                    operation: operationName,
                    attempts: attempt,
                    willRetry: false,
                });
                throw error;
            }

            // Calculate delay: use retry-after from error if available, otherwise exponential backoff
            const retryAfterMs = cfg.getRetryDelayMs(error);
            const delayMs = retryAfterMs ?? calculateDelay(attempt, cfg);
            totalDelayMs += delayMs;

            logger.warn(`${operationName} failed (attempt ${attempt}/${cfg.maxAttempts}), retrying in ${delayMs}ms`, {
                operation: operationName,
                attempt,
                maxAttempts: cfg.maxAttempts,
                delayMs,
                errorMessage: error instanceof Error ? error.message : String(error),
            });

            await sleep(delayMs);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError;
}

/**
 * Circuit breaker states.
 */
type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
    /**
     * Failure threshold before opening circuit. Default: 5
     */
    failureThreshold: number;
    /**
     * Time window for counting failures (milliseconds). Default: 60000
     */
    failureWindowMs: number;
    /**
     * Cooldown period before allowing test requests (milliseconds). Default: 30000
     */
    cooldownMs: number;
    /**
     * Success threshold in half-open state to close circuit. Default: 2
     */
    successThreshold: number;
}

const DEFAULT_CIRCUIT_CONFIG: Required<CircuitBreakerConfig> = {
    failureThreshold: 5,
    failureWindowMs: 60000,
    cooldownMs: 30000,
    successThreshold: 2,
};

/**
 * Circuit breaker for protecting against cascading failures.
 * Tracks failures in a time window and opens the circuit when threshold is exceeded.
 */
export class CircuitBreaker {
    private state: CircuitState = 'closed';
    private failures: number[] = []; // Timestamps of recent failures
    private successCount = 0;
    private lastFailureTime = 0;
    private config: Required<CircuitBreakerConfig>;

    constructor(
        private readonly name: string,
        config: Partial<CircuitBreakerConfig> = {}
    ) {
        this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    }

    /**
     * Check if circuit allows requests.
     */
    canExecute(): boolean {
        this.cleanupOldFailures();

        if (this.state === 'closed') {
            return true;
        }

        if (this.state === 'open') {
            const timeSinceLastFailure = Date.now() - this.lastFailureTime;
            if (timeSinceLastFailure >= this.config.cooldownMs) {
                this.state = 'half-open';
                this.successCount = 0;
                logger.info(`Circuit breaker '${this.name}' entering half-open state`);
                return true;
            }
            return false;
        }

        // half-open: allow test requests
        return true;
    }

    /**
     * Record a successful execution.
     */
    recordSuccess(): void {
        if (this.state === 'half-open') {
            this.successCount++;
            if (this.successCount >= this.config.successThreshold) {
                this.state = 'closed';
                this.failures = [];
                this.successCount = 0;
                logger.info(`Circuit breaker '${this.name}' closed (recovered)`);
            }
        }
    }

    /**
     * Record a failed execution.
     */
    recordFailure(): void {
        this.lastFailureTime = Date.now();
        this.failures.push(this.lastFailureTime);
        this.cleanupOldFailures();

        if (this.state === 'half-open') {
            this.state = 'open';
            logger.warn(`Circuit breaker '${this.name}' opened (failure in half-open state)`);
        } else if (this.state === 'closed' && this.failures.length >= this.config.failureThreshold) {
            this.state = 'open';
            logger.warn(`Circuit breaker '${this.name}' opened (${this.failures.length} failures in window)`);
        }
    }

    /**
     * Remove failures outside the time window.
     */
    private cleanupOldFailures(): void {
        const cutoff = Date.now() - this.config.failureWindowMs;
        this.failures = this.failures.filter(t => t > cutoff);
    }

    /**
     * Check if circuit is open
     */
    get isOpen(): boolean {
        return this.state === 'open';
    }

    /**
     * Check if circuit is half-open
     */
    get isHalfOpen(): boolean {
        return this.state === 'half-open';
    }

    /**
     * Get failure count
     */
    get failureCount(): number {
        this.cleanupOldFailures();
        return this.failures.length;
    }

    /**
     * Get current state for monitoring.
     */
    getState(): { state: CircuitState; failuresInWindow: number } {
        this.cleanupOldFailures();
        return {
            state: this.state,
            failuresInWindow: this.failures.length,
        };
    }
}

/**
 * Global circuit breakers for external services.
 * 
 * WARNING: These are in-memory and therefore local to the current Worker instance.
 * If the instance is recycled, the circuit breaker state resets to 'closed',
 * meaning a cascading failure might not be fully prevented across all edge nodes.
 * For true global circuit breaking, use Durable Objects or KV.
 */
export const circuitBreakers = {
    github: new CircuitBreaker('github-api', { failureThreshold: 5, cooldownMs: 30000 }),
    anthropicMap: new CircuitBreaker('anthropic-map', { failureThreshold: 3, cooldownMs: 60000 }),
    anthropicSynth: new CircuitBreaker('anthropic-synth', { failureThreshold: 2, cooldownMs: 45000 }),
    geminiMap: new CircuitBreaker('gemini-map', { failureThreshold: 3, cooldownMs: 60000 }),
    geminiSynth: new CircuitBreaker('gemini-synth', { failureThreshold: 2, cooldownMs: 45000 }),
};

/**
 * Get current states of all circuit breakers for monitoring.
 */
export function getCircuitBreakerStates(): Record<string, CircuitBreaker> {
    return { ...circuitBreakers };
}
