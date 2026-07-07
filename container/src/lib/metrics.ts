import type { Env } from '../types/env';

/**
 * Operational metrics for monitoring and alerting.
 * Tracks request counts, latencies, errors, and business metrics.
 */

interface RequestMetrics {
    total: number;
    byMethod: Record<string, number>;
    byStatus: Record<string, number>;
    errors: number;
}

interface QueueMetrics {
    messagesProcessed: number;
    messagesFailed: number;
    avgProcessingTimeMs: number;
}

interface BusinessMetrics {
    prsReviewed: number;
    reviewsFailed: number;
    avgChunksPerPR: number;
    avgFindingsPerPR: number;
}

export interface OperationalMetrics {
    timestamp: string;
    period: '1h' | '24h' | '7d';
    requests: RequestMetrics;
    queue: QueueMetrics;
    business: BusinessMetrics;
    circuitBreakers: Record<string, { state: string; failures: number }>;
}

/**
 * In-memory metrics storage for the current worker instance.
 * 
 * WARNING: Cloudflare Workers are stateless. This data is lost on every cold start
 * and only represents the metrics for a single isolate/edge node.
 * In production, these should be aggregated externally (e.g., Datadog, Prometheus)
 * or stored in Durable Objects for accurate global counters.
 */
class MetricsCollector {
    private requestCounts = new Map<string, number>();
    private statusCounts = new Map<string, number>();
    private errorCount = 0;
    private requestLatencies: number[] = [];

    recordRequest(method: string, statusCode: number, latencyMs: number): void {
        const methodKey = method.toUpperCase();
        this.requestCounts.set(methodKey, (this.requestCounts.get(methodKey) || 0) + 1);

        const statusKey = statusCode.toString();
        this.statusCounts.set(statusKey, (this.statusCounts.get(statusKey) || 0) + 1);

        if (statusCode >= 400) {
            this.errorCount++;
        }

        // Keep only last 1000 latencies for memory efficiency
        this.requestLatencies.push(latencyMs);
        if (this.requestLatencies.length > 1000) {
            this.requestLatencies.shift();
        }
    }

    getRequestMetrics(): RequestMetrics {
        const byMethod: Record<string, number> = {};
        this.requestCounts.forEach((count, method) => {
            byMethod[method] = count;
        });

        const byStatus: Record<string, number> = {};
        this.statusCounts.forEach((count, status) => {
            byStatus[status] = count;
        });

        return {
            total: Array.from(this.requestCounts.values()).reduce((a, b) => a + b, 0),
            byMethod,
            byStatus,
            errors: this.errorCount,
        };
    }

    getLatencyStats(): { avg: number; p95: number; p99: number } {
        if (this.requestLatencies.length === 0) {
            return { avg: 0, p95: 0, p99: 0 };
        }

        const sorted = [...this.requestLatencies].sort((a, b) => a - b);
        const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
        const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;

        return { avg, p95, p99 };
    }

    reset(): void {
        this.requestCounts.clear();
        this.statusCounts.clear();
        this.errorCount = 0;
        this.requestLatencies = [];
    }
}

// Singleton instance for the worker
export const metricsCollector = new MetricsCollector();

/**
 * Record a request in the metrics collector.
 * Call this from the main request handler.
 */
export function recordRequestMetrics(
    method: string,
    statusCode: number,
    latencyMs: number
): void {
    metricsCollector.recordRequest(method, statusCode, latencyMs);
}

/**
 * Fetch operational metrics from KV storage and in-memory stats.
 */
export async function getOperationalMetrics(
    env: Env,
    period: '1h' | '24h' | '7d' = '24h'
): Promise<OperationalMetrics> {
    const requestMetrics = metricsCollector.getRequestMetrics();

    // Get circuit breaker states from the retry module
    const circuitBreakerStates: Record<string, { state: string; failures: number }> = {};
    try {
        const { getCircuitBreakerStates } = await import('./retry');
        const states = getCircuitBreakerStates();
        for (const [name, cb] of Object.entries(states)) {
            const breaker = cb as { isOpen: boolean; isHalfOpen: boolean; failureCount: number };
            circuitBreakerStates[name] = {
                state: breaker.isOpen ? 'open' : breaker.isHalfOpen ? 'half-open' : 'closed',
                failures: breaker.failureCount,
            };
        }
    } catch {
        // Circuit breaker states not available
    }

    // Fetch recent business metrics from KV
    let prsReviewed = 0;
    let reviewsFailed = 0;
    let totalChunks = 0;
    let totalFindings = 0;

    try {
        // Filter to only usage metrics keys — the KV namespace is shared with
        // rate limit buckets (ratelimit:*), dedup keys (delivery:*), and cache (github:*)
        const keys = await env.USAGE_METRICS.list({ prefix: 'usage:', limit: 100 });

        for (const key of keys.keys) {
            try {
                const data = await env.USAGE_METRICS.get(key.name);
                if (data) {
                    const metrics = JSON.parse(data);
                    prsReviewed++;
                    if (metrics.status === 'failed') {
                        reviewsFailed++;
                    }
                    totalChunks += metrics.chunksProcessed || 0;
                    totalFindings += metrics.findingsCount || 0;
                }
            } catch {
                // Skip invalid entries
            }
        }
    } catch {
        // KV access failed, use defaults
    }

    const avgChunksPerPR = prsReviewed > 0 ? Math.round(totalChunks / prsReviewed) : 0;
    const avgFindingsPerPR = prsReviewed > 0 ? Math.round(totalFindings / prsReviewed) : 0;

    return {
        timestamp: new Date().toISOString(),
        period,
        requests: requestMetrics,
        queue: {
            messagesProcessed: prsReviewed, // Approximation from KV
            messagesFailed: reviewsFailed,
            avgProcessingTimeMs: 0, // Would need time-series data
        },
        business: {
            prsReviewed,
            reviewsFailed,
            avgChunksPerPR,
            avgFindingsPerPR,
        },
        circuitBreakers: circuitBreakerStates,
    };
}

/**
 * Get Prometheus-compatible metrics format.
 */
export function getPrometheusMetrics(metrics: OperationalMetrics): string {
    const lines: string[] = [];
    const timestamp = Date.now();

    // Request metrics
    lines.push(`# HELP code_reviewer_requests_total Total number of requests`);
    lines.push(`# TYPE code_reviewer_requests_total counter`);
    lines.push(`code_reviewer_requests_total ${metrics.requests.total} ${timestamp}`);

    // Error rate
    lines.push(`# HELP code_reviewer_errors_total Total number of errors`);
    lines.push(`# TYPE code_reviewer_errors_total counter`);
    lines.push(`code_reviewer_errors_total ${metrics.requests.errors} ${timestamp}`);

    // Business metrics
    lines.push(`# HELP code_reviewer_prs_reviewed_total Total PRs reviewed`);
    lines.push(`# TYPE code_reviewer_prs_reviewed_total counter`);
    lines.push(`code_reviewer_prs_reviewed_total ${metrics.business.prsReviewed} ${timestamp}`);

    lines.push(`# HELP code_reviewer_reviews_failed_total Total failed reviews`);
    lines.push(`# TYPE code_reviewer_reviews_failed_total counter`);
    lines.push(`code_reviewer_reviews_failed_total ${metrics.business.reviewsFailed} ${timestamp}`);

    // Circuit breaker states
    for (const [name, state] of Object.entries(metrics.circuitBreakers)) {
        lines.push(`# HELP code_reviewer_circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half-open)`);
        lines.push(`# TYPE code_reviewer_circuit_breaker_state gauge`);
        const stateValue = state.state === 'open' ? 1 : state.state === 'half-open' ? 2 : 0;
        lines.push(`code_reviewer_circuit_breaker_state{name="${name}"} ${stateValue} ${timestamp}`);

        lines.push(`# HELP code_reviewer_circuit_breaker_failures Circuit breaker failure count`);
        lines.push(`# TYPE code_reviewer_circuit_breaker_failures counter`);
        lines.push(`code_reviewer_circuit_breaker_failures{name="${name}"} ${state.failures} ${timestamp}`);
    }

    return lines.join('\n') + '\n';
}
