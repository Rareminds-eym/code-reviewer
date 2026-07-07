import type { Env } from '../types/env';
import type { PRUsageMetrics, LLMCallUsage } from '../types/usage';
import { calculateCost, USAGE_METRICS_SCHEMA_VERSION } from '../types/usage';
import { KV_CONFIG, KV_KEY_PREFIXES } from '../config/usage-constants';
import { StorageError, NotFoundError, ValidationError } from './errors';
import { validatePRUsageMetrics, validatePRNumber, validateRepoIdentifier, validateCommitSha, validateLimit } from './validation';
import { logger } from './logger';

/**
 * Retry a KV operation with exponential backoff
 */
async function retryKVOperation<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = KV_CONFIG.MAX_RETRIES
): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));

            if (attempt < maxRetries) {
                const delay = Math.min(
                    KV_CONFIG.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt),
                    KV_CONFIG.MAX_RETRY_DELAY_MS
                );

                logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
                    attempt: attempt + 1,
                    maxRetries,
                    error: lastError.message,
                });

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw new StorageError(
        `${operationName} failed after ${maxRetries} retries`,
        { lastError: lastError?.message }
    );
}

/**
 * Store PR usage metrics in KV with retry logic
 * Key format: usage:{repoFullName}:{prNumber}:{headSha}
 */
export async function storePRUsageMetrics(
    metrics: PRUsageMetrics,
    env: Env
): Promise<void> {
    try {
        // Validate metrics before storage
        const validatedMetrics = validatePRUsageMetrics(metrics);

        const key = `${KV_KEY_PREFIXES.USAGE}:${validatedMetrics.repoFullName}:${validatedMetrics.prNumber}:${validatedMetrics.headSha}`;
        const prKey = `${KV_KEY_PREFIXES.USAGE}:${validatedMetrics.repoFullName}:${validatedMetrics.prNumber}:${KV_KEY_PREFIXES.LATEST}`;

        const serialized = JSON.stringify(validatedMetrics);

        // Store with retry logic
        // We store the validatedMetrics as metadata too! This allows O(1) bulk fetching
        // without N+1 individual .get() calls. The metadata limit is 1024 bytes which
        // easily fits this object.
        await retryKVOperation(
            () => env.USAGE_METRICS.put(key, serialized, {
                expirationTtl: KV_CONFIG.METRICS_TTL_SECONDS,
                // CRITICAL: Metadata is strictly limited to 1024 bytes in Cloudflare KV.
                // Never pass the entire validatedMetrics object as it contains the `calls` array.
                metadata: {
                    schemaVersion: validatedMetrics.schemaVersion,
                    prNumber: validatedMetrics.prNumber,
                    repoFullName: validatedMetrics.repoFullName,
                    headSha: validatedMetrics.headSha,
                    provider: validatedMetrics.provider,
                    startTime: validatedMetrics.startTime,
                    endTime: validatedMetrics.endTime,
                    durationMs: validatedMetrics.durationMs,
                    totalInputTokens: validatedMetrics.totalInputTokens,
                    totalOutputTokens: validatedMetrics.totalOutputTokens,
                    totalTokens: validatedMetrics.totalTokens,
                    estimatedCost: validatedMetrics.estimatedCost,
                    filesReviewed: validatedMetrics.filesReviewed,
                    chunksProcessed: validatedMetrics.chunksProcessed,
                    findingsCount: validatedMetrics.findingsCount,
                    status: validatedMetrics.status,
                }
            }),
            'KV put (main key)'
        );

        // Store latest key (best effort, don't fail if this fails)
        try {
            await retryKVOperation(
                () => env.USAGE_METRICS.put(prKey, serialized, {
                    expirationTtl: KV_CONFIG.METRICS_TTL_SECONDS,
                }),
                'KV put (latest key)'
            );
        } catch (error) {
            logger.warn('Failed to store latest key, continuing', {
                prKey,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        logger.info('Stored usage metrics', {
            prNumber: validatedMetrics.prNumber,
            repoFullName: validatedMetrics.repoFullName,
            totalTokens: validatedMetrics.totalTokens,
            estimatedCost: validatedMetrics.estimatedCost,
        });
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }

        logger.error('Failed to store usage metrics', error instanceof Error ? error : undefined, {
            prNumber: metrics.prNumber,
            repoFullName: metrics.repoFullName,
        });

        throw new StorageError(
            'Failed to store usage metrics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * Retrieve usage metrics for a specific PR and commit
 */
export async function getPRUsageMetrics(
    repoFullName: string,
    prNumber: number,
    headSha: string,
    env: Env
): Promise<PRUsageMetrics | null> {
    try {
        // Validate inputs
        const [owner, repo] = repoFullName.split('/');
        validateRepoIdentifier(owner, 'owner');
        validateRepoIdentifier(repo, 'repo');
        validatePRNumber(prNumber);
        validateCommitSha(headSha);

        const key = `${KV_KEY_PREFIXES.USAGE}:${repoFullName}:${prNumber}:${headSha}`;

        const data = await retryKVOperation(
            () => env.USAGE_METRICS.get(key),
            'KV get'
        );

        if (!data) {
            return null;
        }

        const parsed = JSON.parse(data);
        return validatePRUsageMetrics(parsed);
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }

        logger.error('Failed to retrieve PR usage metrics', error instanceof Error ? error : undefined, {
            repoFullName,
            prNumber,
            headSha,
        });

        throw new StorageError(
            'Failed to retrieve usage metrics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * Retrieve the latest usage metrics for a PR (regardless of commit)
 */
export async function getLatestPRUsageMetrics(
    repoFullName: string,
    prNumber: number,
    env: Env
): Promise<PRUsageMetrics | null> {
    try {
        // Validate inputs
        const [owner, repo] = repoFullName.split('/');
        validateRepoIdentifier(owner, 'owner');
        validateRepoIdentifier(repo, 'repo');
        validatePRNumber(prNumber);

        const prKey = `${KV_KEY_PREFIXES.USAGE}:${repoFullName}:${prNumber}:${KV_KEY_PREFIXES.LATEST}`;

        const data = await retryKVOperation(
            () => env.USAGE_METRICS.get(prKey),
            'KV get (latest)'
        );

        if (!data) {
            return null;
        }

        const parsed = JSON.parse(data);
        return validatePRUsageMetrics(parsed);
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }

        logger.error('Failed to retrieve latest PR usage metrics', error instanceof Error ? error : undefined, {
            repoFullName,
            prNumber,
        });

        throw new StorageError(
            'Failed to retrieve latest usage metrics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * List all usage metrics for a repository
 * Returns up to specified limit of most recent entries
 */
export async function listRepoUsageMetrics(
    repoFullName: string,
    env: Env,
    limit: number = KV_CONFIG.DEFAULT_LIST_LIMIT
): Promise<PRUsageMetrics[]> {
    try {
        // Validate inputs
        const [owner, repo] = repoFullName.split('/');
        validateRepoIdentifier(owner, 'owner');
        validateRepoIdentifier(repo, 'repo');
        const validatedLimit = validateLimit(limit, KV_CONFIG.MAX_LIST_LIMIT);

        const prefix = `${KV_KEY_PREFIXES.USAGE}:${repoFullName}:`;
        const metrics: PRUsageMetrics[] = [];

        // H7/H8 Fix: Implement pagination (cursor) and use metadata to eliminate N+1 reads
        let cursor: string | undefined;
        let listComplete = false;

        while (!listComplete && metrics.length < validatedLimit) {
            const batchLimit = Math.min(1000, validatedLimit - metrics.length);
            const list = await retryKVOperation(
                () => env.USAGE_METRICS.list({ prefix, limit: batchLimit, cursor }),
                'KV list'
            ) as { keys: Array<{ name: string; metadata?: any }>; list_complete: boolean; cursor?: string };

            for (const key of list.keys) {
                // Skip "latest" keys to avoid duplicates
                if (key.name.endsWith(`:${KV_KEY_PREFIXES.LATEST}`)) {
                    continue;
                }

                // Read from metadata if available (the new fast path), fallback to get() for old keys
                try {
                    if (key.metadata) {
                        metrics.push(validatePRUsageMetrics(key.metadata));
                    } else {
                        // Legacy path for keys saved before metadata was added
                        const data = await retryKVOperation(
                            () => env.USAGE_METRICS.get(key.name),
                            `KV get (${key.name})`
                        );
                        if (data) {
                            const parsed = JSON.parse(data);
                            metrics.push(validatePRUsageMetrics(parsed));
                        }
                    }
                } catch (error) {
                    logger.warn('Failed to parse metrics entry, skipping', {
                        key: key.name,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            listComplete = list.list_complete;
            cursor = list.list_complete ? undefined : list.cursor;
        }

        // Sort by timestamp (most recent first)
        metrics.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

        return metrics;
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }

        logger.error('Failed to list repo usage metrics', error instanceof Error ? error : undefined, {
            repoFullName,
            limit,
        });

        throw new StorageError(
            'Failed to list usage metrics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * Calculate aggregate statistics for a repository
 */
export async function getRepoUsageStats(
    repoFullName: string,
    env: Env
): Promise<{
    totalReviews: number;
    totalTokens: number;
    totalCost: number;
    avgTokensPerReview: number;
    avgCostPerReview: number;
    byProvider: Record<string, { reviews: number; tokens: number; cost: number }>;
}> {
    try {
        // Validate input
        const [owner, repo] = repoFullName.split('/');
        validateRepoIdentifier(owner, 'owner');
        validateRepoIdentifier(repo, 'repo');

        const metrics = await listRepoUsageMetrics(repoFullName, env, KV_CONFIG.MAX_LIST_LIMIT);

        const stats = {
            totalReviews: metrics.length,
            totalTokens: 0,
            totalCost: 0,
            avgTokensPerReview: 0,
            avgCostPerReview: 0,
            byProvider: {} as Record<string, { reviews: number; tokens: number; cost: number }>,
        };

        for (const m of metrics) {
            stats.totalTokens += m.totalTokens;
            stats.totalCost += m.estimatedCost;

            if (!stats.byProvider[m.provider]) {
                stats.byProvider[m.provider] = { reviews: 0, tokens: 0, cost: 0 };
            }
            stats.byProvider[m.provider].reviews++;
            stats.byProvider[m.provider].tokens += m.totalTokens;
            stats.byProvider[m.provider].cost += m.estimatedCost;
        }

        if (stats.totalReviews > 0) {
            stats.avgTokensPerReview = stats.totalTokens / stats.totalReviews;
            stats.avgCostPerReview = stats.totalCost / stats.totalReviews;
        }

        return stats;
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }

        logger.error('Failed to calculate repo usage stats', error instanceof Error ? error : undefined, {
            repoFullName,
        });

        throw new StorageError(
            'Failed to calculate usage statistics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}

/**
 * Build PRUsageMetrics from collected LLM call data with validation
 */
export function buildPRUsageMetrics(
    prNumber: number,
    repoFullName: string,
    headSha: string,
    provider: string,
    startTime: string,
    calls: LLMCallUsage[],
    filesReviewed: number,
    chunksProcessed: number,
    findingsCount: number,
    status: 'success' | 'partial' | 'failed'
): PRUsageMetrics {
    try {
        // Validate inputs
        validatePRNumber(prNumber);
        const [owner, repo] = repoFullName.split('/');
        validateRepoIdentifier(owner, 'owner');
        validateRepoIdentifier(repo, 'repo');
        validateCommitSha(headSha);

        if (!['claude', 'gemini'].includes(provider)) {
            throw new ValidationError('Invalid provider', { provider });
        }

        if (!Array.isArray(calls) || calls.length === 0) {
            throw new ValidationError('calls must be a non-empty array');
        }

        const totalInputTokens = calls.reduce((sum, c) => sum + c.usage.inputTokens, 0);
        const totalOutputTokens = calls.reduce((sum, c) => sum + c.usage.outputTokens, 0);
        const totalTokens = totalInputTokens + totalOutputTokens;

        // Get the primary model used (most calls)
        const modelCounts = calls.reduce((acc, call) => {
            acc[call.model] = (acc[call.model] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        const primaryModel = Object.entries(modelCounts)
            .sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || provider;

        const estimatedCost = calculateCost(
            provider as 'claude' | 'gemini',
            primaryModel,
            totalInputTokens,
            totalOutputTokens
        );

        const startTimeMs = new Date(startTime).getTime();
        if (isNaN(startTimeMs)) {
            throw new ValidationError('Invalid startTime date format', { startTime });
        }

        const metrics: PRUsageMetrics = {
            schemaVersion: USAGE_METRICS_SCHEMA_VERSION,
            prNumber,
            repoFullName,
            headSha,
            provider,
            startTime,
            endTime: new Date().toISOString(),
            durationMs: Date.now() - startTimeMs,
            calls,
            totalInputTokens,
            totalOutputTokens,
            totalTokens,
            estimatedCost,
            filesReviewed,
            chunksProcessed,
            findingsCount,
            status,
        };

        // Validate the built metrics
        return validatePRUsageMetrics(metrics);
    } catch (error) {
        logger.error('Failed to build PR usage metrics', error instanceof Error ? error : undefined, {
            prNumber,
            repoFullName,
        });

        if (error instanceof ValidationError) {
            throw error;
        }

        throw new ValidationError(
            'Failed to build usage metrics',
            { originalError: error instanceof Error ? error.message : String(error) }
        );
    }
}
