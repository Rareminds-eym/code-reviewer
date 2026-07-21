/**
 * OPENTELEMETRY DISTRIBUTED TRACING
 * 
 * Provides end-to-end visibility across Worker → Queue → Container → LLM pipeline.
 * Gracefully degrades if OpenTelemetry SDK is not installed.
 * 
 * Based on patterns from:
 * - Cloudflare Workers OpenTelemetry
 * - Honeycomb Distributed Tracing
 * - AWS X-Ray
 * 
 * Key Features:
 * - Trace context propagation across boundaries
 * - Automatic span creation for key operations
 * - Span attributes for filtering and analysis
 * - Integration with existing request context
 * - Graceful degradation without OpenTelemetry SDK
 */

import { logger } from '../logger';

// Type-only imports (don't fail at runtime if package missing)
type Span = any;
type Tracer = any;
type SpanStatusCode = any;

// Lazy-load OpenTelemetry - only fails if actually used
let otelApi: any = null;
let otelAvailable = false;

// Try to load OpenTelemetry (non-blocking)
(async () => {
    try {
        otelApi = await import('@opentelemetry/api');
        otelAvailable = true;
        logger.info('[Tracing] OpenTelemetry available');
    } catch {
        logger.warn('[Tracing] OpenTelemetry not available, tracing disabled (no-op mode)');
    }
})();

/**
 * Span attribute keys following OpenTelemetry semantic conventions.
 */
export const SpanAttributes = {
    // GitHub attributes
    GITHUB_PR_NUMBER: 'github.pr.number',
    GITHUB_REPO: 'github.repo.full_name',
    GITHUB_HEAD_SHA: 'github.head_sha',
    GITHUB_EVENT: 'github.event.type',
    
    // Review attributes
    REVIEW_CHUNK_COUNT: 'review.chunk.count',
    REVIEW_CHUNK_INDEX: 'review.chunk.index',
    REVIEW_FILE_COUNT: 'review.file.count',
    REVIEW_FINDINGS_COUNT: 'review.findings.count',
    REVIEW_VERDICT: 'review.verdict',
    
    // LLM attributes
    LLM_PROVIDER: 'llm.provider',
    LLM_MODEL: 'llm.model',
    LLM_OPERATION: 'llm.operation', // 'chunk_review' | 'synthesis'
    LLM_INPUT_TOKENS: 'llm.tokens.input',
    LLM_OUTPUT_TOKENS: 'llm.tokens.output',
    LLM_COST: 'llm.cost.usd',
    
    // Container attributes
    CONTAINER_USED: 'container.used',
    CONTAINER_TIMEOUT: 'container.timeout',
    CONTAINER_DURATION_MS: 'container.duration_ms',
    
    // Rate limit attributes
    RATE_LIMIT_WAIT_MS: 'rate_limit.wait_ms',
    RATE_LIMIT_UTILIZATION: 'rate_limit.utilization',
    
    // Cost attributes
    COST_HOURLY_SPEND: 'cost.hourly_spend',
    COST_BUDGET_UTILIZATION: 'cost.budget_utilization',
    
    // Concurrency attributes
    CONCURRENCY_LEVEL: 'concurrency.level',
    CONCURRENCY_ERROR_RATE: 'concurrency.error_rate',

    // Hybrid two-tier pipeline attributes (agentic-review-pipeline R10.6)
    REVIEW_TRACK: 'review.track',
    REVIEW_TRACK_REASON: 'review.track.reason',
    REVIEW_TRACK_PROVISIONAL: 'review.track.provisional',
    REVIEW_TRACK_SECURITY_FLOOR: 'review.track.security_floor',
    REVIEW_TRACK_CONFIG_OVERRIDE: 'review.track.config_override',
    DEP_AUDIT_FINDINGS: 'review.dependency_audit.findings',
    CONSENSUS_KEEP: 'consensus.keep',
    CONSENSUS_DOWNGRADE: 'consensus.downgrade',
    CONSENSUS_VERIFY: 'consensus.verify',
    CONSENSUS_SUPPRESS: 'consensus.suppress',
    VERIFIER_EVALUATED: 'verifier.evaluated',
    VERIFIER_VERIFIED: 'verifier.verified',
    VERIFIER_REJECTED: 'verifier.rejected',
    VERIFIER_FLIPS: 'verifier.flips',
    VERIFIER_FLIP_RATE: 'verifier.flip_rate',
    VERIFIER_TOKENS: 'verifier.tokens',
    SCHEDULE_CONSENSUS_ENABLED: 'schedule.consensus_enabled',
    SCHEDULE_VERIFIER_ENABLED: 'schedule.verifier_enabled',
    SCHEDULE_PERSONAS_ENABLED: 'schedule.personas_enabled',
};

/**
 * Span names for key operations.
 */
export const SpanNames = {
    WEBHOOK_HANDLER: 'webhook.handle',
    QUEUE_PROCESS: 'queue.process',
    CONTAINER_DISPATCH: 'container.dispatch',
    LLM_CHUNK_REVIEW: 'llm.chunk_review',
    LLM_SYNTHESIS: 'llm.synthesis',
    GITHUB_API_CALL: 'github.api.call',
    RATE_LIMIT_WAIT: 'rate_limit.wait',
    COST_CHECK: 'cost.check',

    // Hybrid two-tier pipeline stages (agentic-review-pipeline R10.6)
    TRIAGE_FINALIZE: 'review.triage.finalize',
    SCHEDULE_BUILD: 'review.schedule.build',
    DEPENDENCY_AUDIT: 'review.dependency_audit',
    CONSENSUS_ROUTE: 'review.consensus.route',
    AGENTIC_VERIFY: 'review.agentic_verify',
};

/**
 * Get the global tracer instance.
 * Returns no-op tracer if OpenTelemetry is not available.
 */
export function getTracer(): Tracer {
    if (!otelAvailable || !otelApi) {
        // Return no-op tracer that does nothing but doesn't break code
        return {
            startActiveSpan: (name: string, fn: any) => {
                // No-op: just execute function without tracing
                const noopSpan = createNoopSpan();
                return fn(noopSpan);
            },
            startSpan: () => createNoopSpan(),
        };
    }

    return otelApi.trace.getTracer('code-reviewer', '1.0.0');
}

/**
 * Create a no-op span that implements the Span interface but does nothing.
 */
function createNoopSpan(): Span {
    return {
        setAttribute: () => {},
        setAttributes: () => {},
        setStatus: () => {},
        recordException: () => {},
        addEvent: () => {},
        end: () => {},
        spanContext: () => null,
        isRecording: () => false,
        updateName: () => {},
    };
}

/**
 * Get SpanStatusCode enum (or fallback values if OpenTelemetry not available).
 */
function getSpanStatusCode(): any {
    if (otelAvailable && otelApi) {
        return otelApi.SpanStatusCode;
    }
    // Fallback values
    return {
        OK: 1,
        ERROR: 2,
        UNSET: 0,
    };
}

/**
 * Start a new span with automatic error handling.
 * 
 * @example
 * await withSpan('llm.chunk_review', async (span) => {
 *   span.setAttribute('llm.provider', 'claude');
 *   const result = await reviewChunk(...);
 *   span.setAttribute('llm.tokens.input', result.usage.inputTokens);
 *   return result;
 * });
 */
export async function withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, string | number | boolean>
): Promise<T> {
    if (!otelAvailable) {
        // No-op: just execute function without tracing
        return fn(createNoopSpan());
    }

    const tracer = getTracer();
    const SpanStatusCode = getSpanStatusCode();
    
    return tracer.startActiveSpan(name, async (span: Span) => {
        try {
            // Add initial attributes
            if (attributes) {
                for (const [key, value] of Object.entries(attributes)) {
                    span.setAttribute(key, value);
                }
            }

            // Execute function
            const result = await fn(span);

            // Mark span as successful
            span.setStatus({ code: SpanStatusCode.OK });

            return result;
        } catch (error) {
            // Record error in span
            span.recordException(error as Error);
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });

            // Re-throw to preserve error handling
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * Create a span without automatic execution (for manual control).
 * Returns no-op span if OpenTelemetry not available.
 */
export function startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>
): Span {
    if (!otelAvailable) {
        return createNoopSpan();
    }

    const tracer = getTracer();
    const span = tracer.startSpan(name);

    if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
            span.setAttribute(key, value);
        }
    }

    return span;
}

/**
 * Add event to current span (no-op if tracing disabled).
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    if (!otelAvailable || !otelApi) return;
    
    const span = otelApi.trace.getActiveSpan();
    if (span) {
        span.addEvent(name, attributes);
    }
}

/**
 * Set attribute on current span (no-op if tracing disabled).
 */
export function setSpanAttribute(key: string, value: string | number | boolean): void {
    if (!otelAvailable || !otelApi) return;
    
    const span = otelApi.trace.getActiveSpan();
    if (span) {
        span.setAttribute(key, value);
    }
}

/**
 * Extract trace context from request headers.
 * Supports W3C Trace Context standard.
 * Returns empty object if tracing disabled.
 */
export function extractTraceContext(headers: Headers): Record<string, string> {
    if (!otelAvailable) return {};

    const traceParent = headers.get('traceparent');
    const traceState = headers.get('tracestate');

    const context: Record<string, string> = {};

    if (traceParent) {
        context.traceparent = traceParent;
    }

    if (traceState) {
        context.tracestate = traceState;
    }

    return context;
}

/**
 * Inject trace context into request headers.
 * No-op if tracing disabled.
 */
export function injectTraceContext(headers: Headers): void {
    if (!otelAvailable || !otelApi) return;

    const span = otelApi.trace.getActiveSpan();
    if (!span) return;

    const spanContext = span.spanContext();
    if (!spanContext) return;

    // W3C Trace Context format: version-traceId-spanId-flags
    const traceParent = `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, '0')}`;
    headers.set('traceparent', traceParent);

    if (spanContext.traceState) {
        headers.set('tracestate', spanContext.traceState.serialize());
    }
}

/**
 * Get current trace ID for logging correlation.
 * Returns undefined if tracing disabled.
 */
export function getCurrentTraceId(): string | undefined {
    if (!otelAvailable || !otelApi) return undefined;
    
    const span = otelApi.trace.getActiveSpan();
    if (!span) return undefined;

    const spanContext = span.spanContext();
    return spanContext?.traceId;
}

/**
 * Get current span ID for logging correlation.
 * Returns undefined if tracing disabled.
 */
export function getCurrentSpanId(): string | undefined {
    if (!otelAvailable || !otelApi) return undefined;
    
    const span = otelApi.trace.getActiveSpan();
    if (!span) return undefined;

    const spanContext = span.spanContext();
    return spanContext?.spanId;
}

/**
 * Helper to trace LLM API calls with standard attributes.
 */
export async function traceLLMCall<T>(
    operation: 'chunk_review' | 'synthesis',
    provider: string,
    model: string,
    fn: (span: Span) => Promise<{ result: T; usage: { inputTokens: number; outputTokens: number } }>
): Promise<T> {
    return withSpan(
        operation === 'chunk_review' ? SpanNames.LLM_CHUNK_REVIEW : SpanNames.LLM_SYNTHESIS,
        async (span) => {
            span.setAttribute(SpanAttributes.LLM_PROVIDER, provider);
            span.setAttribute(SpanAttributes.LLM_MODEL, model);
            span.setAttribute(SpanAttributes.LLM_OPERATION, operation);

            const { result, usage } = await fn(span);

            span.setAttribute(SpanAttributes.LLM_INPUT_TOKENS, usage.inputTokens);
            span.setAttribute(SpanAttributes.LLM_OUTPUT_TOKENS, usage.outputTokens);

            // Calculate cost
            const cost = calculateLLMCost(provider, usage.inputTokens, usage.outputTokens);
            span.setAttribute(SpanAttributes.LLM_COST, cost);

            return result;
        }
    );
}

/**
 * Helper to trace GitHub API calls.
 */
export async function traceGitHubCall<T>(
    endpoint: string,
    fn: (span: Span) => Promise<T>
): Promise<T> {
    return withSpan(
        SpanNames.GITHUB_API_CALL,
        async (span) => {
            span.setAttribute('github.api.endpoint', endpoint);
            return await fn(span);
        }
    );
}

/**
 * Calculate LLM cost for span attributes.
 */
function calculateLLMCost(provider: string, inputTokens: number, outputTokens: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
        claude: { input: 3.0, output: 15.0 },
        gemini: { input: 0.075, output: 0.30 },
    };

    const rates = pricing[provider];
    if (!rates) return 0;

    return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

/**
 * Initialize OpenTelemetry with W3C OTLP trace exporter in Node.js container.
 * Gracefully handles missing OpenTelemetry SDK or configuration.
 */
export async function initializeTracing(env: { HONEYCOMB_API_KEY?: string; OTEL_EXPORTER_URL?: string }): Promise<void> {
    if (!otelAvailable) {
        logger.warn('[Tracing] OpenTelemetry not available, tracing disabled');
        return;
    }

    try {
        const honeycombKey = env.HONEYCOMB_API_KEY || process.env.HONEYCOMB_API_KEY;
        const exporterUrl = env.OTEL_EXPORTER_URL || process.env.OTEL_EXPORTER_URL;

        if (honeycombKey || exporterUrl) {
            const { NodeSDK } = await import('@opentelemetry/sdk-node');
            const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

            const headers: Record<string, string> = {};
            if (honeycombKey) {
                headers['x-honeycomb-team'] = honeycombKey;
            }

            const exporter = new OTLPTraceExporter({
                url: exporterUrl || 'https://api.honeycomb.io/v1/traces',
                headers,
            });

            const sdk = new NodeSDK({
                traceExporter: exporter,
                serviceName: 'code-reviewer-container',
            });

            sdk.start();
            logger.info('[Tracing] OpenTelemetry Node SDK started successfully');
        } else {
            logger.info('[Tracing] No API key or collector URL found, skipping SDK init');
        }
    } catch (err) {
        logger.warn('[Tracing] Failed to initialize Node OTel SDK', { error: String(err) });
    }
}
