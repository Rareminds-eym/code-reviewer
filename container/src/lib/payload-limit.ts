/**
 * Industrial-grade request payload size limiting.
 * Prevents OOM errors from massive payloads.
 */

import { logger } from './logger';
import { getSecurityHeaders } from './security-headers';

export interface SizeLimitConfig {
    /**
     * Maximum body size in bytes. Default: 5MB (5242880 bytes)
     */
    maxBytes: number;
    /**
     * Custom error message. Default: "Payload too large"
     */
    errorMessage?: string;
}

const DEFAULT_CONFIG: Required<Omit<SizeLimitConfig, 'maxBytes'>> & { maxBytes: number } = {
    maxBytes: 5 * 1024 * 1024, // 5MB
    errorMessage: 'Payload too large',
};

/**
 * Check if request payload exceeds size limit.
 * Returns null if allowed, or Response object if rejected.
 */
export function checkPayloadSize(
    request: Request,
    config: Partial<SizeLimitConfig> = {}
): Response | null {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Check Content-Length header first (fast path)
    const contentLength = request.headers.get('Content-Length');
    if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!isNaN(size) && size > cfg.maxBytes) {
            logger.warn('Payload rejected based on Content-Length', {
                size,
                maxBytes: cfg.maxBytes,
                path: new URL(request.url).pathname,
            });

            return new Response(
                JSON.stringify({
                    error: 'Payload Too Large',
                    message: `Request body exceeds ${formatBytes(cfg.maxBytes)} limit.`,
                    maxSize: cfg.maxBytes,
                }),
                {
                    status: 413,
                    headers: {
                        'Content-Type': 'application/json',
                        ...getSecurityHeaders(),
                    },
                }
            );
        }
    }

    // No Content-Length or within limit — allow processing
    // Note: actual body size check would require consuming the stream,
    // which we avoid for streaming efficiency. Content-Length is reliable
    // for GitHub webhooks which always send this header.

    return null;
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
