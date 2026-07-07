/**
 * Production-grade error types for usage tracking system.
 * Enables proper error handling, logging, and monitoring.
 */

export class UsageTrackingError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number = 500,
        public readonly context?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'UsageTrackingError';
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            statusCode: this.statusCode,
            context: this.context,
        };
    }
}

export class ValidationError extends UsageTrackingError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'VALIDATION_ERROR', 400, context);
        this.name = 'ValidationError';
    }
}

export class StorageError extends UsageTrackingError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'STORAGE_ERROR', 500, context);
        this.name = 'StorageError';
    }
}

export class NotFoundError extends UsageTrackingError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'NOT_FOUND', 404, context);
        this.name = 'NotFoundError';
    }
}

export class AuthenticationError extends UsageTrackingError {
    constructor(message: string, context?: Record<string, unknown>) {
        super(message, 'AUTHENTICATION_ERROR', 401, context);
        this.name = 'AuthenticationError';
    }
}

export class RateLimitError extends UsageTrackingError {
    constructor(
        message: string,
        context?: Record<string, unknown>,
        public readonly retryAfterMs?: number
    ) {
        super(message, 'RATE_LIMIT_EXCEEDED', 429, context);
        this.name = 'RateLimitError';
    }
}

/**
 * Type guard to check if error is a UsageTrackingError
 */
export function isUsageTrackingError(error: unknown): error is UsageTrackingError {
    return error instanceof UsageTrackingError;
}

/**
 * Convert any error to a standardized format
 */
export function normalizeError(error: unknown): UsageTrackingError {
    if (isUsageTrackingError(error)) {
        return error;
    }

    if (error instanceof Error) {
        return new UsageTrackingError(
            error.message,
            'UNKNOWN_ERROR',
            500,
            { originalError: error.name }
        );
    }

    return new UsageTrackingError(
        String(error),
        'UNKNOWN_ERROR',
        500
    );
}
