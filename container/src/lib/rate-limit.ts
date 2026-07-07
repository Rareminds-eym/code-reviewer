/**
 * Industrial-grade rate limiting for Cloudflare Workers.
 * Implements token bucket algorithm with KV persistence for distributed rate limiting.
 */

import type { Env } from '../types/env';
import { logger } from './logger';
import { getSecurityHeaders } from './security-headers';

export interface RateLimitConfig {
    /**
     * Maximum requests per window. Default: 100
     */
    maxRequests: number;
    /**
     * Time window in seconds. Default: 60 (1 minute)
     */
    windowSeconds: number;
    /**
     * Burst capacity (allows short spikes). Default: 20
     */
    burstCapacity: number;
    /**
     * Skip rate limiting for requests with valid API key. Default: true
     */
    skipWithApiKey?: boolean;
}

export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
}

interface RateLimitBucket {
    tokens: number;
    lastRefill: number;
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
    maxRequests: 100,
    windowSeconds: 60,
    burstCapacity: 20,
    skipWithApiKey: true,
};

// In-memory buckets for low-latency rate limiting (non-distributed)
const localBuckets = new Map<string, RateLimitBucket>();
const LOCAL_BUCKET_MAX_AGE = 300000; // 5 minutes - buckets older than this are cleaned up lazily
let lastCleanupTime = Date.now();

/**
 * Extract client identifier from request.
 * Uses CF-Connecting-IP header (provided by Cloudflare) or falls back to other headers.
 * Returns a hashed identifier to ensure fixed key length for KV storage.
 */
async function getClientId(request: Request): Promise<string> {
    let clientId: string;

    // Cloudflare-specific headers (most reliable)
    const cfIp = request.headers.get('CF-Connecting-IP');
    if (cfIp) {
        clientId = `ip:${cfIp}`;
    } else {
        // Standard forwarded headers
        const forwarded = request.headers.get('X-Forwarded-For');
        if (forwarded) {
            // X-Forwarded-For can be a comma-separated list; use first IP
            const firstIp = forwarded.split(',')[0].trim();
            clientId = `ip:${firstIp}`;
        } else {
            const realIp = request.headers.get('X-Real-IP');
            if (realIp) {
                clientId = `ip:${realIp}`;
            } else {
                // Fallback: use User-Agent + Accept-Language fingerprint (less reliable)
                const ua = request.headers.get('User-Agent') || 'unknown';
                const lang = request.headers.get('Accept-Language') || 'unknown';
                clientId = `fp:${ua}:${lang}`;
            }
        }
    }

    // Hash the client ID with SHA-256 for fixed length and uniform distribution
    // KV has a 512 character key limit
    const hash = await hashStringSHA256(clientId);
    return `ratelimit:${hash}`;
}

/**
 * SHA-256 hash for reliable, collision-resistant client fingerprinting.
 */
async function hashStringSHA256(str: string): Promise<string> {
    const data = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Check if request has valid API key (should skip rate limiting).
 */
function hasValidApiKey(request: Request, env: Env): boolean {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.slice(7);
    // API key is optional; if set, validate; if not set, treat as no API key
    if (!env.USAGE_API_KEY) {
        return false;
    }

    return token === env.USAGE_API_KEY;
}

/**
 * Check rate limit for a request using in-memory token bucket.
 * 
 * WARNING: Cloudflare Workers are stateless and instances are recycled frequently.
 * This in-memory rate limiter will:
 * 1. Reset on every cold start (allowing potential burst abuse).
 * 2. Not limit requests spread across multiple edge nodes/instances.
 * 
 * Use `checkRateLimitDistributed` (KV-backed) for accurate global rate limiting.
 * This local version is only suitable for advisory/best-effort protection.
 */
export async function checkRateLimitLocal(
    request: Request,
    config: Partial<RateLimitConfig> = {}
): Promise<RateLimitResult> {
    // Lazy cleanup of old buckets
    cleanupOldBuckets();

    const cfg = { ...DEFAULT_CONFIG, ...config };
    const clientId = await getClientId(request);
    const now = Date.now();
    const windowMs = cfg.windowSeconds * 1000;

    // Get or create bucket
    let bucket = localBuckets.get(clientId);
    if (!bucket) {
        bucket = {
            tokens: cfg.burstCapacity,
            lastRefill: now,
        };
        localBuckets.set(clientId, bucket);
    }

    // Calculate token refill
    const elapsedMs = now - bucket.lastRefill;
    const tokensToAdd = Math.floor((elapsedMs / windowMs) * cfg.maxRequests);

    if (tokensToAdd > 0) {
        bucket.tokens = Math.min(cfg.burstCapacity, bucket.tokens + tokensToAdd);
        bucket.lastRefill = now;
    }

    // Check if request allowed
    const allowed = bucket.tokens >= 1;

    if (allowed) {
        bucket.tokens -= 1;
    }

    // Calculate reset time and retry after
    const resetTime = Math.ceil((bucket.lastRefill + windowMs) / 1000);
    const retryAfter = allowed ? undefined : Math.ceil(windowMs / 1000);

    return {
        allowed,
        limit: cfg.maxRequests,
        remaining: Math.max(0, Math.floor(bucket.tokens)),
        resetTime,
        retryAfter,
    };
}

/**
 * Check rate limit using KV for distributed rate limiting.
 * More accurate across multiple worker instances but adds latency (~50-100ms).
 */
export async function checkRateLimitDistributed(
    request: Request,
    env: Env,
    config: Partial<RateLimitConfig> = {}
): Promise<RateLimitResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const clientId = await getClientId(request);
    const now = Date.now();
    const windowMs = cfg.windowSeconds * 1000;

    // Check API key bypass
    if (cfg.skipWithApiKey && hasValidApiKey(request, env)) {
        return {
            allowed: true,
            limit: cfg.maxRequests,
            remaining: cfg.maxRequests,
            resetTime: Math.ceil((now + windowMs) / 1000),
        };
    }

    try {
        // Get current bucket state from KV
        const stored = await env.CACHE_KV.get(clientId);
        let bucket: RateLimitBucket;

        if (stored) {
            bucket = JSON.parse(stored) as RateLimitBucket;
        } else {
            bucket = {
                tokens: cfg.burstCapacity,
                lastRefill: now,
            };
        }

        // Calculate token refill
        const elapsedMs = now - bucket.lastRefill;
        const tokensToAdd = Math.floor((elapsedMs / windowMs) * cfg.maxRequests);

        if (tokensToAdd > 0) {
            bucket.tokens = Math.min(cfg.burstCapacity, bucket.tokens + tokensToAdd);
            bucket.lastRefill = now;
        }

        // Check if request allowed
        const allowed = bucket.tokens >= 1;

        if (allowed) {
            bucket.tokens -= 1;
        }

        // Store updated bucket with short TTL
        await env.CACHE_KV.put(clientId, JSON.stringify(bucket), {
            expirationTtl: Math.ceil(windowMs / 1000) + 10, // Slightly longer than window
        });

        const resetTime = Math.ceil((bucket.lastRefill + windowMs) / 1000);
        const retryAfter = allowed ? undefined : Math.ceil(cfg.windowSeconds);

        logger.debug('Rate limit check', {
            clientId: clientId.slice(0, 20), // Truncate for privacy
            allowed,
            remaining: bucket.tokens,
        });

        return {
            allowed,
            limit: cfg.maxRequests,
            remaining: Math.max(0, Math.floor(bucket.tokens)),
            resetTime,
            retryAfter,
        };
    } catch (error) {
        // Fail open on KV errors to prevent blocking legitimate traffic
        logger.error('Rate limit check failed', error instanceof Error ? error : undefined, {
            clientId: clientId.slice(0, 20),
        });

        return {
            allowed: true,
            limit: cfg.maxRequests,
            remaining: cfg.maxRequests,
            resetTime: Math.ceil((now + windowMs) / 1000),
        };
    }
}

/**
 * Get rate limit headers for response.
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
    const headers: Record<string, string> = {
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetTime),
    };

    if (result.retryAfter) {
        headers['Retry-After'] = String(result.retryAfter);
    }

    return headers;
}

/**
 * Create a 429 Too Many Requests response.
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
    const headers = {
        'Content-Type': 'application/json',
        ...getRateLimitHeaders(result),
        ...getSecurityHeaders(),
    };

    return new Response(
        JSON.stringify({
            error: 'Rate limit exceeded',
            message: `Too many requests. Try again in ${result.retryAfter} seconds.`,
            limit: result.limit,
            resetTime: result.resetTime,
        }),
        { status: 429, headers }
    );
}

/**
 * Lazily cleanup old buckets (run periodically during rate limit checks)
 */
function cleanupOldBuckets(): void {
    const now = Date.now();
    // Only run cleanup every 60 seconds to avoid overhead
    if (now - lastCleanupTime < 60000) return;

    lastCleanupTime = now;

    for (const [key, bucket] of localBuckets.entries()) {
        if (now - bucket.lastRefill > LOCAL_BUCKET_MAX_AGE) {
            localBuckets.delete(key);
        }
    }
}
