/**
 * Production-grade structured logging for usage tracking.
 * Replaces console.log with proper structured logs for observability.
 */

import type { RequestContext } from './request-context';

type GetRequestIdFn = () => string | undefined;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
    [key: string]: unknown;
}

export interface StructuredLog {
    timestamp: string;
    level: LogLevel;
    message: string;
    context?: LogContext;
    requestId?: string;
    error?: {
        name: string;
        message: string;
        stack?: string;
        code?: string;
    };
}

/** Reference to request context getter - set at module initialization to avoid circular deps */
let requestContextGetter: GetRequestIdFn | undefined;

/**
 * Set the request context getter function for the logger.
 * Called once at app initialization to wire up request context without circular dependencies.
 */
export function setRequestContextGetter(getter: GetRequestIdFn): void {
    requestContextGetter = getter;
}

/**
 * Structured logger for production observability
 */
export class Logger {
    constructor(
        private readonly service: string = 'usage-tracker',
        private readonly minLevel: LogLevel = 'info'
    ) { }

    private shouldLog(level: LogLevel): boolean {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        return levels.indexOf(level) >= levels.indexOf(this.minLevel);
    }

    private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
        if (!this.shouldLog(level)) {
            return;
        }

        // Get requestId from the wired-up getter (if available)
        const requestId = requestContextGetter ? requestContextGetter() : undefined;

        const log: StructuredLog = {
            timestamp: new Date().toISOString(),
            level,
            message: `[${this.service}] ${message}`,
            context,
        };

        if (requestId) {
            log.requestId = requestId;
        }

        if (error) {
            log.error = {
                name: error.name,
                message: error.message,
                stack: error.stack,
                code: (error as any).code,
            };
        }

        // In production, this would go to a logging service (Datadog, Sentry, etc.)
        // For now, output as structured JSON
        const output = JSON.stringify(log);

        switch (level) {
            case 'error':
                console.error(output);
                break;
            case 'warn':
                console.warn(output);
                break;
            case 'debug':
                console.debug(output);
                break;
            default:
                console.log(output);
        }
    }

    debug(message: string, context?: LogContext): void {
        this.log('debug', message, context);
    }

    info(message: string, context?: LogContext): void {
        this.log('info', message, context);
    }

    warn(message: string, context?: LogContext): void {
        this.log('warn', message, context);
    }

    error(message: string, error?: Error, context?: LogContext): void {
        this.log('error', message, context, error);
    }

    /**
     * Create a child logger with additional context
     */
    child(additionalContext: LogContext): Logger {
        const childLogger = new Logger(this.service, this.minLevel);
        const originalLog = childLogger.log.bind(childLogger);

        // Override the log method safely on the instance without modifying the prototype
        childLogger.log = function (this: Logger, level: LogLevel, message: string, context?: LogContext, error?: Error): void {
            originalLog(level, message, { ...additionalContext, ...context }, error);
        };

        return childLogger;
    }
}

// Singleton instance
export const logger = new Logger('code-reviewer', 'info');
