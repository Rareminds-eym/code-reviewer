/**
 * Production-grade input validation for usage tracking system.
 * Prevents injection attacks, malformed data, and ensures data integrity.
 */

import { ValidationError } from './errors';
import type { TokenUsage, PRUsageMetrics } from '../types/usage';

/**
 * Validate repository owner/name format
 * Must be alphanumeric, hyphens, underscores, dots (GitHub format)
 */
export function validateRepoIdentifier(value: string, fieldName: string): string {
    if (!value || typeof value !== 'string') {
        throw new ValidationError(`${fieldName} is required and must be a string`);
    }

    const trimmed = value.trim();
    
    if (trimmed.length === 0) {
        throw new ValidationError(`${fieldName} cannot be empty`);
    }

    if (trimmed.length > 100) {
        throw new ValidationError(`${fieldName} must be 100 characters or less`, {
            length: trimmed.length,
        });
    }

    // GitHub allows: alphanumeric, hyphens, underscores, dots
    // Prevent path traversal, SQL injection, XSS
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    if (!validPattern.test(trimmed)) {
        throw new ValidationError(
            `${fieldName} contains invalid characters. Only alphanumeric, hyphens, underscores, and dots allowed`,
            { value: trimmed }
        );
    }

    // Prevent path traversal attempts
    if (trimmed.includes('..') || trimmed.includes('//')) {
        throw new ValidationError(`${fieldName} contains invalid patterns`, {
            value: trimmed,
        });
    }

    return trimmed;
}

/**
 * Validate PR number
 */
export function validatePRNumber(value: unknown): number {
    if (typeof value === 'string') {
        value = parseInt(value, 10);
    }

    if (typeof value !== 'number' || isNaN(value)) {
        throw new ValidationError('PR number must be a valid number');
    }

    if (value < 1 || value > 999999999) {
        throw new ValidationError('PR number must be between 1 and 999999999', {
            value,
        });
    }

    if (!Number.isInteger(value)) {
        throw new ValidationError('PR number must be an integer', { value });
    }

    return value;
}

/**
 * Validate commit SHA
 */
export function validateCommitSha(value: string): string {
    if (!value || typeof value !== 'string') {
        throw new ValidationError('Commit SHA is required and must be a string');
    }

    const trimmed = value.trim();

    // Git SHA-1: 40 hex characters, or short form (7-40 chars)
    const validPattern = /^[a-f0-9]{7,40}$/i;
    if (!validPattern.test(trimmed)) {
        throw new ValidationError(
            'Commit SHA must be 7-40 hexadecimal characters',
            { value: trimmed }
        );
    }

    return trimmed.toLowerCase();
}

/**
 * Validate limit parameter for list operations
 */
export function validateLimit(value: unknown, max: number = 1000): number {
    if (value === undefined || value === null) {
        return 100; // Default
    }

    if (typeof value === 'string') {
        value = parseInt(value, 10);
    }

    if (typeof value !== 'number' || isNaN(value)) {
        throw new ValidationError('Limit must be a valid number');
    }

    if (value < 1) {
        throw new ValidationError('Limit must be at least 1', { value });
    }

    if (value > max) {
        throw new ValidationError(`Limit must not exceed ${max}`, { value, max });
    }

    if (!Number.isInteger(value)) {
        throw new ValidationError('Limit must be an integer', { value });
    }

    return value;
}

/**
 * Validate token usage data from LLM responses
 */
export function validateTokenUsage(usage: unknown): TokenUsage {
    if (!usage || typeof usage !== 'object') {
        throw new ValidationError('Token usage must be an object', {
            received: typeof usage,
        });
    }

    const u = usage as Record<string, unknown>;

    // Validate inputTokens
    if (typeof u.inputTokens !== 'number' || isNaN(u.inputTokens)) {
        throw new ValidationError('inputTokens must be a valid number', {
            received: u.inputTokens,
        });
    }

    if (u.inputTokens < 0 || u.inputTokens > 10_000_000) {
        throw new ValidationError('inputTokens out of valid range (0-10M)', {
            value: u.inputTokens,
        });
    }

    // Validate outputTokens
    if (typeof u.outputTokens !== 'number' || isNaN(u.outputTokens)) {
        throw new ValidationError('outputTokens must be a valid number', {
            received: u.outputTokens,
        });
    }

    if (u.outputTokens < 0 || u.outputTokens > 10_000_000) {
        throw new ValidationError('outputTokens out of valid range (0-10M)', {
            value: u.outputTokens,
        });
    }

    // Validate totalTokens
    if (typeof u.totalTokens !== 'number' || isNaN(u.totalTokens)) {
        throw new ValidationError('totalTokens must be a valid number', {
            received: u.totalTokens,
        });
    }

    const expectedTotal = u.inputTokens + u.outputTokens;
    if (Math.abs(u.totalTokens - expectedTotal) > 1) {
        throw new ValidationError('totalTokens does not match sum of input and output', {
            totalTokens: u.totalTokens,
            expected: expectedTotal,
        });
    }

    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
    };
}

/**
 * Validate PRUsageMetrics before storage
 */
export function validatePRUsageMetrics(metrics: unknown): PRUsageMetrics {
    if (!metrics || typeof metrics !== 'object') {
        throw new ValidationError('Metrics must be an object');
    }

    const m = metrics as Record<string, unknown>;

    // Validate required fields
    validatePRNumber(m.prNumber);
    
    if (typeof m.repoFullName !== 'string' || !m.repoFullName.includes('/')) {
        throw new ValidationError('repoFullName must be in format "owner/repo"');
    }

    if (typeof m.provider !== 'string' || !['claude', 'gemini'].includes(m.provider)) {
        throw new ValidationError('provider must be "claude" or "gemini"', {
            received: m.provider,
        });
    }

    // Validate token counts
    if (typeof m.totalTokens !== 'number' || m.totalTokens < 0) {
        throw new ValidationError('totalTokens must be a non-negative number', {
            value: m.totalTokens,
        });
    }

    // Validate cost
    if (typeof m.estimatedCost !== 'number' || m.estimatedCost < 0) {
        throw new ValidationError('estimatedCost must be a non-negative number', {
            value: m.estimatedCost,
        });
    }

    // Validate status
    if (!['success', 'partial', 'failed'].includes(m.status as string)) {
        throw new ValidationError('status must be success, partial, or failed', {
            received: m.status,
        });
    }

    return m as unknown as PRUsageMetrics;
}

/**
 * Sanitize string for safe logging (prevent log injection)
 */
export function sanitizeForLog(value: string, maxLength: number = 100): string {
    return value
        .replace(/[\r\n\t]/g, ' ') // Remove newlines/tabs
        .replace(/[^\x20-\x7E]/g, '') // Remove non-printable chars
        .slice(0, maxLength);
}
