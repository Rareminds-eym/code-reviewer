/**
 * Industrial-grade webhook deduplication to prevent processing the same GitHub event twice.
 * Uses KV storage with 1-hour TTL for delivery ID tracking.
 */

import type { Env } from '../types/env';
import { logger } from './logger';

const DEDUP_TTL_SECONDS = 3600; // 1 hour
const DEDUP_KEY_PREFIX = 'delivery';

/**
 * Extract the GitHub delivery ID from request headers.
 * GitHub provides this as X-GitHub-Delivery UUID.
 */
function getDeliveryId(request: Request): string | null {
    return request.headers.get('X-GitHub-Delivery');
}

/**
 * Check if this webhook has been processed before.
 * Returns true if it's a duplicate (should skip), false if it's new.
 */
export async function isDuplicateWebhook(
    request: Request,
    env: Env
): Promise<boolean> {
    const deliveryId = getDeliveryId(request);

    // If no delivery ID, we can't deduplicate — assume new
    if (!deliveryId) {
        logger.warn('Webhook missing X-GitHub-Delivery header, cannot deduplicate');
        return false;
    }

    const kvKey = `${DEDUP_KEY_PREFIX}:${deliveryId}`;

    try {
        const existing = await env.DEDUP_KV.get(kvKey);

        if (existing) {
            logger.info('Duplicate webhook detected, skipping', { deliveryId });
            return true;
        }

        // Mark as processed with TTL
        await env.DEDUP_KV.put(kvKey, '1', {
            expirationTtl: DEDUP_TTL_SECONDS,
        });

        logger.debug('Webhook marked as processed', { deliveryId });
        return false;
    } catch (error) {
        // Fail open — if KV fails, allow processing rather than dropping webhook
        logger.error('Webhook deduplication check failed', error instanceof Error ? error : undefined, {
            deliveryId,
        });
        return false;
    }
}

/**
 * Get the deduplication status for logging/debugging.
 */
export async function getWebhookStatus(
    deliveryId: string,
    env: Env
): Promise<{ processed: boolean; ttl?: number }> {
    const kvKey = `${DEDUP_KEY_PREFIX}:${deliveryId}`;

    try {
        const result = await env.DEDUP_KV.getWithMetadata(kvKey);
        const metadata = result.metadata as { expiration?: number } | undefined;
        return {
            processed: result.value !== null,
            ttl: metadata?.expiration ? metadata.expiration - Math.floor(Date.now() / 1000) : undefined,
        };
    } catch {
        return { processed: false };
    }
}
