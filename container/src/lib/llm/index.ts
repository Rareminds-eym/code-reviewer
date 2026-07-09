import type { AIProvider, Env } from '../../types/env';
import type { ReviewFinding } from '../../types/review';
import type { TokenUsage } from '../../types/usage';
import { DEFAULT_AI_PROVIDER, MODELS } from '../../config/constants';
import { parseFindings } from './parse-findings';
import { retryWithBackoff, circuitBreakers } from '../retry';
import { RateLimitError } from '../errors';
import { logger } from '../logger';
import { type WebSearchMetadata } from '../web-search';

// Import adapters (registers them with the factory)
import './adapters/claude';
import './adapters/gemini';
import { LLMProviderFactory, type LLMProviderConfig } from './adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the Map-phase circuit breaker for a provider. */
function getMapBreaker(provider: AIProvider) {
    return provider === 'gemini' ? circuitBreakers.geminiMap : circuitBreakers.anthropicMap;
}

/** Get the Synthesis-phase circuit breaker for a provider. */
function getSynthBreaker(provider: AIProvider) {
    return provider === 'gemini' ? circuitBreakers.geminiSynth : circuitBreakers.anthropicSynth;
}

/** Get the alternate provider for fallback. */
function getAlternateProvider(provider: AIProvider): AIProvider {
    return provider === 'claude' ? 'gemini' : 'claude';
}

/** Get the API key for a given provider from env. */
function getApiKey(provider: AIProvider, env: Env): string {
    return provider === 'gemini' ? env.GEMINI_API_KEY! : env.ANTHROPIC_API_KEY!;
}

/** Check if the alternate provider has a configured API key. */
function isAlternateAvailable(provider: AIProvider, env: Env): boolean {
    const alt = getAlternateProvider(provider);
    const key = getApiKey(alt, env);
    return !!key && key.length > 0;
}

// ---------------------------------------------------------------------------
// Phase 1: Chunk Review (Map) — returns structured findings
// ---------------------------------------------------------------------------

export interface ChunkReviewResult {
    findings: ReviewFinding[];
    usage: TokenUsage;
    /** Web search metadata when grounding was active. */
    webSearchMetadata?: WebSearchMetadata;
}

/**
 * Dispatches a code chunk to the configured LLM for inspection.
 * Returns parsed, validated ReviewFinding[] (never raw text) and usage data.
 *
 * This is the Map phase of our Map-Reduce pipeline.
 * Uses the Map-specific circuit breaker per provider.
 */
export async function callChunkReview(
    chunkContent: string,
    prTitle: string,
    chunkLabel: string,
    env: Env,
    signal?: AbortSignal,
    systemPrompt?: string,
    changedFiles?: string[],
    webSearchEnabled?: boolean
): Promise<ChunkReviewResult> {
    const provider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;
    console.log(`[llm-debug] callChunkReview: provider='${provider}' apiKeyPresent=${!!getApiKey(provider, env)} model=${MODELS[provider] || 'unknown'}`);

    // Check MAP circuit breaker
    const breaker = getMapBreaker(provider);
    console.log(`[llm-debug] callChunkReview: breaker ${provider} map=${breaker.canExecute() ? 'CLOSED' : 'OPEN'}`);
    if (!breaker.canExecute()) {
        throw new Error(`LLM circuit breaker for ${provider} (map) is OPEN - too many failures`);
    }

    const config: LLMProviderConfig = {
        apiKey: getApiKey(provider, env),
        webSearchEnabled: webSearchEnabled ?? false,
    };
    const adapter = LLMProviderFactory.createProvider(provider, config);
    console.log(`[llm-debug] callChunkReview: adapter=${adapter.constructor.name} model=${adapter.getModelName()}`);

    const executeReview = async (): Promise<ChunkReviewResult> => {
        const result = await adapter.reviewChunk(
            { chunkContent, prTitle, chunkLabel, systemPrompt },
            signal
        );
        const findings = parseFindings(result.content, changedFiles);
        return { findings, usage: result.usage, webSearchMetadata: result.webSearchMetadata };
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeReview,
            `LLM chunk review (${provider})`,
            {
                maxAttempts: 3,
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        breaker.recordSuccess();

        if (attempts > 1) {
            logger.info(`Chunk review succeeded after ${attempts} attempts`, {
                chunkLabel,
                attempts,
                totalDelayMs,
                provider,
            });
        }

        return result;
    } catch (error) {
        // Only count genuine failures towards the Circuit Breaker, not capacity limitations.
        if (!(error instanceof RateLimitError) && !String(error).includes('429')) {
            breaker.recordFailure();
        } else {
            logger.warn(`Rate limit exhausted, preserving circuit breaker state`, { provider, chunkLabel });
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis (Reduce) — returns final markdown
// ---------------------------------------------------------------------------

export interface SynthesisResult {
    review: string;
    usage: TokenUsage;
    /** Web search metadata when grounding was active. */
    webSearchMetadata?: WebSearchMetadata;
}

/**
 * Dispatches the aggregated findings to the configured LLM for synthesis.
 * Returns the final, cohesive markdown review and usage data.
 *
 * This is the Reduce phase of our Map-Reduce pipeline.
 * Implements tiered fallback: primary provider → alternate provider.
 * The pure-TypeScript fallback formatter is handled by the caller (queue.ts).
 */
export async function callSynthesizer(
    synthesizerPayload: string,
    env: Env,
    signal?: AbortSignal,
    systemPrompt?: string,
    maxTokens?: number,
    webSearchEnabled?: boolean
): Promise<SynthesisResult> {
    const primaryProvider: AIProvider = (env.AI_PROVIDER ?? DEFAULT_AI_PROVIDER) as AIProvider;
    console.log(`[llm-debug] callSynthesizer: primary='${primaryProvider}' apiKeyPresent=${!!getApiKey(primaryProvider, env)} altAvailable=${isAlternateAvailable(primaryProvider, env)}`);

    // Try primary provider first
    try {
        return await callSynthesizerWithProvider(
            primaryProvider, synthesizerPayload, env, signal, systemPrompt, maxTokens, webSearchEnabled
        );
    } catch (primaryError) {
        const errMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);
        console.log(`[llm-debug] callSynthesizer: primary failed: ${errMsg.slice(0, 200)}`);
        logger.warn(`Primary synthesizer (${primaryProvider}) failed, attempting fallback`, {
            error: errMsg,
        });

        // Try alternate provider if available
        if (isAlternateAvailable(primaryProvider, env)) {
            const altProvider = getAlternateProvider(primaryProvider);
            console.log(`[llm-debug] callSynthesizer: falling back to alt='${altProvider}'`);
            try {
                logger.info(`Falling back to alternate synthesizer: ${altProvider}`);
                return await callSynthesizerWithProvider(
                    altProvider, synthesizerPayload, env, signal, systemPrompt, maxTokens, webSearchEnabled
                );
            } catch (altError) {
                const altErrMsg = altError instanceof Error ? altError.message : String(altError);
                logger.error(`Alternate synthesizer (${altProvider}) also failed`, altError instanceof Error ? altError : undefined);
                throw new Error(
                    `Both synthesizer providers failed. Primary (${primaryProvider}): ${errMsg}. ` +
                    `Alternate (${altProvider}): ${altErrMsg}`
                );
            }
        }

        // No alternate available — re-throw primary error
        throw primaryError;
    }
}

/**
 * Call a specific provider for synthesis.
 * Checks the Synth-specific circuit breaker.
 */
async function callSynthesizerWithProvider(
    provider: AIProvider,
    synthesizerPayload: string,
    env: Env,
    signal?: AbortSignal,
    systemPrompt?: string,
    maxTokens?: number,
    webSearchEnabled?: boolean
): Promise<SynthesisResult> {
    const breaker = getSynthBreaker(provider);
    if (!breaker.canExecute()) {
        throw new Error(`LLM circuit breaker for ${provider} (synth) is OPEN - too many failures`);
    }

    const config: LLMProviderConfig = {
        apiKey: getApiKey(provider, env),
        webSearchEnabled: webSearchEnabled ?? false,
    };
    const adapter = LLMProviderFactory.createProvider(provider, config);

    const executeSynthesis = async (): Promise<SynthesisResult> => {
        const result = await adapter.synthesize(
            { payload: synthesizerPayload, systemPrompt, maxTokens },
            signal
        );
        return { review: result.content, usage: result.usage, webSearchMetadata: result.webSearchMetadata };
    };

    try {
        const { result, attempts, totalDelayMs } = await retryWithBackoff(
            executeSynthesis,
            `LLM synthesis (${provider})`,
            {
                maxAttempts: 2,  // Reduced from 3 — save subrequests for fallback
                initialDelayMs: 1000,
                backoffMultiplier: 2,
                jitter: true,
            }
        );

        breaker.recordSuccess();

        if (attempts > 1) {
            logger.info(`Synthesis succeeded after ${attempts} attempts`, {
                attempts,
                totalDelayMs,
                provider,
            });
        }

        return result;
    } catch (error) {
        breaker.recordFailure();
        throw error;
    }
}

/**
 * Get the model name for the current provider.
 * Uses the single source of truth in constants.ts.
 */
export function getModelName(provider: AIProvider): string {
    return MODELS[provider as keyof typeof MODELS];
}
