/**
 * Shared error handling for LLM API responses.
 * Eliminates duplicated error handling across Claude and Gemini adapters.
 * 
 * Handles: rate limit detection, error message sanitization, API key redaction.
 */

import { RateLimitError } from '../errors';

/**
 * Handle a non-OK LLM API response uniformly.
 * Extracts rate-limit headers, sanitizes error text, and throws appropriate errors.
 *
 * @throws {RateLimitError} for 429 responses with retry-after header
 * @throws {Error} for all other error responses
 */
export async function handleLLMErrorResponse(
    response: Response,
    providerName: string
): Promise<never> {
    const errorText = await response.text();

    // Extract retry-after header for rate limit errors
    const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null;

    // Try to parse the error as JSON to extract a human-readable message
    let parsedMessage: string | null = null;
    try {
        const parsed = JSON.parse(errorText);
        if (parsed?.error?.message) {
            parsedMessage = String(parsed.error.message);
        } else if (parsed?.message) {
            parsedMessage = String(parsed.message);
        }
    } catch {
        // Not valid JSON, fallback to raw text
    }

    const rawErrorTarget = parsedMessage || errorText;

    // Sanitize error message to prevent potential API key leaks
    const sanitizedError = rawErrorTarget
        .replace(/key[=:]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi, 'key=[REDACTED]')
        .replace(/api[_-]?key['"]?\s*[=:]\s*['"]?[^'"\s]+['"]?/gi, 'api_key=[REDACTED]')
        .substring(0, 500); // Limit error text length

    const errorMessage = `${providerName} API error: ${response.status} ${response.statusText} - ${sanitizedError}`;

    // Throw RateLimitError for 429 responses with retry-after header
    if (response.status === 429 && retryAfter) {
        const retryAfterMs = parseInt(retryAfter, 10) * 1000;
        if (!isNaN(retryAfterMs)) {
            throw new RateLimitError(errorMessage, undefined, retryAfterMs);
        }
    }

    throw new Error(errorMessage);
}
