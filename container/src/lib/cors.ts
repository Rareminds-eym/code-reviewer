/**
 * Industrial-grade CORS handling for the Usage API.
 * Supports configurable origins, preflight requests, and credential handling.
 */

import { getSecurityHeaders } from './security-headers';

export interface CorsConfig {
    /**
     * Allowed origins. Use '*' for any origin, or array of specific origins.
     * Default: '*' (allow any for read-only usage API)
     */
    allowedOrigins: string | string[];
    /**
     * Allowed HTTP methods. Default: ['GET', 'OPTIONS']
     */
    allowedMethods?: string[];
    /**
     * Allowed headers in requests. Default: ['Authorization', 'Content-Type']
     */
    allowedHeaders?: string[];
    /**
     * Headers exposed to client. Default: ['Content-Type', 'X-RateLimit-Limit']
     */
    exposedHeaders?: string[];
    /**
     * Max age for preflight cache (seconds). Default: 86400 (24 hours)
     */
    maxAge?: number;
    /**
     * Allow credentials (cookies/auth). Default: false
     */
    allowCredentials?: boolean;
}

const DEFAULT_CORS_CONFIG: Required<Omit<CorsConfig, 'allowedOrigins'>> & { allowedOrigins: string } = {
    allowedOrigins: '*',
    allowedMethods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
    exposedHeaders: ['Content-Type', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    maxAge: 86400,
    allowCredentials: false,
};

/**
 * Determines if an origin is allowed based on configuration.
 */
function isOriginAllowed(origin: string, allowed: string | string[]): boolean {
    if (allowed === '*') return true;
    if (Array.isArray(allowed)) {
        return allowed.some(a => {
            // Exact match
            if (a === origin) return true;
            // Wildcard subdomain match: *.example.com matches foo.example.com
            if (a.startsWith('*.')) {
                const suffix = a.slice(1); // .example.com
                return origin.endsWith(suffix);
            }
            return false;
        });
    }
    return allowed === origin;
}

/**
 * Generate CORS headers for a request.
 */
export function getCorsHeaders(request: Request, config: CorsConfig): Record<string, string> {
    const origin = request.headers.get('Origin') || '*';
    const cfg = { ...DEFAULT_CORS_CONFIG, ...config };

    const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': cfg.allowedMethods.join(', '),
        'Access-Control-Allow-Headers': cfg.allowedHeaders.join(', '),
        'Access-Control-Expose-Headers': cfg.exposedHeaders.join(', '),
        'Access-Control-Max-Age': String(cfg.maxAge),
    };

    // Handle origin
    if (isOriginAllowed(origin, cfg.allowedOrigins)) {
        headers['Access-Control-Allow-Origin'] = origin;
    } else if (cfg.allowedOrigins === '*') {
        headers['Access-Control-Allow-Origin'] = '*';
    }
    // If origin not allowed, omit the header (browser will block)

    // Credentials handling
    if (cfg.allowCredentials) {
        headers['Access-Control-Allow-Credentials'] = 'true';
        // When credentials are allowed, wildcard origin is forbidden
        if (headers['Access-Control-Allow-Origin'] === '*') {
            headers['Access-Control-Allow-Origin'] = origin || 'null';
        }
    }

    return headers;
}

/**
 * Check if a request is a CORS preflight (OPTIONS request with Origin).
 */
export function isCorsPreflight(request: Request): boolean {
    return request.method === 'OPTIONS' &&
        request.headers.has('Origin') &&
        request.headers.has('Access-Control-Request-Method');
}

/**
 * Create a CORS preflight response.
 */
export function createCorsPreflightResponse(request: Request, config: CorsConfig): Response {
    const corsHeaders = getCorsHeaders(request, config);

    return new Response(null, {
        status: 204, // No content
        headers: {
            ...corsHeaders,
            ...getSecurityHeaders(),
        },
    });
}

/**
 * Create a standard CORS-enabled JSON response.
 */
export function createCorsJsonResponse(
    request: Request,
    body: unknown,
    status: number = 200,
    config: CorsConfig,
    additionalHeaders?: Record<string, string>
): Response {
    const corsHeaders = getCorsHeaders(request, config);

    const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders,
        ...getSecurityHeaders(),
        ...additionalHeaders,
    };

    return new Response(JSON.stringify(body), { status, headers });
}
