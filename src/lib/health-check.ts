import type { Env } from '../types/env';
import { logger } from './logger';

/**
 * Health status for individual dependency
 */
export interface DependencyHealth {
    name: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    latencyMs: number;
    message?: string;
    lastChecked: string;
}

/**
 * Overall health check response
 */
export interface HealthCheckResult {
    status: 'healthy' | 'degraded' | 'unhealthy';
    service: string;
    version: string;
    timestamp: string;
    uptime?: number;
    dependencies: DependencyHealth[];
    checks: {
        total: number;
        passed: number;
        failed: number;
    };
}

/**
 * Check KV connectivity and performance
 */
async function checkKVHealth(env: Env): Promise<DependencyHealth> {
    const startTime = Date.now();
    const name = 'kv';

    try {
        // Perform a lightweight KV operation
        await env.USAGE_METRICS.list({ limit: 1 });

        return {
            name,
            status: 'healthy',
            latencyMs: Date.now() - startTime,
            lastChecked: new Date().toISOString(),
        };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('KV health check failed', error instanceof Error ? error : undefined);

        return {
            name,
            status: 'unhealthy',
            latencyMs: Date.now() - startTime,
            message: errMsg,
            lastChecked: new Date().toISOString(),
        };
    }
}

/**
 * Check GitHub API connectivity
 */
async function checkGitHubHealth(): Promise<DependencyHealth> {
    const startTime = Date.now();
    const name = 'github-api';

    try {
        // Check GitHub API status (lightweight request to API root)
        const response = await fetch('https://api.github.com', {
            method: 'GET',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'code-reviewer-health-check',
            },
        });

        // Consume response body to prevent resource leaks
        await response.body?.cancel();

        if (response.ok) {
            return {
                name,
                status: 'healthy',
                latencyMs: Date.now() - startTime,
                lastChecked: new Date().toISOString(),
            };
        } else {
            throw new Error(`GitHub API returned ${response.status}`);
        }
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn('GitHub API health check failed', { error: errMsg });

        return {
            name,
            status: 'degraded',
            latencyMs: Date.now() - startTime,
            message: errMsg,
            lastChecked: new Date().toISOString(),
        };
    }
}

/**
 * Check LLM API connectivity
 */
async function checkLLMHealth(env: Env): Promise<DependencyHealth> {
    const startTime = Date.now();
    const provider = env.AI_PROVIDER ?? 'claude';
    const name = `llm-${provider}`;

    try {
        if (provider === 'claude') {
            // Check Anthropic API with a lightweight request
            const response = await fetch('https://api.anthropic.com/v1/models', {
                method: 'GET',
                headers: {
                    'x-api-key': env.ANTHROPIC_API_KEY || '',
                    'anthropic-version': '2023-06-01',
                },
            });

            // Always consume response body to prevent socket/connection leaks
            await response.body?.cancel();

            if (response.ok) {
                return {
                    name,
                    status: 'healthy',
                    latencyMs: Date.now() - startTime,
                    lastChecked: new Date().toISOString(),
                };
            } else if (response.status === 401) {
                // 401 means API key is invalid/expired — API is reachable but reviewer can't function
                return {
                    name,
                    status: 'degraded',
                    latencyMs: Date.now() - startTime,
                    message: 'API key is invalid or expired',
                    lastChecked: new Date().toISOString(),
                };
            } else {
                throw new Error(`Anthropic API returned ${response.status}`);
            }
        } else {
            // Check Gemini API
            const apiKey = env.GEMINI_API_KEY;
            if (!apiKey) {
                throw new Error('Gemini API key not configured');
            }

            const response = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { method: 'GET', headers: { 'x-goog-api-key': apiKey } }
            );

            // Always consume response body to prevent socket/connection leaks
            await response.body?.cancel();

            if (response.ok) {
                return {
                    name,
                    status: 'healthy',
                    latencyMs: Date.now() - startTime,
                    lastChecked: new Date().toISOString(),
                };
            } else if (response.status === 401 || response.status === 403) {
                return {
                    name,
                    status: 'degraded',
                    latencyMs: Date.now() - startTime,
                    message: 'API key is invalid or expired',
                    lastChecked: new Date().toISOString(),
                };
            } else {
                throw new Error(`Gemini API returned ${response.status}`);
            }
        }
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`${provider} LLM health check failed`, { error: errMsg });

        return {
            name,
            status: 'degraded',
            latencyMs: Date.now() - startTime,
            message: errMsg,
            lastChecked: new Date().toISOString(),
        };
    }
}

/**
 * Check Queue binding configuration
 */
function checkQueueHealth(env: Env): DependencyHealth {
    const startTime = Date.now();
    const name = 'queue';

    try {
        // Check if queue binding exists and is accessible
        if (!env.REVIEW_QUEUE) {
            throw new Error('Queue binding not configured');
        }

        // Verify the queue has the required methods
        if (typeof env.REVIEW_QUEUE.send !== 'function') {
            throw new Error('Queue binding missing send method');
        }

        return {
            name,
            status: 'healthy',
            latencyMs: Date.now() - startTime,
            lastChecked: new Date().toISOString(),
        };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('Queue health check failed', error instanceof Error ? error : undefined);

        return {
            name,
            status: 'unhealthy',
            latencyMs: Date.now() - startTime,
            message: errMsg,
            lastChecked: new Date().toISOString(),
        };
    }
}

/**
 * Check ephemeral Container health via Durable Object ping
 */
async function checkContainerHealth(env: Env): Promise<DependencyHealth> {
    const startTime = Date.now();
    const name = 'container';

    try {
        if (!env.REVIEW_CONTAINER) {
            throw new Error('REVIEW_CONTAINER binding not configured');
        }

        const id = env.REVIEW_CONTAINER.idFromName('review-container');
        const container = env.REVIEW_CONTAINER.get(id);
        const response = await container.fetch('http://container/ping');

        if (response.ok) {
            return {
                name,
                status: 'healthy',
                latencyMs: Date.now() - startTime,
                lastChecked: new Date().toISOString(),
            };
        } else {
            throw new Error(`Container returned HTTP ${response.status}`);
        }
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn('Container health check failed', { error: errMsg });

        if (errMsg.includes('Containers have not been enabled') || errMsg.includes('Durable Object class')) {
            return {
                name,
                status: 'healthy',
                latencyMs: Date.now() - startTime,
                lastChecked: new Date().toISOString(),
            };
        }

        return {
            name,
            status: 'unhealthy',
            message: errMsg,
            latencyMs: Date.now() - startTime,
            lastChecked: new Date().toISOString(),
        };
    }
}

/**
 * Perform comprehensive health check of all dependencies
 */
export async function performHealthCheck(
    env: Env,
    version: string,
    startTime?: number
): Promise<HealthCheckResult> {
    const checkStartTime = Date.now();

    // Run all health checks in parallel
    const [kvHealth, githubHealth, llmHealth, queueHealth, containerHealth] = await Promise.all([
        checkKVHealth(env),
        checkGitHubHealth(),
        checkLLMHealth(env),
        Promise.resolve(checkQueueHealth(env)), // sync, wrap in Promise for consistency
        checkContainerHealth(env),
    ]);

    const dependencies = [kvHealth, githubHealth, llmHealth, queueHealth, containerHealth];

    // Calculate overall status
    const failedCount = dependencies.filter(d => d.status === 'unhealthy').length;
    const degradedCount = dependencies.filter(d => d.status === 'degraded').length;

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (failedCount > 0) {
        overallStatus = 'unhealthy';
    } else if (degradedCount > 0) {
        overallStatus = 'degraded';
    } else {
        overallStatus = 'healthy';
    }

    const result: HealthCheckResult = {
        status: overallStatus,
        service: 'code-reviewer-agent',
        version,
        timestamp: new Date().toISOString(),
        uptime: startTime ? Math.floor((Date.now() - startTime) / 1000) : undefined,
        dependencies,
        checks: {
            total: dependencies.length,
            passed: dependencies.filter(d => d.status === 'healthy').length,
            failed: failedCount,
        },
    };

    logger.info('Health check completed', {
        status: result.status,
        durationMs: Date.now() - checkStartTime,
        checksPassed: result.checks.passed,
        checksFailed: result.checks.failed,
    });

    return result;
}

/**
 * Get HTTP status code from health check result
 */
export function getHealthStatusCode(result: HealthCheckResult): number {
    switch (result.status) {
        case 'healthy':
            return 200;
        case 'degraded':
            return 200; // Still operational, but with warnings
        case 'unhealthy':
            return 503; // Service unavailable
        default:
            return 503;
    }
}
