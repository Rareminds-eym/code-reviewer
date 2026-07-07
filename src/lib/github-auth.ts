import type { Env } from '../types/env';
import { logger } from './logger';

const GITHUB_API_BASE = 'https://api.github.com';

// ---------------------------------------------------------------------------
// PEM → CryptoKey (RS256 / PKCS8)
// ---------------------------------------------------------------------------

/**
 * Pure JS utility to wrap PKCS#1 RSA Private Key DER into a PKCS#8 Private Key Info structure.
 * Required because Web Crypto API (crypto.subtle.importKey) only accepts PKCS#8 format.
 */
function convertPkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
    const len = pkcs1Der.length;
    let header: number[];

    if (len < 128) {
        header = [
            0x30, len + 20, // SEQUENCE
            0x02, 0x01, 0x00, // Version (0)
            0x30, 0x0d, // AlgorithmIdentifier SEQUENCE
            0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // rsaEncryption OID
            0x05, 0x00, // NULL parameters
            0x04, len // OCTET STRING
        ];
    } else if (len < 256) {
        header = [
            0x30, 0x81, len + 21,
            0x02, 0x01, 0x00,
            0x30, 0x0d,
            0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
            0x05, 0x00,
            0x04, 0x81, len
        ];
    } else if (len < 65536) {
        const lenHi = (len >> 8) & 0xff;
        const lenLo = len & 0xff;
        
        const outerLen = len + 22;
        const outerLenHi = (outerLen >> 8) & 0xff;
        const outerLenLo = outerLen & 0xff;
        
        header = [
            0x30, 0x82, outerLenHi, outerLenLo,
            0x02, 0x01, 0x00,
            0x30, 0x0d,
            0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
            0x05, 0x00,
            0x04, 0x82, lenHi, lenLo
        ];
    } else {
        throw new Error('Key length is too large for PKCS#8 wrapping');
    }

    const pkcs8Der = new Uint8Array(header.length + len);
    pkcs8Der.set(header, 0);
    pkcs8Der.set(pkcs1Der, header.length);
    return pkcs8Der;
}

/**
 * Parses a PEM-encoded RSA private key into a CryptoKey suitable for RS256 signing.
 * Works natively in Cloudflare Workers via the Web Crypto API (no Node deps).
 * Auto-detects and wraps PKCS#1 keys (BEGIN RSA PRIVATE KEY) into PKCS#8 format.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
    // Gap 60: Replace literal '\n' sequences from .dev.vars with actual newlines
    const normalized = pem.replace(/\\n/g, '\n');
    const isPkcs1 = normalized.includes('-----BEGIN RSA PRIVATE KEY-----');

    // Strip PEM armor and whitespace
    const stripped = normalized
        .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
        .replace(/-----END RSA PRIVATE KEY-----/g, '')
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s+/g, '');

    if (!stripped) {
        throw new Error(
            '[github-auth] GITHUB_APP_PRIVATE_KEY is empty or malformed. ' +
            'Make sure the full PEM key (including newlines) is set as a Cloudflare secret.'
        );
    }

    let binaryDer: Uint8Array;
    try {
        binaryDer = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
    } catch {
        throw new Error(
            '[github-auth] GITHUB_APP_PRIVATE_KEY contains invalid Base64. ' +
            'Ensure the PEM key is not truncated or corrupted.'
        );
    }

    // Task 0l: Wrap PKCS#1 DER to PKCS#8 format if needed
    if (isPkcs1) {
        try {
            binaryDer = convertPkcs1ToPkcs8(binaryDer);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            throw new Error(`[github-auth] Failed to wrap PKCS#1 key to PKCS#8: ${errMsg}`);
        }
    }

    try {
        return await crypto.subtle.importKey(
            'pkcs8',
            binaryDer.buffer as ArrayBuffer,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign']
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
            `[github-auth] Failed to import private key — the key format may be unsupported. ` +
            `Ensure it is a PKCS8-encoded RSA key. Detail: ${errMsg}`
        );
    }
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64url(input: string): string {
    return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// JWT Generation (RS256)
// ---------------------------------------------------------------------------

/**
 * Generates a short-lived JWT for GitHub App authentication (max 10 minutes).
 * Uses the Web Crypto API for RS256 signing — zero external dependencies.
 */
export async function generateAppJWT(appId: string, privateKeyPem: string): Promise<string> {
    if (!appId || !appId.trim()) {
        throw new Error('[github-auth] GITHUB_APP_ID is missing or empty. Set it via `wrangler secret put GITHUB_APP_ID`.');
    }
    if (!privateKeyPem || !privateKeyPem.trim()) {
        throw new Error('[github-auth] GITHUB_APP_PRIVATE_KEY is missing or empty. Set it via `wrangler secret put GITHUB_APP_PRIVATE_KEY`.');
    }

    const now = Math.floor(Date.now() / 1000);

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
        JSON.stringify({
            iat: now - 60,        // Issued at: 60 seconds in the past to handle clock drift
            exp: now + 10 * 60,   // Expiration: 10 minutes (GitHub maximum)
            iss: appId,           // Issuer: the App ID
        })
    );

    const signingInput = `${header}.${payload}`;
    const key = await importPrivateKey(privateKeyPem);

    let signatureBuffer: ArrayBuffer;
    try {
        signatureBuffer = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            new TextEncoder().encode(signingInput)
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`[github-auth] JWT signing failed: ${errMsg}`);
    }

    return `${signingInput}.${base64urlFromBuffer(signatureBuffer)}`;
}

// ---------------------------------------------------------------------------
// Installation Token
// ---------------------------------------------------------------------------

interface InstallationTokenResponse {
    token: string;
    expires_at: string;
}

/**
 * Exchanges a GitHub App JWT for a short-lived installation access token.
 * This token is used for all subsequent GitHub API calls and expires after 1 hour.
 *
 * Caches the token in KV (30-min TTL) to avoid burning 2 subrequests
 * (JWT generation + HTTP exchange) on every review.
 */
const INSTALL_TOKEN_KV_KEY = 'github-install-token';
const INSTALL_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes (10-min safety margin before 1hr expiry)

export async function getInstallationToken(env: Env): Promise<string> {
    if (!env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_INSTALLATION_ID.trim()) {
        throw new Error(
            '[github-auth] GITHUB_APP_INSTALLATION_ID is missing. ' +
            'Set it via `wrangler secret put GITHUB_APP_INSTALLATION_ID`.'
        );
    }

    // Check KV cache first
    try {
        const cached = await env.AUTH_KV.get(INSTALL_TOKEN_KV_KEY);
        if (cached) {
            logger.debug('Using cached installation token');
            return cached;
        }
    } catch {
        // KV read failed — fall through to generate a new token
        logger.warn('KV cache read failed for installation token, generating fresh');
    }

    // Generate fresh token
    const token = await generateFreshInstallationToken(env);

    // Cache it with TTL
    try {
        await env.AUTH_KV.put(INSTALL_TOKEN_KV_KEY, token, {
            expirationTtl: INSTALL_TOKEN_TTL_SECONDS,
        });
    } catch {
        // Non-fatal: cache write failure doesn't block the review
        logger.warn('Failed to cache installation token in KV');
    }

    return token;
}

/**
 * Invalidate the cached installation token.
 * Call this when a GitHub API call returns 401 to force re-authentication.
 */
export async function invalidateInstallationToken(env: Env): Promise<void> {
    try {
        await env.AUTH_KV.delete(INSTALL_TOKEN_KV_KEY);
    } catch {
        // Best-effort deletion
    }
}

/**
 * Generate a fresh installation token from GitHub.
 * Internal — use getInstallationToken() which adds KV caching.
 */
async function generateFreshInstallationToken(env: Env): Promise<string> {
    const jwt = await generateAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

    let response: Response;
    try {
        response = await fetch(
            `${GITHUB_API_BASE}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'code-reviewer-agent/1.0',
                },
            }
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
            `[github-auth] Network error while requesting installation token: ${errMsg}`
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `[github-auth] GitHub rejected the installation token request ` +
            `(HTTP ${response.status}): ${errorText}`
        );
    }

    const data: InstallationTokenResponse = await response.json();
    logger.info('Installation token obtained', {
        expiresAt: data.expires_at,
    });
    return data.token;
}
