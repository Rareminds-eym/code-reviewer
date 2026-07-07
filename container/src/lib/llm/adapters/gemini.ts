import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest } from '../adapter';
import { MODELS } from '../../../config/constants';
import { logger } from '../../logger';
import { handleLLMErrorResponse } from '../error-handler';
import type { TokenUsage } from '../../../types/usage';
import { DistributedRateLimiter } from '../distributed-rate-limiter';
import { CostCircuitBreaker } from '../../cost-circuit-breaker';
import type { Env } from '../../../types/env';
import { extractGeminiGroundingMetadata, type GeminiGroundingMetadata, SEARCH_TOKEN_BUDGET_MULTIPLIER } from '../../web-search';

/**
 * Google Gemini LLM Provider Adapter
 * Implements the adapter pattern for Google's Gemini API.
 * Integrated with rate limiter, cost breaker, and retry logic.
 * 
 * Uses the `systemInstruction` field for proper system prompt handling
 * instead of faking it as a conversation turn.
 */
export class GeminiAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly rateLimiter?: DistributedRateLimiter;
    private readonly costBreaker?: CostCircuitBreaker;
    private readonly webSearchEnabled: boolean;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? MODELS.gemini;
        this.maxTokens = config.maxTokens ?? 4096;
        this.temperature = config.temperature ?? 0.1;
        this.webSearchEnabled = config.webSearchEnabled ?? false;
        
        // Initialize rate limiter if binding available
        if ((config as any).env?.RATE_LIMITER) {
            this.rateLimiter = new DistributedRateLimiter(
                (config as any).env.RATE_LIMITER,
                {
                    provider: 'gemini',
                    requestsPerMinute: 60, // Gemini: 60 RPM (2x Claude)
                    inputTokensPerMinute: 4000000, // Gemini: 4M TPM
                    outputTokensPerMinute: 32000, // Gemini: 32K TPM
                    adaptive: true,
                }
            );
        }
        
        // Initialize cost breaker if env available
        if ((config as any).env) {
            this.costBreaker = new CostCircuitBreaker('gemini', {
                hourlyLimit: 20.0,  // $20/hour (cheaper than Claude)
                dailyLimit: 200.0,  // $200/day
                warningThreshold: 0.8,
                criticalThreshold: 0.95,
            }, (config as any).env);
        }
    }

    /**
     * Dynamically scale output token budget based on chunk content size.
     * Larger chunks may produce more findings needing more output room.
     * Gemini 2.5 Flash supports up to 65,536 output tokens.
     */
    private getChunkMaxTokens(chunkContent: string): number {
        return Math.min(8192, 2048 + Math.floor(chunkContent.length / 50));
    }

    getProviderName(): string {
        return 'gemini';
    }

    getModelName(): string {
        return this.model;
    }

    async reviewChunk(request: ChunkReviewRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Gemini reviewChunk requires a composed systemPrompt — use composeChunkPrompt()');
        }
        const { chunkContent, prTitle, chunkLabel } = request;

        const userPrompt = `Pull Request Title: "${prTitle}"

Chunk ${chunkLabel}:
\`\`\`
${chunkContent}
\`\`\`

Analyze this code chunk for issues. Return findings as JSON array.`;

        // Estimate tokens for rate limiter and cost breaker
        const estimatedInputTokens = Math.ceil((request.systemPrompt.length + userPrompt.length) / 4);
        const estimatedOutputTokens = this.getChunkMaxTokens(chunkContent);

        // Check rate limiter if available
        if (this.rateLimiter) {
            const rateLimitResult = await this.rateLimiter.acquire({
                estimatedInputTokens,
                estimatedOutputTokens,
                timeoutMs: 30000,
            });

            if (!rateLimitResult.allowed) {
                throw new Error(`Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`);
            }

            logger.debug('Rate limit acquired', {
                waitTimeMs: rateLimitResult.waitTimeMs,
                utilization: (rateLimitResult.utilization * 100).toFixed(1) + '%',
            });
        }

        // Check cost budget if available
        // When web search is active, inflate estimates to account for search result tokens
        if (this.costBreaker) {
            const adjustedInputTokens = this.webSearchEnabled
                ? Math.ceil(estimatedInputTokens * SEARCH_TOKEN_BUDGET_MULTIPLIER)
                : estimatedInputTokens;
            const estimatedCost = (this.costBreaker.constructor as any).estimateCost(
                'gemini',
                adjustedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        // Build request body — conditionally add google_search grounding tool
        // IMPORTANT: When web search is enabled, we CANNOT use responseMimeType: 'application/json'
        // because the JSON constraint prevents the model from using the google_search tool.
        // Without it, the model produces JSON naturally and parseFindings handles extraction.
        const generationConfig: Record<string, unknown> = {
            maxOutputTokens: estimatedOutputTokens,
            temperature: this.temperature,
        };
        if (!this.webSearchEnabled) {
            generationConfig.responseMimeType = 'application/json';
        }

        const requestBody: Record<string, unknown> = {
            systemInstruction: {
                parts: [{ text: request.systemPrompt }],
            },
            contents: [
                { role: 'user', parts: [{ text: userPrompt }] },
            ],
            generationConfig,
        };

        if (this.webSearchEnabled) {
            requestBody.tools = [{ google_search: {} }];
            logger.debug('Gemini web search grounding enabled for chunk review (responseMimeType disabled for tool compatibility)', { chunkLabel });
        }

        // Use x-goog-api-key header instead of URL query param to avoid key in logs
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-goog-api-key': this.config.apiKey,
                },
                body: JSON.stringify(requestBody),
                signal,
            }
        );

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Gemini');
        }

        const data = await response.json() as {
            candidates: Array<{
                content: { parts: Array<{ text: string }> };
                finishReason?: string;
                groundingMetadata?: GeminiGroundingMetadata;
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        let content = data.candidates[0]?.content?.parts[0]?.text ?? '';

        if (data.candidates[0]?.finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini MAP chunk generation truncated by max_tokens', { chunkLabel });
        }

        const usage: TokenUsage = {
            inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0),
        };

        // Release unused tokens to rate limiter
        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        // Record actual cost
        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'gemini',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        // Extract web search grounding metadata if available
        const webSearchMetadata = this.webSearchEnabled
            ? extractGeminiGroundingMetadata(data.candidates[0]?.groundingMetadata)
            : undefined;

        if (webSearchMetadata && webSearchMetadata.searchRequestCount > 0) {
            logger.info('Gemini used web search grounding for chunk review', {
                chunkLabel,
                searchQueries: webSearchMetadata.searchQueries,
                sourcesCount: webSearchMetadata.sources.length,
            });
        }

        logger.debug('Gemini chunk review completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            chunkLabel,
            webSearchUsed: webSearchMetadata?.searchRequestCount ?? 0,
        });

        return { content, usage, webSearchMetadata };
    }

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Gemini synthesize requires a composed systemPrompt — use composeSynthesizerPrompt()');
        }
        const { payload } = request;
        const outputBudget = request.maxTokens ?? this.maxTokens;

        const userPrompt = `Synthesize these code review findings into a final markdown report following the EXACT format in your system instructions:

${payload}`;

        // Estimate tokens for rate limiter and cost breaker
        const estimatedInputTokens = Math.ceil((request.systemPrompt.length + userPrompt.length) / 4);
        const estimatedOutputTokens = outputBudget;

        // Check rate limiter if available
        if (this.rateLimiter) {
            const rateLimitResult = await this.rateLimiter.acquire({
                estimatedInputTokens,
                estimatedOutputTokens,
                timeoutMs: 30000,
            });

            if (!rateLimitResult.allowed) {
                throw new Error(`Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`);
            }

            logger.debug('Rate limit acquired for synthesis', {
                waitTimeMs: rateLimitResult.waitTimeMs,
                utilization: (rateLimitResult.utilization * 100).toFixed(1) + '%',
            });
        }

        // Check cost budget if available
        // P1-3: Apply search token budget multiplier when web search is active
        if (this.costBreaker) {
            const adjustedInputTokens = this.webSearchEnabled
                ? Math.ceil(estimatedInputTokens * SEARCH_TOKEN_BUDGET_MULTIPLIER)
                : estimatedInputTokens;
            const estimatedCost = (this.costBreaker.constructor as any).estimateCost(
                'gemini',
                adjustedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        // Build request body — conditionally add google_search grounding tool
        const synthRequestBody: Record<string, unknown> = {
            systemInstruction: {
                parts: [{ text: request.systemPrompt }],
            },
            contents: [
                { role: 'user', parts: [{ text: userPrompt }] },
            ],
            generationConfig: {
                maxOutputTokens: outputBudget,
                temperature: this.temperature,
            },
        };

        if (this.webSearchEnabled) {
            synthRequestBody.tools = [{ google_search: {} }];
            logger.debug('Gemini web search grounding enabled for synthesis');
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-goog-api-key': this.config.apiKey,
                },
                body: JSON.stringify(synthRequestBody),
                signal,
            }
        );

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Gemini');
        }

        const data = await response.json() as {
            candidates: Array<{
                content: { parts: Array<{ text: string }> };
                finishReason?: string;
                groundingMetadata?: GeminiGroundingMetadata;
            }>;
            usageMetadata: { promptTokenCount: number; candidatesTokenCount: number };
        };

        let content = data.candidates[0]?.content?.parts[0]?.text ?? '';

        if (data.candidates[0]?.finishReason === 'MAX_TOKENS') {
            const openFences = (content.match(/```/g) || []).length;
            const needsClose = openFences % 2 !== 0;
            content += (needsClose ? '\n```\n' : '\n') + '\n---\n\n> ⚠️ **AI Generation Truncated** — The model reached its maximum output token limit (`max_tokens`). The remainder of the review has been abruptly cut off. Consider reviewing the raw findings data or breaking the PR into smaller chunks.';
        }

        const usage: TokenUsage = {
            inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
            totalTokens: (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0),
        };

        // Release unused tokens to rate limiter
        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        // Record actual cost
        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'gemini',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        // Extract web search grounding metadata if available
        const synthWebSearchMetadata = this.webSearchEnabled
            ? extractGeminiGroundingMetadata(data.candidates[0]?.groundingMetadata)
            : undefined;

        if (synthWebSearchMetadata && synthWebSearchMetadata.searchRequestCount > 0) {
            logger.info('Gemini used web search grounding for synthesis', {
                searchQueries: synthWebSearchMetadata.searchQueries,
                sourcesCount: synthWebSearchMetadata.sources.length,
            });
        }

        logger.debug('Gemini synthesis completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            webSearchUsed: synthWebSearchMetadata?.searchRequestCount ?? 0,
        });

        return { content, usage, webSearchMetadata: synthWebSearchMetadata };
    }
}

// Register the adapter
import { LLMProviderFactory } from '../adapter';
LLMProviderFactory.registerProvider('gemini', GeminiAdapter);
