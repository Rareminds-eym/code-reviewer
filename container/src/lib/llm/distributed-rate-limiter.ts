export interface DistributedRateLimitConfig {
    provider: string;
    requestsPerMinute: number;
    inputTokensPerMinute: number;
    outputTokensPerMinute: number;
    adaptive: boolean;
}

export interface RateLimitRequest {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    timeoutMs?: number;
}

export interface RateLimitResponse {
    allowed: boolean;
    waitTimeMs: number;
    utilization: number;
    retryAfterMs?: number;
}

export class DistributedRateLimiter {
    private requestBucket: TokenBucket;
    private inputTokenBucket: TokenBucket;
    private outputTokenBucket: TokenBucket;

    constructor(
        _namespace: any, // Ignored in container
        private readonly config: DistributedRateLimitConfig
    ) {
        this.requestBucket = new TokenBucket(config.requestsPerMinute, 60000);
        this.inputTokenBucket = new TokenBucket(config.inputTokensPerMinute, 60000);
        this.outputTokenBucket = new TokenBucket(config.outputTokensPerMinute, 60000);
    }

    async acquire(request: RateLimitRequest): Promise<RateLimitResponse> {
        const { estimatedInputTokens, estimatedOutputTokens } = request;

        const hasCapacity = 
            this.requestBucket.hasCapacity(1) &&
            this.inputTokenBucket.hasCapacity(estimatedInputTokens) &&
            this.outputTokenBucket.hasCapacity(estimatedOutputTokens);

        if (hasCapacity) {
            this.requestBucket.acquire(1);
            this.inputTokenBucket.acquire(estimatedInputTokens);
            this.outputTokenBucket.acquire(estimatedOutputTokens);
            return {
                allowed: true,
                waitTimeMs: 0,
                utilization: this.calculateUtilization(),
            };
        }

        return {
            allowed: false,
            waitTimeMs: 0,
            utilization: this.calculateUtilization(),
            retryAfterMs: 5000,
        };
    }

    async release(actual: { inputTokens: number; outputTokens: number }): Promise<void> {
        this.inputTokenBucket.release(actual.inputTokens);
        this.outputTokenBucket.release(actual.outputTokens);
    }

    async reportError(_statusCode: number): Promise<void> {
        // Best effort: reduce multiplier dynamically or log
    }

    async getMetrics(): Promise<any> {
        return {
            provider: this.config.provider,
            requestsPerMinute: this.config.requestsPerMinute,
            inputTokensPerMinute: this.config.inputTokensPerMinute,
            outputTokensPerMinute: this.config.outputTokensPerMinute,
            currentUtilization: this.calculateUtilization(),
            queueLength: 0,
            totalRequests: 0,
            totalErrors: 0,
            adaptiveMultiplier: 1.0,
        };
    }

    private calculateUtilization(): number {
        const requestUtil = 1 - (this.requestBucket.available() / this.requestBucket.capacity());
        const inputUtil = 1 - (this.inputTokenBucket.available() / this.inputTokenBucket.capacity());
        const outputUtil = 1 - (this.outputTokenBucket.available() / this.outputTokenBucket.capacity());
        return Math.max(requestUtil, inputUtil, outputUtil);
    }
}

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private multiplier = 1.0;

    constructor(
        private readonly baseCapacity: number,
        private readonly refillWindowMs: number
    ) {
        this.tokens = this.capacity();
        this.lastRefill = Date.now();
    }

    capacity(): number {
        return Math.floor(this.baseCapacity * this.multiplier);
    }

    available(): number {
        return this.tokens;
    }

    hasCapacity(tokens: number): boolean {
        this.refill();
        return this.tokens >= tokens;
    }

    acquire(tokens: number): void {
        this.refill();
        if (this.tokens < tokens) {
            throw new Error('Insufficient tokens');
        }
        this.tokens -= tokens;
    }

    release(tokens: number): void {
        this.tokens = Math.min(this.capacity(), this.tokens + tokens);
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        
        if (elapsed < 1000) {
            return;
        }

        const tokensToAdd = (elapsed / this.refillWindowMs) * this.capacity();

        if (tokensToAdd >= 1) {
            this.tokens = Math.min(this.capacity(), this.tokens + Math.floor(tokensToAdd));
            this.lastRefill = now;
        }
    }
}
