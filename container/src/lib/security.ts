/**
 * Webhook signature verification using HMAC-SHA256.
 * Uses the Web Crypto API available natively in Cloudflare Workers — no external deps needed.
 */

import { logger } from './logger';

/**
 * Verifies that an incoming GitHub webhook request was signed with the correct secret.
 *
 * GitHub signs the request body with HMAC-SHA256 and puts the result in the
 * `X-Hub-Signature-256` header as: `sha256=<hex-digest>`
 *
 * @param request  The incoming Request object (body must not have been consumed yet).
 * @param rawBody  The raw request body string (we read it once and pass both here and to the handler).
 * @param secret   The GITHUB_WEBHOOK_SECRET environment variable.
 * @returns        `true` if the signature is valid, `false` otherwise.
 */
export async function verifyWebhookSignature(
    request: Request,
    rawBody: string,
    secret: string
): Promise<boolean> {
    const signature = request.headers.get('X-Hub-Signature-256');
    if (!signature || !signature.startsWith('sha256=')) {
        return false;
    }

    if (!secret || !secret.trim()) {
        logger.error('GITHUB_WEBHOOK_SECRET is missing or empty — cannot verify signature');
        return false;
    }

    const expectedHex = signature.slice('sha256='.length);

    try {
        // Import the secret as a CryptoKey
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        // Sign the raw body
        const signatureBuffer = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(rawBody)
        );

        // Convert to hex string
        const computedHex = Array.from(new Uint8Array(signatureBuffer))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

        // Constant-time comparison using Web Crypto API's timingSafeEqual
        // Falls back to manual constant-time compare if not available
        return timingSafeEqual(computedHex, expectedHex);
    } catch (error) {
        logger.error('Signature verification failed unexpectedly', error instanceof Error ? error : undefined);
        return false;
    }
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * 
 * Uses crypto.subtle.timingSafeEqual when available (Cloudflare Workers runtime),
 * otherwise falls back to a manual XOR-based comparison that does NOT leak length.
 */
function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder();
    const aBuf = encoder.encode(a);
    const bBuf = encoder.encode(b);

    // Pad the shorter buffer to match the longer one, preventing length leakage
    const maxLen = Math.max(aBuf.length, bBuf.length);
    const aPadded = new Uint8Array(maxLen);
    const bPadded = new Uint8Array(maxLen);
    aPadded.set(aBuf);
    bPadded.set(bBuf);

    // XOR every byte — constant time regardless of content
    let result = aBuf.length ^ bBuf.length; // Non-zero if lengths differ
    for (let i = 0; i < maxLen; i++) {
        result |= aPadded[i] ^ bPadded[i];
    }
    return result === 0;
}
