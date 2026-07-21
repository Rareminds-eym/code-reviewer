import { LLMProviderAdapter, type LLMProviderConfig, type LLMResponse, type ChunkReviewRequest, type SynthesisRequest, type ToolDef, type ToolCall, type ToolLoopStep, type ToolMessage } from '../adapter';
import { MODELS } from '../../../config/constants';
import { logger } from '../../logger';
import { handleLLMErrorResponse } from '../error-handler';
import type { TokenUsage } from '../../../types/usage';
import { DistributedRateLimiter } from '../distributed-rate-limiter';
import { CostCircuitBreaker } from '../../cost-circuit-breaker';
import {
    extractClaudeSearchMetadata,
    extractClaudeTextContent,
    type ClaudeContentBlock,
    CLAUDE_WEB_SEARCH_TOOL_VERSION,
    CLAUDE_WEB_SEARCH_MAX_USES,
    CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS,
    SEARCH_TOKEN_BUDGET_MULTIPLIER,
    CLAUDE_MAX_SEARCH_CONTINUATIONS,
} from '../../web-search';

/** Shape of Claude API response body. */
interface ClaudeAPIResponse {
    content: ClaudeContentBlock[];
    usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests?: number } };
    stop_reason?: string;
}

/** Parameters for the shared pause_turn handler. */
interface PauseTurnParams {
    data: ClaudeAPIResponse;
    userPrompt: string;
    systemPrompt: string;
    maxTokens: number;
    tools?: unknown[];
    signal?: AbortSignal;
    label: string;
}

/** Result from pause_turn handling. */
interface PauseTurnResult {
    allContentBlocks: ClaudeContentBlock[];
    totalInputTokens: number;
    totalOutputTokens: number;
    continuationsUsed: number;
}

/**
 * Anthropic Claude LLM Provider Adapter
 * Implements the adapter pattern for Anthropic's Claude API.
 * Integrated with rate limiter, cost breaker, and retry logic.
 */
export class ClaudeAdapter extends LLMProviderAdapter {
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly temperature: number;
    private readonly rateLimiter?: DistributedRateLimiter;
    private readonly costBreaker?: CostCircuitBreaker;
    private readonly webSearchEnabled: boolean;

    constructor(config: LLMProviderConfig) {
        super(config);
        this.model = config.model ?? MODELS.claude;
        this.maxTokens = config.maxTokens ?? 4096;
        this.temperature = config.temperature ?? 0.1;
        this.webSearchEnabled = config.webSearchEnabled ?? false;
        
        // Initialize rate limiter if binding available
        if ((config as any).env?.RATE_LIMITER) {
            this.rateLimiter = new DistributedRateLimiter(
                (config as any).env.RATE_LIMITER,
                {
                    provider: 'claude',
                    requestsPerMinute: 50, // Claude Tier 1: 50 RPM
                    inputTokensPerMinute: 40000, // Claude Tier 1: 40K TPM
                    outputTokensPerMinute: 8000, // Claude Tier 1: 8K TPM
                    adaptive: true,
                }
            );
        }
        
        // Initialize cost breaker if env available
        if ((config as any).env) {
            this.costBreaker = new CostCircuitBreaker('claude', {
                hourlyLimit: 50.0,  // $50/hour
                dailyLimit: 500.0,  // $500/day
                warningThreshold: 0.8,
                criticalThreshold: 0.95,
            }, (config as any).env);
        }
    }

    /**
     * Dynamically scale output token budget based on chunk content size.
     * Larger chunks may produce more findings needing more output room.
     * Claude Sonnet 4 supports up to 16,384 output tokens.
     */
    private getChunkMaxTokens(chunkContent: string): number {
        return Math.min(8192, 2048 + Math.floor(chunkContent.length / 50));
    }

    getProviderName(): string {
        return 'anthropic';
    }

    getModelName(): string {
        return this.model;
    }

    async reviewChunk(request: ChunkReviewRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Claude reviewChunk requires a composed systemPrompt — use composeChunkPrompt()');
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
                'claude',
                adjustedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        // Build tools array — conditionally include web_search server tool
        // allowed_domains focuses searches on official docs, security advisories, and registries
        const tools: unknown[] | undefined = this.webSearchEnabled
            ? [{
                type: CLAUDE_WEB_SEARCH_TOOL_VERSION,
                name: 'web_search',
                max_uses: CLAUDE_WEB_SEARCH_MAX_USES,
                allowed_domains: CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS,
                allowed_callers: ['direct'],
            }]
            : undefined;

        if (this.webSearchEnabled) {
            logger.debug('Claude web search enabled for chunk review', { chunkLabel });
        }

        console.log(`[claude-debug] reviewChunk: model='${this.model}' apiKeyPresent=${!!this.config.apiKey} len=${this.config.apiKey.length}`);
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: estimatedOutputTokens,
                temperature: this.temperature,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                ...(tools ? { tools } : {}),
            }),
            signal,
        });
        console.log(`[claude-debug] reviewChunk response: status=${response.status} ok=${response.ok}`);

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Claude');
        }

        let data = await response.json() as ClaudeAPIResponse;

        // Handle pause_turn continuations for web search (shared helper)
        const { allContentBlocks, totalInputTokens, totalOutputTokens, continuationsUsed } =
            await this.handlePauseTurn({
                data,
                userPrompt,
                systemPrompt: request.systemPrompt!,
                maxTokens: estimatedOutputTokens,
                tools,
                signal,
                label: chunkLabel ?? 'chunk',
            });

        // When web search is active, response contains multiple content blocks
        // (text, server_tool_use, web_search_tool_result). Extract text content.
        let content: string;
        if (this.webSearchEnabled) {
            content = extractClaudeTextContent(allContentBlocks);
        } else {
            content = allContentBlocks.find(c => c.type === 'text')?.text ?? '';
        }

        if (data.stop_reason === 'max_tokens') {
            logger.warn('Claude MAP chunk generation truncated by max_tokens', { chunkLabel });
        }

        const usage: TokenUsage = {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
        };

        // Release unused tokens to rate limiter
        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        // Record actual cost (covers initial + all continuations)
        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        // Extract web search metadata from ALL content blocks (including continuations)
        const webSearchMetadata = this.webSearchEnabled
            ? extractClaudeSearchMetadata(allContentBlocks)
            : undefined;

        if (webSearchMetadata && webSearchMetadata.searchRequestCount > 0) {
            logger.info('Claude used web search for chunk review', {
                chunkLabel,
                searchQueries: webSearchMetadata.searchQueries,
                sourcesCount: webSearchMetadata.sources.length,
                continuationsUsed,
            });
        }

        logger.debug('Claude chunk review completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            chunkLabel,
            webSearchUsed: data.usage.server_tool_use?.web_search_requests ?? 0,
            continuationsUsed,
        });

        return { content, usage, webSearchMetadata };
    }

    // ---------------------------------------------------------------------------
    // Shared pause_turn continuation handler (P0-2, P0-5)
    // ---------------------------------------------------------------------------

    /**
     * Handle Claude's pause_turn stop reason during web search.
     *
     * When Claude returns pause_turn, it needs more turns to complete its search.
     * This method sends the assistant's response back and asks it to continue,
     * up to CLAUDE_MAX_SEARCH_CONTINUATIONS times.
     *
     * Safety guarantees:
     * - Each continuation checks costBreaker before proceeding (P0-5)
     * - Tracks total subrequests consumed for budget accounting (P0-2)
     * - Breaks on HTTP errors without failing the entire review
     */
    private async handlePauseTurn(params: PauseTurnParams): Promise<PauseTurnResult> {
        const { data, userPrompt, systemPrompt, maxTokens, tools, signal, label } = params;

        const allContentBlocks = [...data.content];
        let totalInputTokens = data.usage.input_tokens;
        let totalOutputTokens = data.usage.output_tokens;
        let continuationsUsed = 0;

        if (!this.webSearchEnabled || data.stop_reason !== 'pause_turn') {
            return { allContentBlocks, totalInputTokens, totalOutputTokens, continuationsUsed };
        }

        let currentData = data;
        const conversationMessages: unknown[] = [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: data.content },
        ];

        while (currentData.stop_reason === 'pause_turn' && continuationsUsed < CLAUDE_MAX_SEARCH_CONTINUATIONS) {
            continuationsUsed++;

            // P0-5: Check cost breaker before each continuation to prevent cost overruns
            if (this.costBreaker) {
                const continuationEstimate = (this.costBreaker.constructor as any).estimateCost(
                    'claude',
                    totalInputTokens, // Growing with conversation history
                    maxTokens
                );
                const budgetCheck = await this.costBreaker.checkBudget(continuationEstimate);
                if (!budgetCheck.allowed) {
                    logger.warn('Cost budget exceeded during pause_turn continuation, stopping', {
                        label,
                        continuation: continuationsUsed,
                        reason: budgetCheck.reason,
                    });
                    break;
                }
            }

            logger.debug('Claude pause_turn detected, continuing search', {
                label,
                continuation: continuationsUsed,
                maxContinuations: CLAUDE_MAX_SEARCH_CONTINUATIONS,
            });

            // Add a user turn to prompt continuation
            conversationMessages.push({ role: 'user', content: 'Continue your analysis.' });

            const contResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': this.config.apiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: maxTokens,
                    temperature: this.temperature,
                    system: systemPrompt,
                    messages: conversationMessages,
                    ...(tools ? { tools } : {}),
                }),
                signal,
            });

            if (!contResponse.ok) {
                logger.warn('Claude pause_turn continuation HTTP error, stopping', {
                    label,
                    status: contResponse.status,
                    continuation: continuationsUsed,
                });
                break; // Don't fail the whole review on continuation errors
            }

            currentData = await contResponse.json() as ClaudeAPIResponse;
            allContentBlocks.push(...currentData.content);
            totalInputTokens += currentData.usage.input_tokens;
            totalOutputTokens += currentData.usage.output_tokens;

            // Add the assistant's response for the next turn
            conversationMessages.push({ role: 'assistant', content: currentData.content });
        }

        if (continuationsUsed > 0) {
            logger.info('Claude pause_turn continuations completed', {
                label,
                continuationsUsed,
                finalStopReason: currentData.stop_reason,
                totalContentBlocks: allContentBlocks.length,
            });
        }

        return { allContentBlocks, totalInputTokens, totalOutputTokens, continuationsUsed };
    }

    // ---------------------------------------------------------------------------
    // Phase 2: Synthesis
    // ---------------------------------------------------------------------------

    async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<LLMResponse> {
        if (!request.systemPrompt) {
            throw new Error('Claude synthesize requires a composed systemPrompt — use composeSynthesizerPrompt()');
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
                'claude',
                adjustedInputTokens,
                estimatedOutputTokens
            );

            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        // Build tools array — conditionally include web_search server tool
        const synthTools: unknown[] | undefined = this.webSearchEnabled
            ? [{
                type: CLAUDE_WEB_SEARCH_TOOL_VERSION,
                name: 'web_search',
                max_uses: CLAUDE_WEB_SEARCH_MAX_USES,
                allowed_domains: CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS,
                allowed_callers: ['direct'],
            }]
            : undefined;

        if (this.webSearchEnabled) {
            logger.debug('Claude web search enabled for synthesis');
        }

        console.log(`[claude-debug] synthesize: model='${this.model}' apiKeyPresent=${!!this.config.apiKey} len=${this.config.apiKey.length}`);
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: outputBudget,
                temperature: this.temperature,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                ...(synthTools ? { tools: synthTools } : {}),
            }),
            signal,
        });
        console.log(`[claude-debug] synthesize response: status=${response.status} ok=${response.ok}`);

        if (!response.ok) {
            // Report error to rate limiter for adaptive adjustment
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Claude');
        }

        let data = await response.json() as ClaudeAPIResponse;

        // P1-4: Handle pause_turn for synthesis (same as reviewChunk)
        const { allContentBlocks, totalInputTokens, totalOutputTokens, continuationsUsed } =
            await this.handlePauseTurn({
                data,
                userPrompt,
                systemPrompt: request.systemPrompt!,
                maxTokens: outputBudget,
                tools: synthTools,
                signal,
                label: 'synthesis',
            });

        // When web search is active, response contains multiple content blocks.
        let content: string;
        if (this.webSearchEnabled) {
            content = extractClaudeTextContent(allContentBlocks);
        } else {
            content = allContentBlocks.find(c => c.type === 'text')?.text ?? '';
        }

        if (data.stop_reason === 'max_tokens') {
            const openFences = (content.match(/```/g) || []).length;
            const needsClose = openFences % 2 !== 0;
            content += (needsClose ? '\n```\n' : '\n') + '\n---\n\n> ⚠️ **AI Generation Truncated** — The model reached its maximum output token limit (`max_tokens`). The remainder of the review has been abruptly cut off. Consider reviewing the raw findings data or breaking the PR into smaller chunks.';
        }

        const usage: TokenUsage = {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
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
                'claude',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        // Extract web search metadata from ALL content blocks (including continuations)
        const synthWebSearchMetadata = this.webSearchEnabled
            ? extractClaudeSearchMetadata(allContentBlocks)
            : undefined;

        if (synthWebSearchMetadata && synthWebSearchMetadata.searchRequestCount > 0) {
            logger.info('Claude used web search for synthesis', {
                searchQueries: synthWebSearchMetadata.searchQueries,
                sourcesCount: synthWebSearchMetadata.sources.length,
                continuationsUsed,
            });
        }

        logger.debug('Claude synthesis completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            webSearchUsed: data.usage.server_tool_use?.web_search_requests ?? 0,
            continuationsUsed,
        });

        return { content, usage, webSearchMetadata: synthWebSearchMetadata };
    }

    // ---------------------------------------------------------------------------
    // Tool-calling capability (R8) — powers the Agentic Verifier loop
    // ---------------------------------------------------------------------------

    /** Claude supports native tool use (R8.2). */
    override supportsToolCalling(): boolean {
        return true;
    }

    /**
     * Run one step of a tool-calling loop against the Anthropic Messages API
     * (R8.1). Returns any `tool_use` requests as `toolCalls`, any assistant text
     * as `finalText`, and always surfaces per-completion token usage (R8.3).
     */
    override async runToolStep(
        messages: ToolMessage[],
        tools: ToolDef[],
        signal?: AbortSignal
    ): Promise<ToolLoopStep> {
        // Separate system policy from the conversation turns.
        const systemText = messages
            .filter(m => m.role === 'system')
            .map(m => m.content ?? '')
            .filter(Boolean)
            .join('\n\n');
        const anthropicMessages = messages
            .filter(m => m.role !== 'system')
            .map(toClaudeMessage);

        const anthropicTools = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
        }));

        const maxTokens = this.maxTokens;

        // Estimate tokens for rate limiter and cost breaker.
        const estimatedInputTokens = Math.ceil(
            (systemText.length + JSON.stringify(anthropicMessages).length + JSON.stringify(anthropicTools).length) / 4
        );
        const estimatedOutputTokens = maxTokens;

        if (this.rateLimiter) {
            const rateLimitResult = await this.rateLimiter.acquire({
                estimatedInputTokens,
                estimatedOutputTokens,
                timeoutMs: 30000,
            });
            if (!rateLimitResult.allowed) {
                throw new Error(`Rate limit exceeded: retry after ${rateLimitResult.retryAfterMs}ms`);
            }
        }

        if (this.costBreaker) {
            const estimatedCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                estimatedInputTokens,
                estimatedOutputTokens
            );
            const budgetCheck = await this.costBreaker.checkBudget(estimatedCost);
            if (!budgetCheck.allowed) {
                throw new Error(`Cost budget exceeded: ${budgetCheck.reason}`);
            }
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': this.config.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                max_tokens: maxTokens,
                temperature: this.temperature,
                ...(systemText ? { system: systemText } : {}),
                messages: anthropicMessages,
                ...(anthropicTools.length ? { tools: anthropicTools } : {}),
            }),
            signal,
        });

        if (!response.ok) {
            if (this.rateLimiter && (response.status === 429 || response.status === 529)) {
                await this.rateLimiter.reportError(response.status);
            }
            await handleLLMErrorResponse(response, 'Claude');
        }

        const data = await response.json() as ClaudeAPIResponse;

        const toolCalls: ToolCall[] = data.content
            .filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id ?? '', name: b.name ?? '', arguments: b.input }));

        const finalText = data.content
            .filter(b => b.type === 'text')
            .map(b => b.text ?? '')
            .join('\n')
            .trim();

        const usage: TokenUsage = {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        };

        if (this.rateLimiter) {
            await this.rateLimiter.release({
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
        }

        if (this.costBreaker) {
            const actualCost = (this.costBreaker.constructor as any).estimateCost(
                'claude',
                usage.inputTokens,
                usage.outputTokens
            );
            await this.costBreaker.recordCost(actualCost);
        }

        logger.debug('Claude tool step completed', {
            model: this.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCalls: toolCalls.length,
            stopReason: data.stop_reason,
        });

        return {
            toolCalls: toolCalls.length ? toolCalls : undefined,
            finalText: finalText.length ? finalText : undefined,
            usage,
        };
    }
}

/**
 * Translate a provider-neutral `ToolMessage` into an Anthropic message.
 * Tool results are sent as a `user` message containing `tool_result` blocks;
 * assistant tool requests are sent as `tool_use` blocks.
 */
function toClaudeMessage(m: ToolMessage): { role: 'user' | 'assistant'; content: unknown } {
    if (m.role === 'tool') {
        return {
            role: 'user',
            content: (m.toolResults ?? []).map(r => ({
                type: 'tool_result',
                tool_use_id: r.toolCallId,
                content: r.content,
                ...(r.isError ? { is_error: true } : {}),
            })),
        };
    }
    if (m.role === 'assistant') {
        if (m.toolCalls && m.toolCalls.length) {
            const blocks: unknown[] = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls) {
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
            }
            return { role: 'assistant', content: blocks };
        }
        return { role: 'assistant', content: m.content ?? '' };
    }
    // 'user' (system is handled separately by the caller)
    return { role: 'user', content: m.content ?? '' };
}

// Register the adapter
import { LLMProviderFactory } from '../adapter';
LLMProviderFactory.registerProvider('claude', ClaudeAdapter);
