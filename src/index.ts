export { ReviewContainer, ContainerProxy } from './container-class';

import type { Env, ReviewMessage } from './types/env';
import { WORKER_VERSION } from './config/constants';
import { handlePRWebhook } from './handlers/webhook';
import { queueHandler } from './handlers/queue';
import {
    getLatestPRUsageMetrics,
    getPRUsageMetrics,
    listRepoUsageMetrics,
    getRepoUsageStats
} from './lib/usage-tracker';
import { normalizeError, AuthenticationError } from './lib/errors';
import { validateRepoIdentifier, validatePRNumber, validateCommitSha, validateLimit } from './lib/validation';
import { logger } from './lib/logger';
import { getSecurityHeaders, createSecureJsonResponse } from './lib/security-headers';
import { isCorsPreflight, createCorsPreflightResponse, createCorsJsonResponse } from './lib/cors';
import { checkRateLimitDistributed, getRateLimitHeaders, createRateLimitResponse } from './lib/rate-limit';
import { extractOrGenerateRequestId, runWithContextAsync, getRequestId } from './lib/request-context';
import { setRequestContextGetter } from './lib/logger';
import { performHealthCheck, getHealthStatusCode } from './lib/health-check';
import { getOperationalMetrics, getPrometheusMetrics, recordRequestMetrics } from './lib/metrics';
import { loginHtml, dashboardHtml } from './handlers/dashboard-html';

// Wire up logger → request context (fix #9: was never connected)
setRequestContextGetter(getRequestId);

// Worker start time for uptime calculation
const workerStartTime = Date.now();

const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

/**
 * Get dashboard credentials from env vars (fallback to defaults only for development).
 * In production, DASHBOARD_USERNAME and DASHBOARD_PASSWORD MUST be set via `wrangler secret put`.
 */
function getDashboardCredentials(env: Env): { username: string; password: string } {
    if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD) {
        throw new Error('500: Dashboard credentials are not configured. Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD in wrangler.jsonc or via secrets.');
    }
    return {
        username: env.DASHBOARD_USERNAME,
        password: env.DASHBOARD_PASSWORD,
    };
}

/**
 * Generate an HMAC-signed session token using the webhook secret as signing key.
 * Format: timestamp.random.signature
 */
async function generateSessionToken(env: Env): Promise<string> {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);
    const payload = `${timestamp}.${random}`;
    const signature = await hmacSign(payload, env.DASHBOARD_SESSION_SECRET || env.GITHUB_WEBHOOK_SECRET);
    return `${payload}.${signature}`;
}

/**
 * HMAC-SHA256 sign a string and return hex digest.
 */
async function hmacSign(data: string, secret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify session cookie — validates the HMAC signature to prevent forgery.
 */
async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
    const cookie = request.headers.get('Cookie');
    if (!cookie) return false;

    const sessionMatch = cookie.match(new RegExp(`${DASHBOARD_SESSION_COOKIE}=([^;]+)`));
    if (!sessionMatch) return false;

    const token = sessionMatch[1];
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const [timestamp, random, signature] = parts;
    const payload = `${timestamp}.${random}`;

    // Verify HMAC signature
    const expectedSig = await hmacSign(payload, env.DASHBOARD_SESSION_SECRET || env.GITHUB_WEBHOOK_SECRET);
    if (signature !== expectedSig) return false;

    // Check token age (max 8 hours)
    const tokenAge = Date.now() - parseInt(timestamp, 36);
    const maxAge = 8 * 60 * 60 * 1000; // 8 hours in ms
    return tokenAge < maxAge;
}

/**
 * Create session cookie response header
 */
async function createSessionCookie(env: Env): Promise<string> {
    const token = await generateSessionToken(env);
    const maxAge = 8 * 60 * 60; // 8 hours
    return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/dashboard`;
}

/**
 * Clear session cookie
 */
function clearSessionCookie(): string {
    return `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/dashboard`;
}

/**
 * Optional authentication for usage endpoints
 * Set USAGE_API_KEY secret to enable
 */
function authenticateUsageRequest(request: Request, env: Env): void {
    // Skip auth if USAGE_API_KEY is not configured
    if (!env.USAGE_API_KEY) {
        return;
    }

    const authHeader = request.headers.get('Authorization');
    const expectedAuth = `Bearer ${env.USAGE_API_KEY}`;

    if (authHeader !== expectedAuth) {
        throw new AuthenticationError('Invalid or missing API key');
    }
}


export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const requestId = extractOrGenerateRequestId(request.headers);
        const context = {
            requestId,
            startTime: Date.now(),
            path: new URL(request.url).pathname,
            method: request.method,
        };

        if (!env.GITHUB_WEBHOOK_SECRET) {
            logger.error('Missing GITHUB_WEBHOOK_SECRET secret');
            return new Response(JSON.stringify({ error: 'Worker is misconfigured (missing GITHUB_WEBHOOK_SECRET)' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return runWithContextAsync(context, async () => {
            const requestStartTime = Date.now();
            const { method, url } = request;
            const { pathname, searchParams } = new URL(url);

            let response: Response = createSecureJsonResponse(
                { error: 'Not Found', message: 'The requested endpoint does not exist' },
                404
            );

            // — Simple Health Check (backward compatible) —
            if (method === 'GET' && pathname === '/') {
                const health = await performHealthCheck(env, WORKER_VERSION, workerStartTime);
                const statusCode = getHealthStatusCode(health);

                response = createSecureJsonResponse(
                    {
                        status: health.status === 'healthy' ? 'ok' : health.status,
                        service: health.service,
                        version: health.version,
                        provider: env.AI_PROVIDER ?? 'claude',
                    },
                    statusCode
                );
            }

            // — Detailed Health Check with Dependencies —
            else if (method === 'GET' && pathname === '/health') {
                const health = await performHealthCheck(env, WORKER_VERSION, workerStartTime);
                const statusCode = getHealthStatusCode(health);

                response = createSecureJsonResponse(health, statusCode);
            }

            // — Operational Metrics Endpoint —
            else if (method === 'GET' && pathname === '/metrics') {
                const format = searchParams.get('format') || 'json';
                const period = (searchParams.get('period') as '1h' | '24h' | '7d') || '24h';

                const metrics = await getOperationalMetrics(env, period);

                if (format === 'prometheus') {
                    response = new Response(getPrometheusMetrics(metrics), {
                        status: 200,
                        headers: {
                            'Content-Type': 'text/plain; version=0.0.4',
                            ...getSecurityHeaders(),
                        },
                    });
                } else {
                    response = createSecureJsonResponse(metrics, 200);
                }
            }

            // — Usage Metrics Endpoints (with CORS and Rate Limiting) —
            // Handle CORS preflight BEFORE the GET method check so OPTIONS requests reach this (fix #12)
            else if (pathname.startsWith('/usage/') && isCorsPreflight(request)) {
                response = createCorsPreflightResponse(request, { allowedOrigins: '*' });
            }
            else if (method === 'GET' && pathname.startsWith('/usage/')) {
                try {
                    // Optional authentication FIRST (fix #13: auth before rate limit)
                    authenticateUsageRequest(request, env);

                    // Check rate limit AFTER auth (authenticated requests are already validated)
                    const rateLimitResult = await checkRateLimitDistributed(request, env, {
                        maxRequests: 100,
                        windowSeconds: 60,
                        burstCapacity: 20,
                    });

                    if (!rateLimitResult.allowed) {
                        logger.warn('Rate limit exceeded', {
                            path: pathname,
                            client: request.headers.get('CF-Connecting-IP') || 'unknown',
                        });
                        response = createRateLimitResponse(rateLimitResult);
                    } else {

                        // GET /usage/{owner}/{repo}/pr/{prNumber}
                        // Returns latest usage for a specific PR
                        const prMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)\/pr\/(\d+)$/);
                        if (prMatch) {
                            const [, owner, repo, prNum] = prMatch;
                            const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;
                            const prNumber = validatePRNumber(parseInt(prNum, 10));

                            const sha = searchParams.get('sha');
                            const metrics = sha
                                ? await getPRUsageMetrics(repoFullName, prNumber, validateCommitSha(sha), env)
                                : await getLatestPRUsageMetrics(repoFullName, prNumber, env);

                            if (!metrics) {
                                response = createCorsJsonResponse(
                                    request,
                                    {
                                        error: 'No usage data found for this PR',
                                        code: 'NOT_FOUND'
                                    },
                                    404,
                                    { allowedOrigins: '*' },
                                    getRateLimitHeaders(rateLimitResult)
                                );
                            } else {
                                response = createCorsJsonResponse(
                                    request,
                                    metrics,
                                    200,
                                    { allowedOrigins: '*' },
                                    getRateLimitHeaders(rateLimitResult)
                                );
                            }
                        }

                        // GET /usage/{owner}/{repo}/stats
                        // Returns aggregate statistics for a repository
                        else {
                            const statsMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)\/stats$/);
                            if (statsMatch) {
                                const [, owner, repo] = statsMatch;
                                const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;

                                const stats = await getRepoUsageStats(repoFullName, env);

                                response = createCorsJsonResponse(
                                    request,
                                    stats,
                                    200,
                                    { allowedOrigins: '*' },
                                    getRateLimitHeaders(rateLimitResult)
                                );
                            }

                            // GET /usage/{owner}/{repo}
                            // Returns list of all usage metrics for a repository
                            else {
                                const listMatch = pathname.match(/^\/usage\/([^/]+)\/([^/]+)$/);
                                if (listMatch) {
                                    const [, owner, repo] = listMatch;
                                    const repoFullName = `${validateRepoIdentifier(owner, 'owner')}/${validateRepoIdentifier(repo, 'repo')}`;
                                    const limit = validateLimit(searchParams.get('limit'));

                                    const metrics = await listRepoUsageMetrics(repoFullName, env, limit);

                                    // Transform metrics to match dashboard expectations
                                    const transformedMetrics = metrics.map(m => ({
                                        ...m,
                                        repository: m.repoFullName,
                                        model: m.calls && m.calls.length > 0 ? m.calls[0].model : 'N/A',
                                    }));

                                    response = createCorsJsonResponse(
                                        request,
                                        transformedMetrics,
                                        200,
                                        { allowedOrigins: '*' },
                                        getRateLimitHeaders(rateLimitResult)
                                    );
                                }

                                else {
                                    response = createCorsJsonResponse(
                                        request,
                                        {
                                            error: 'Invalid usage endpoint',
                                            code: 'INVALID_ENDPOINT'
                                        },
                                        404,
                                        { allowedOrigins: '*' },
                                        getRateLimitHeaders(rateLimitResult)
                                    );
                                }
                            }
                        }
                    } // Close rate limit else
                } catch (error) {
                    const normalizedError = normalizeError(error);

                    logger.error('Usage endpoint error', error instanceof Error ? error : undefined, {
                        pathname,
                        errorCode: normalizedError.code,
                    });

                    response = createCorsJsonResponse(
                        request,
                        {
                            error: normalizedError.message,
                            code: normalizedError.code,
                            ...(normalizedError.context && { context: normalizedError.context }),
                        },
                        normalizedError.statusCode,
                        { allowedOrigins: '*' }
                    );
                }
            }

            // — Dashboard UI with Environment-Based Login —
            else if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
                if (method === 'POST' && pathname === '/dashboard/login') {
                    try {
                        const formData = await request.formData();
                        const username = formData.get('username')?.toString() || '';
                        const password = formData.get('password')?.toString() || '';
                        const creds = getDashboardCredentials(env);

                        if (username === creds.username && password === creds.password) {
                            response = new Response(dashboardHtml, {
                                status: 200,
                                headers: {
                                    'Content-Type': 'text/html',
                                    'Set-Cookie': await createSessionCookie(env),
                                    ...getSecurityHeaders({
                                        contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                    }),
                                },
                            });
                        } else {
                            response = new Response(loginHtml('Invalid username or password'), {
                                status: 401,
                                headers: {
                                    'Content-Type': 'text/html',
                                    ...getSecurityHeaders({
                                        contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                    }),
                                },
                            });
                        }
                    } catch (error) {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        response = new Response(loginHtml(errMsg.startsWith('500') ? errMsg : 'Configuration Error. Please check server logs.'), {
                            status: 500,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    }
                }
                else if (method === 'POST' && pathname === '/dashboard/logout') {
                    response = new Response(loginHtml('Logged out successfully'), {
                        status: 200,
                        headers: {
                            'Content-Type': 'text/html',
                            'Set-Cookie': clearSessionCookie(),
                            ...getSecurityHeaders({
                                contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                            }),
                        },
                    });
                }
                else if (method === 'GET') {
                    if (await isAuthenticated(request, env)) {
                        response = new Response(dashboardHtml, {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    } else {
                        response = new Response(loginHtml(), {
                            status: 200,
                            headers: {
                                'Content-Type': 'text/html',
                                ...getSecurityHeaders({
                                    contentSecurityPolicy: "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'"
                                }),
                            },
                        });
                    }
                }
                else {
                    response = new Response('Method not allowed', { status: 405 });
                }
            }

            // — GitHub Webhook Entry Point —
            else if (method === 'POST' && pathname === '/') {
                try {
                    response = await handlePRWebhook(request, env);
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    logger.error('Unhandled webhook error', error instanceof Error ? error : undefined);
                    response = createSecureJsonResponse(
                        { error: 'Internal server error', detail: errMsg },
                        500
                    );
                }
            }

            // — Method Not Allowed —
            else {
                response = createSecureJsonResponse(
                    { error: 'Method not allowed' },
                    405,
                    { Allow: 'GET, POST' }
                );
            }

            // Record request metrics after response is determined
            recordRequestMetrics(method, response.status, Date.now() - requestStartTime);

            return response;
        });
    },

    /**
     * Background Queue Consumer Handler
     * Delegates to queueHandler which manages per-message request context.
     */
    async queue(batch: MessageBatch<ReviewMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
        try {
            await queueHandler(batch, env, ctx);
        } catch (error) {
            logger.error('Unhandled queue error', error instanceof Error ? error : undefined);
        }
    }
} satisfies ExportedHandler<Env, ReviewMessage>;

