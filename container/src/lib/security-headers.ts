/**
 * Industrial-grade security headers for all HTTP responses.
 * Implements defense-in-depth headers per OWASP recommendations.
 */

export interface SecurityHeaderConfig {
    /**
     * Allow the page to be embedded in frames. Default: DENY
     * Use 'SAMEORIGIN' only if embedding is required.
     */
    frameOptions?: 'DENY' | 'SAMEORIGIN';
    /**
     * Content Security Policy. Default: strict policy for API responses.
     */
    contentSecurityPolicy?: string;
    /**
     * Referrer policy. Default: strict-origin-when-cross-origin
     */
    referrerPolicy?: string;
    /**
     * HSTS max-age in seconds. Default: 31536000 (1 year)
     */
    hstsMaxAge?: number;
    /**
     * Enable HSTS includeSubDomains. Default: true
     */
    hstsIncludeSubDomains?: boolean;
}

const DEFAULT_CONFIG: Required<SecurityHeaderConfig> = {
    frameOptions: 'DENY',
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
    referrerPolicy: 'strict-origin-when-cross-origin',
    hstsMaxAge: 31536000,
    hstsIncludeSubDomains: true,
};

/**
 * Generates security headers for API responses.
 * These headers prevent common attacks: XSS, clickjacking, MIME sniffing.
 */
export function getSecurityHeaders(config: SecurityHeaderConfig = {}): Record<string, string> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const headers: Record<string, string> = {
        // Prevent MIME type sniffing
        'X-Content-Type-Options': 'nosniff',

        // Prevent clickjacking
        'X-Frame-Options': cfg.frameOptions,

        // XSS protection (legacy but still valuable as defense in depth)
        'X-XSS-Protection': '1; mode=block',

        // Referrer policy
        'Referrer-Policy': cfg.referrerPolicy,

        // Content Security Policy
        'Content-Security-Policy': cfg.contentSecurityPolicy,

        // Permissions policy (minimal for API)
        'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    };

    // HSTS (only for HTTPS environments)
    const hstsValue = cfg.hstsIncludeSubDomains
        ? `max-age=${cfg.hstsMaxAge}; includeSubDomains`
        : `max-age=${cfg.hstsMaxAge}`;
    headers['Strict-Transport-Security'] = hstsValue;

    return headers;
}

/**
 * Merge security headers with existing response headers.
 * Security headers take precedence to prevent override.
 */
export function mergeSecurityHeaders(
    existingHeaders: HeadersInit,
    config?: SecurityHeaderConfig
): Record<string, string> {
    const securityHeaders = getSecurityHeaders(config);

    // Convert existing headers to plain object
    const merged: Record<string, string> = {};
    if (existingHeaders instanceof Headers) {
        existingHeaders.forEach((value, key) => {
            merged[key] = value;
        });
    } else if (Array.isArray(existingHeaders)) {
        for (const [key, value] of existingHeaders) {
            merged[key] = value;
        }
    } else {
        Object.assign(merged, existingHeaders);
    }

    // Security headers override any existing values
    return { ...merged, ...securityHeaders };
}

/**
 * Create a standard JSON response with security headers.
 */
export function createSecureJsonResponse(
    body: unknown,
    status: number = 200,
    additionalHeaders?: Record<string, string>
): Response {
    const headers = {
        'Content-Type': 'application/json',
        ...getSecurityHeaders(),
        ...additionalHeaders,
    };

    return new Response(JSON.stringify(body), { status, headers });
}
