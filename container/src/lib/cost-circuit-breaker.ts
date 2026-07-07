/**
 * COST CIRCUIT BREAKER
 * 
 * Prevents runaway API costs by tracking spending and opening circuit
 * when budget limits are exceeded.
 * 
 * Based on patterns from:
 * - AWS Cost Anomaly Detection
 * - Google Cloud Budget Alerts
 * - Stripe Spending Limits
 * 
 * Key Features:
 * - Real-time cost tracking per provider
 * - Hourly and daily budget limits
 * - Automatic circuit opening on budget breach
 * - Cost attribution per repository
 * - Alert webhooks for budget warnings
 */

import type { Env } from '../types/env';
import { logger } from './logger';

export interface CostBudget {
    /** Maximum spend per hour (USD) */
    hourlyLimit: number;
    /** Maximum spend per day (USD) */
    dailyLimit: number;
    /** Warning threshold (0-1, e.g., 0.8 = 80%) */
    warningThreshold: number;
    /** Critical threshold (0-1, e.g., 0.95 = 95%) */
    criticalThreshold: number;
}

export interface CostMetrics {
    provider: string;
    hourlySpend: number;
    dailySpend: number;
    totalRequests: number;
    averageCostPerRequest: number;
    lastResetTime: number;
}

export interface CostCheckResult {
    allowed: boolean;
    reason?: string;
    currentSpend: number;
    budgetLimit: number;
    utilizationPercent: number;
}

/**
 * Cost circuit breaker with distributed state via KV.
 */
export class CostCircuitBreaker {
    private readonly provider: string;
    private readonly budget: CostBudget;
    private readonly env: Env;

    // Pricing per 1M tokens (as of April 2026)
    private static readonly PRICING = {
        claude: {
            input: 3.0,  // $3 per 1M input tokens (Sonnet 4)
            output: 15.0, // $15 per 1M output tokens
        },
        gemini: {
            input: 0.075,  // $0.075 per 1M input tokens (2.0 Flash)
            output: 0.30,  // $0.30 per 1M output tokens
        },
    };

    constructor(provider: string, budget: CostBudget, env: Env) {
        this.provider = provider;
        this.budget = budget;
        this.env = env;
    }

    /**
     * Check if request is allowed based on cost budget.
     * Returns false if budget would be exceeded.
     */
    async checkBudget(estimatedCost: number): Promise<CostCheckResult> {
        const metrics = await this.getMetrics();

        // Check hourly budget
        const hourlySpendAfter = metrics.hourlySpend + estimatedCost;
        if (hourlySpendAfter > this.budget.hourlyLimit) {
            logger.error('[CostCircuitBreaker] Hourly budget exceeded', undefined, {
                provider: this.provider,
                currentSpend: metrics.hourlySpend,
                limit: this.budget.hourlyLimit,
                requestCost: estimatedCost,
            });

            return {
                allowed: false,
                reason: 'Hourly budget exceeded',
                currentSpend: metrics.hourlySpend,
                budgetLimit: this.budget.hourlyLimit,
                utilizationPercent: (metrics.hourlySpend / this.budget.hourlyLimit) * 100,
            };
        }

        // Check daily budget
        const dailySpendAfter = metrics.dailySpend + estimatedCost;
        if (dailySpendAfter > this.budget.dailyLimit) {
            logger.error('[CostCircuitBreaker] Daily budget exceeded', undefined, {
                provider: this.provider,
                currentSpend: metrics.dailySpend,
                limit: this.budget.dailyLimit,
                requestCost: estimatedCost,
            });

            return {
                allowed: false,
                reason: 'Daily budget exceeded',
                currentSpend: metrics.dailySpend,
                budgetLimit: this.budget.dailyLimit,
                utilizationPercent: (metrics.dailySpend / this.budget.dailyLimit) * 100,
            };
        }

        // Check warning threshold
        const hourlyUtilization = hourlySpendAfter / this.budget.hourlyLimit;
        if (hourlyUtilization >= this.budget.warningThreshold && hourlyUtilization < this.budget.criticalThreshold) {
            logger.warn('[CostCircuitBreaker] Budget warning threshold reached', {
                provider: this.provider,
                hourlySpend: hourlySpendAfter,
                limit: this.budget.hourlyLimit,
                utilization: (hourlyUtilization * 100).toFixed(1) + '%',
            });

            // Send alert webhook (non-blocking)
            this.sendBudgetAlert('warning', metrics, hourlyUtilization).catch(err => {
                logger.error('[CostCircuitBreaker] Failed to send warning alert', err);
            });
        }

        // Check critical threshold
        if (hourlyUtilization >= this.budget.criticalThreshold) {
            logger.error('[CostCircuitBreaker] Budget critical threshold reached', undefined, {
                provider: this.provider,
                hourlySpend: hourlySpendAfter,
                limit: this.budget.hourlyLimit,
                utilization: (hourlyUtilization * 100).toFixed(1) + '%',
            });

            // Send alert webhook (non-blocking)
            this.sendBudgetAlert('critical', metrics, hourlyUtilization).catch(err => {
                logger.error('[CostCircuitBreaker] Failed to send critical alert', err);
            });
        }

        return {
            allowed: true,
            currentSpend: metrics.hourlySpend,
            budgetLimit: this.budget.hourlyLimit,
            utilizationPercent: hourlyUtilization * 100,
        };
    }

    /**
     * Record actual cost after API response.
     */
    async recordCost(actualCost: number, repoFullName?: string): Promise<void> {
        const metrics = await this.getMetrics();

        metrics.hourlySpend += actualCost;
        metrics.dailySpend += actualCost;
        metrics.totalRequests++;
        metrics.averageCostPerRequest = metrics.dailySpend / metrics.totalRequests;

        await this.saveMetrics(metrics);

        // Record per-repo cost attribution
        if (repoFullName) {
            await this.recordRepoCost(repoFullName, actualCost);
        }

        logger.debug('[CostCircuitBreaker] Cost recorded', {
            provider: this.provider,
            cost: actualCost.toFixed(4),
            hourlySpend: metrics.hourlySpend.toFixed(2),
            dailySpend: metrics.dailySpend.toFixed(2),
        });
    }

    /**
     * Calculate estimated cost for a request.
     */
    static estimateCost(
        provider: string,
        inputTokens: number,
        outputTokens: number
    ): number {
        const pricing = this.PRICING[provider as keyof typeof this.PRICING];
        if (!pricing) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        const inputCost = (inputTokens / 1_000_000) * pricing.input;
        const outputCost = (outputTokens / 1_000_000) * pricing.output;

        return inputCost + outputCost;
    }

    /**
     * Get current cost metrics from KV.
     * Properly resets both hourly and daily metrics when boundaries are crossed.
     */
    private async getMetrics(): Promise<CostMetrics> {
        const now = Date.now();
        const hourKey = this.getHourKey();
        const dayKey = this.getDayKey();

        const [hourData, dayData] = await Promise.all([
            this.env.CACHE_KV.get(hourKey),
            this.env.CACHE_KV.get(dayKey),
        ]);

        const hourMetrics = hourData ? JSON.parse(hourData) as CostMetrics : null;
        const dayMetrics = dayData ? JSON.parse(dayData) as CostMetrics : null;

        // Check if we need to reset (hour or day boundary crossed)
        const currentHour = Math.floor(now / 3600000);
        const currentDay = Math.floor(now / 86400000);

        const needsHourReset = !hourMetrics || 
            Math.floor(hourMetrics.lastResetTime / 3600000) !== currentHour;
        
        const needsDayReset = !dayMetrics || 
            Math.floor(dayMetrics.lastResetTime / 86400000) !== currentDay;

        // Return fresh metrics if either hour or day needs reset
        if (needsHourReset || needsDayReset) {
            return this.createEmptyMetrics();
        }

        // Return existing metrics
        return {
            provider: this.provider,
            hourlySpend: hourMetrics.hourlySpend,
            dailySpend: dayMetrics.dailySpend,
            totalRequests: dayMetrics.totalRequests,
            averageCostPerRequest: dayMetrics.averageCostPerRequest,
            lastResetTime: now,
        };
    }

    /**
     * Save cost metrics to KV.
     */
    private async saveMetrics(metrics: CostMetrics): Promise<void> {
        const hourKey = this.getHourKey();
        const dayKey = this.getDayKey();

        await Promise.all([
            this.env.CACHE_KV.put(hourKey, JSON.stringify({
                ...metrics,
                dailySpend: 0, // Only store hourly spend in hour key
            }), {
                expirationTtl: 3600, // 1 hour
            }),
            this.env.CACHE_KV.put(dayKey, JSON.stringify(metrics), {
                expirationTtl: 86400, // 24 hours
            }),
        ]);
    }

    /**
     * Record cost attribution per repository.
     */
    private async recordRepoCost(repoFullName: string, cost: number): Promise<void> {
        const key = `cost:repo:${repoFullName}:${this.getDayKey()}`;
        const existing = await this.env.CACHE_KV.get(key);

        const repoCost = existing ? parseFloat(existing) : 0;
        const newCost = repoCost + cost;

        await this.env.CACHE_KV.put(key, newCost.toString(), {
            expirationTtl: 86400 * 7, // Keep for 7 days
        });
    }

    /**
     * Get cost breakdown by repository for current day.
     */
    async getRepoCostBreakdown(): Promise<Record<string, number>> {
        const prefix = `cost:repo:`;
        const dayKey = this.getDayKey();

        // Note: KV doesn't support prefix listing, so this would need to be
        // tracked separately in a Durable Object or D1 database for production.
        // This is a simplified version.

        return {};
    }

    /**
     * Send budget alert webhook (Slack, PagerDuty, etc.)
     */
    private async sendBudgetAlert(
        severity: 'warning' | 'critical',
        metrics: CostMetrics,
        utilization: number
    ): Promise<void> {
        // Example: Send to Slack webhook
        const webhookUrl = this.env.BUDGET_ALERT_WEBHOOK;
        if (!webhookUrl) return;

        const color = severity === 'critical' ? '#ff0000' : '#ffa500';
        const emoji = severity === 'critical' ? '🚨' : '⚠️';

        const message = {
            text: `${emoji} Cost Budget Alert: ${severity.toUpperCase()}`,
            attachments: [
                {
                    color,
                    fields: [
                        {
                            title: 'Provider',
                            value: this.provider,
                            short: true,
                        },
                        {
                            title: 'Utilization',
                            value: `${(utilization * 100).toFixed(1)}%`,
                            short: true,
                        },
                        {
                            title: 'Hourly Spend',
                            value: `$${metrics.hourlySpend.toFixed(2)} / $${this.budget.hourlyLimit.toFixed(2)}`,
                            short: true,
                        },
                        {
                            title: 'Daily Spend',
                            value: `$${metrics.dailySpend.toFixed(2)} / $${this.budget.dailyLimit.toFixed(2)}`,
                            short: true,
                        },
                        {
                            title: 'Avg Cost/Request',
                            value: `$${metrics.averageCostPerRequest.toFixed(4)}`,
                            short: true,
                        },
                        {
                            title: 'Total Requests',
                            value: metrics.totalRequests.toString(),
                            short: true,
                        },
                    ],
                    footer: 'Code Reviewer Cost Monitor',
                    ts: Math.floor(Date.now() / 1000),
                },
            ],
        };

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(message),
        });
    }

    private createEmptyMetrics(): CostMetrics {
        return {
            provider: this.provider,
            hourlySpend: 0,
            dailySpend: 0,
            totalRequests: 0,
            averageCostPerRequest: 0,
            lastResetTime: Date.now(),
        };
    }

    private getHourKey(): string {
        const hour = Math.floor(Date.now() / 3600000);
        return `cost:${this.provider}:hour:${hour}`;
    }

    private getDayKey(): string {
        const day = Math.floor(Date.now() / 86400000);
        return `cost:${this.provider}:day:${day}`;
    }
}

/**
 * Global cost circuit breakers per provider.
 */
export function createCostCircuitBreakers(env: Env): Record<string, CostCircuitBreaker> {
    // Default budgets (adjust based on your needs)
    const claudeBudget: CostBudget = {
        hourlyLimit: 50.0,  // $50/hour
        dailyLimit: 500.0,  // $500/day
        warningThreshold: 0.8,  // 80%
        criticalThreshold: 0.95, // 95%
    };

    const geminiBudget: CostBudget = {
        hourlyLimit: 20.0,  // $20/hour (cheaper model)
        dailyLimit: 200.0,  // $200/day
        warningThreshold: 0.8,
        criticalThreshold: 0.95,
    };

    return {
        claude: new CostCircuitBreaker('claude', claudeBudget, env),
        gemini: new CostCircuitBreaker('gemini', geminiBudget, env),
    };
}
