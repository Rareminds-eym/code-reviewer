/**
 * Request context for distributed tracing.
 * Manages request ID propagation across async boundaries.
 * 
 * Uses a stack-based approach to support concurrent async contexts safely.
 * Each runWithContext(Async) pushes/pops its own context, so concurrent
 * queue message processing (Promise.all) won't clobber each other.
 */

export interface RequestContext {
    /** Unique request ID for tracing */
    requestId: string;
    /** Timestamp when the request started */
    startTime: number;
    /** Additional context data */
    [key: string]: unknown;
}

// Stack-based context storage: supports nested and concurrent contexts.
// The stack tracks the LIFO order of synchronous context pushes.
// Each unique requestId maps to its context in the store for lookup.
const contextStore = new Map<string, RequestContext>();
const contextStack: string[] = [];

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Extract request ID from HTTP headers or generate a new one
 */
export function extractOrGenerateRequestId(headers: Headers): string {
    // Check for common request ID headers
    const requestId = headers.get('x-request-id') ||
        headers.get('x-correlation-id') ||
        headers.get('cf-ray') || // Cloudflare Ray ID
        headers.get('x-github-delivery'); // GitHub webhook ID

    return requestId || generateRequestId();
}

/**
 * Run a function within a request context (synchronous).
 * Safe for concurrent usage — each call gets its own stack frame.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
    contextStore.set(context.requestId, context);
    contextStack.push(context.requestId);

    try {
        return fn();
    } finally {
        contextStack.pop();
        contextStore.delete(context.requestId);
    }
}

/**
 * Run an async function within a request context.
 * 
 * IMPORTANT: For concurrent async operations (e.g. Promise.all on queue messages),
 * each async task gets its own context that persists in the store for the duration
 * of the task. The stack top is only used as a fallback for synchronous callers;
 * async callers should pass context explicitly or use getContextById().
 */
export async function runWithContextAsync<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
    contextStore.set(context.requestId, context);
    contextStack.push(context.requestId);

    try {
        return await fn();
    } finally {
        // Remove from stack — but only our own entry (handle concurrent pops gracefully)
        const idx = contextStack.lastIndexOf(context.requestId);
        if (idx >= 0) {
            contextStack.splice(idx, 1);
        }
        contextStore.delete(context.requestId);
    }
}

/**
 * Get a specific request context by ID.
 * Preferred for concurrent async contexts where stack-top is unreliable.
 */
export function getContextById(requestId: string): RequestContext | undefined {
    return contextStore.get(requestId);
}

/**
 * Get the current request context (top of stack).
 * NOTE: In concurrent async scenarios, prefer getContextById() with an explicit ID.
 */
export function getRequestContext(): RequestContext | undefined {
    const currentId = contextStack.length > 0 ? contextStack[contextStack.length - 1] : null;
    return currentId ? contextStore.get(currentId) : undefined;
}

/**
 * Get the current request ID (top of stack).
 */
export function getRequestId(): string | undefined {
    return contextStack.length > 0 ? contextStack[contextStack.length - 1] : undefined;
}

/**
 * Add context to a specific request context
 */
export function addToContext(key: string, value: unknown, requestId?: string): void {
    const id = requestId ?? (contextStack.length > 0 ? contextStack[contextStack.length - 1] : null);
    if (id) {
        const context = contextStore.get(id);
        if (context) {
            context[key] = value;
        }
    }
}

/**
 * Create a child context for queue messages.
 * Always generates a NEW unique requestId so concurrent queue messages don't collide.
 */
export function createChildContext(additionalContext: Omit<RequestContext, 'requestId'> = {}): RequestContext {
    return {
        requestId: generateRequestId(),
        startTime: Date.now(),
        ...additionalContext,
    };
}
