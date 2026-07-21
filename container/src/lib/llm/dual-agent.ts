import type { AIProvider, Env } from '../../types/env';
import type { ReviewFinding } from '../../types/review';
import type { TokenUsage } from '../../types/usage';
import type { WebSearchMetadata } from '../web-search';
import { DUAL_AGENT_MODELS } from '../../config/constants';
import { buildStage1SystemPrompt, buildStage2SystemPrompt } from '../../config/prompts/dual-agent.js';
import { LLMProviderFactory, type LLMProviderConfig } from './adapter.js';
import { parseFindings } from './parse-findings.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The Stage-1 personas that can raise a finding. */
export type Stage1Persona = 'architect' | 'sre' | 'security';

/**
 * A Stage-1 finding carrying optional per-finding persona attribution (R9.5 —
 * metadata only). `personas` is the set of personas that produced this finding;
 * after dedup it is the UNION across the personas that raised the same
 * file/title/line. Structurally a `ReviewFinding` with one extra optional field,
 * so it remains assignable to `ReviewFinding[]` everywhere the plain shape is
 * expected (non-breaking).
 */
export interface PersonaTaggedFinding extends ReviewFinding {
    personas?: Stage1Persona[];
}

export interface Stage1Result {
    findings: PersonaTaggedFinding[];
    usage: TokenUsage;
    webSearchMetadata?: WebSearchMetadata;
    personaResults: Array<{
        persona: Stage1Persona;
        findingsCount: number;
        usage: TokenUsage;
    }>;
}

export interface VerifiedFinding extends ReviewFinding {
    /** Set to true if this finding passed Stage 2 verification */
    verified?: boolean;
    /** If rejected, the reason for rejection */
    rejectionReason?: string;
}

export interface Stage2Result {
    verifiedFindings: VerifiedFinding[];
    rejectedFindings: Array<{
        title: string;
        file: string;
        reason: string;
    }>;
    stats: {
        totalEvaluated: number;
        verified: number;
        rejected: number;
    };
    usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(provider: AIProvider, env: Env): string {
    return provider === 'gemini' ? env.GEMINI_API_KEY! : env.ANTHROPIC_API_KEY!;
}

function getStageModel(stage: 'stage1' | 'stage2', provider: AIProvider): string {
    return DUAL_AGENT_MODELS[stage][provider as keyof typeof DUAL_AGENT_MODELS.stage1] || DUAL_AGENT_MODELS.stage1.claude;
}

// ---------------------------------------------------------------------------
// Concurrency limiter for LLM calls
// ---------------------------------------------------------------------------

async function processWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<(R | Error)[]> {
    const results: (R | Error)[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < items.length) {
            const idx = nextIndex++;
            try {
                results[idx] = await fn(items[idx], idx);
            } catch (err) {
                results[idx] = err instanceof Error ? err : new Error(String(err));
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

async function withTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    label: string,
    parentSignal?: AbortSignal
): Promise<T> {
    if (parentSignal?.aborted) {
        throw new Error(`${label} aborted before starting`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let onAbort: (() => void) | undefined;
    if (parentSignal) {
        onAbort = () => controller.abort();
        parentSignal.addEventListener('abort', onAbort);
    }

    try {
        return await Promise.race([
            fn(controller.signal),
            new Promise<never>((_, reject) => {
                controller.signal.addEventListener('abort', () =>
                    reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
                );
                if (parentSignal) {
                    parentSignal.addEventListener('abort', () =>
                        reject(new Error(`${label} aborted`))
                    );
                }
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (parentSignal && onAbort) parentSignal.removeEventListener('abort', onAbort);
    }
}

// ---------------------------------------------------------------------------
// Stage 1: Primary Review with Persona Sub-Agents
// ---------------------------------------------------------------------------

const STAGE1_TIMEOUT_MS = 300_000; // 5 min per chunk
const STAGE1_CONCURRENCY = 3; // Max 3 concurrent persona calls
const MAX_STAGE1_TOKENS = 100_000; // Hard budget gate — abort if exceeded (Architecture §5)

const PERSONAS: Array<'architect' | 'sre' | 'security'> = ['architect', 'sre', 'security'];

/**
 * Stage 1: Runs Claude Sonnet with specialized persona sub-agents
 * (Architect, SRE, Security) against each code chunk.
 *
 * Personas run sequentially per chunk but chunks can overlap.
 * Returns deduplicated findings across all personas.
 */
export async function runStage1Review(
    chunks: string[],
    chunkFileMap: Record<number, string[]>,
    changedFiles: string[],
    prTitle: string,
    env: Env,
    signal?: AbortSignal,
    customRules?: string,
    staticFindingsContext?: string,
    graphifyContext?: string
): Promise<Stage1Result> {
    const provider: AIProvider = (env.AI_PROVIDER ?? 'claude') as AIProvider;
    const modelName = getStageModel('stage1', provider);
    const apiKey = getApiKey(provider, env);

    const config: LLMProviderConfig = {
        apiKey,
        model: modelName,
        maxTokens: 4096,
        temperature: 0.1,
        webSearchEnabled: false,
    };

    const adapter = LLMProviderFactory.createProvider(provider, config);
    if (!adapter.isAvailable()) {
        logger.warn(`Stage 1: Provider ${provider} not available (no API key)`);
        return { findings: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, personaResults: [] };
    }

    const allFindings: PersonaTaggedFinding[] = [];
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const personaResults: Stage1Result['personaResults'] = [];

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        if (signal?.aborted) throw new Error('Stage 1 aborted');

        // Hard token budget gate (Architecture §5)
        if (totalUsage.totalTokens >= MAX_STAGE1_TOKENS) {
            logger.warn(`Stage 1: Token budget exhausted (${totalUsage.totalTokens}/${MAX_STAGE1_TOKENS}). Skipping remaining chunks.`);
            break;
        }

        const chunkContent = chunks[chunkIdx];
        const chunkFiles = chunkFileMap[chunkIdx] || [];
        const chunkLabel = `${chunkIdx + 1}/${chunks.length}`;

        logger.info(`Stage 1: Reviewing chunk ${chunkLabel} with ${PERSONAS.length} personas`);

        // Run all 3 personas in parallel on this chunk
        const personaFindings = await processWithConcurrency(
            PERSONAS,
            STAGE1_CONCURRENCY,
            async (persona: 'architect' | 'sre' | 'security') => {
                if (signal?.aborted) throw new Error('Stage 1 aborted');

                const systemPrompt = buildStage1SystemPrompt(
                    persona,
                    customRules,
                    staticFindingsContext,
                    graphifyContext
                );

                const userMessage = `## PR Title: ${prTitle}\n\n## Files in this chunk\n${chunkFiles.map(f => `- ${f}`).join('\n')}\n\n## Code to Review\n\n\`\`\`\n${chunkContent.slice(0, 80000)}\n\`\`\``;

                try {
                    const result = await withTimeout(
                        (sig) => adapter.reviewChunk(
                            { chunkContent: userMessage, prTitle, chunkLabel: `${persona}/${chunkLabel}`, systemPrompt },
                            sig
                        ),
                        STAGE1_TIMEOUT_MS,
                        `Stage1: ${persona}/${chunkLabel}`,
                        signal
                    );

                    const findings = parseFindings(result.content, changedFiles);

                    totalUsage.inputTokens += result.usage.inputTokens;
                    totalUsage.outputTokens += result.usage.outputTokens;
                    totalUsage.totalTokens += result.usage.totalTokens;

                    return { findings, usage: result.usage, persona };
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    logger.warn(`Stage 1: ${persona}/${chunkLabel} failed: ${errMsg}`);
                    return { findings: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, persona };
                }
            }
        );

        // Collect findings from all personas for this chunk, tagging each finding
        // with the persona that produced it (R9.5 — provenance metadata only).
        for (const result of personaFindings) {
            if (result instanceof Error) continue;
            for (const f of result.findings) {
                allFindings.push({ ...f, personas: [result.persona] });
            }
            personaResults.push({
                persona: result.persona,
                findingsCount: result.findings.length,
                usage: result.usage,
            });
        }
    }

    // Deduplicate Stage 1 findings. Dedup keys, survivors, and ordering are
    // IDENTICAL to before (first occurrence wins); we ADDITIONALLY union the
    // persona attribution across merged duplicates so multi-persona agreement is
    // preserved for the downstream Consensus_Router (R9.5 — metadata only).
    const seen = new Map<string, PersonaTaggedFinding>();
    const deduplicated: PersonaTaggedFinding[] = [];
    for (const f of allFindings) {
        const key = `${f.file}::${f.title.toLowerCase().trim()}::${f.line || ''}`;
        const existing = seen.get(key);
        if (!existing) {
            const copy: PersonaTaggedFinding = { ...f, personas: [...(f.personas ?? [])] };
            seen.set(key, copy);
            deduplicated.push(copy);
        } else {
            // Union persona attribution into the retained finding (no count/order change).
            for (const p of f.personas ?? []) {
                if (!existing.personas!.includes(p)) existing.personas!.push(p);
            }
        }
    }

    logger.info(`Stage 1 complete: ${allFindings.length} raw findings, ${deduplicated.length} after dedup`);

    return {
        findings: deduplicated,
        usage: totalUsage,
        personaResults,
    };
}

// ---------------------------------------------------------------------------
// Stage 2: Verification with Flash
// ---------------------------------------------------------------------------

const STAGE2_TIMEOUT_MS = 120_000; // 2 min

/**
 * Stage 2: Runs Gemini Flash to verify Stage 1 findings.
 * Validates context and checks policies against findings.
 */
export async function runStage2Verification(
    findings: ReviewFinding[],
    codeContext: string,
    env: Env,
    signal?: AbortSignal
): Promise<Stage2Result> {
    const provider: AIProvider = 'gemini';
    const modelName = getStageModel('stage2', provider);
    const apiKey = getApiKey(provider, env);

    if (!apiKey) {
        logger.warn('Stage 2: Gemini API key not available, using findings as-is');
        return {
            verifiedFindings: findings.map(f => ({ ...f, verified: true })),
            rejectedFindings: [],
            stats: { totalEvaluated: findings.length, verified: findings.length, rejected: 0 },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
    }

    if (findings.length === 0) {
        return {
            verifiedFindings: [],
            rejectedFindings: [],
            stats: { totalEvaluated: 0, verified: 0, rejected: 0 },
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
    }

    const config: LLMProviderConfig = {
        apiKey,
        model: modelName,
        maxTokens: 4096,
        temperature: 0.1,
    };

    const adapter = LLMProviderFactory.createProvider(provider, config);

    const systemPrompt = buildStage2SystemPrompt(codeContext);

    // If too many findings, batch them
    const BATCH_SIZE = 20;
    let allVerified: VerifiedFinding[] = [];
    let allRejected: Stage2Result['rejectedFindings'] = [];
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for (let i = 0; i < findings.length; i += BATCH_SIZE) {
        if (signal?.aborted) throw new Error('Stage 2 aborted');

        const batch = findings.slice(i, i + BATCH_SIZE);
        const findingsJson = JSON.stringify({ findings: batch }, null, 2);

        try {
            const result = await withTimeout(
                async (sig) => {
                    const response = await adapter.synthesize(
                        {
                            payload: findingsJson,
                            systemPrompt,
                            maxTokens: 4096,
                        },
                        sig
                    );
                    return response;
                },
                STAGE2_TIMEOUT_MS,
                `Stage2 batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(findings.length / BATCH_SIZE)}`,
                signal
            );

            totalUsage.inputTokens += result.usage.inputTokens;
            totalUsage.outputTokens += result.usage.outputTokens;
            totalUsage.totalTokens += result.usage.totalTokens;

            // Parse the verification result
            const parsed = parseVerificationResult(result.content);
            allVerified.push(...parsed.verifiedFindings);
            allRejected.push(...parsed.rejectedFindings);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.warn(`Stage 2 batch failed, accepting findings as-is: ${errMsg}`);
            // Fallback: accept findings without verification
            allVerified.push(...batch.map(f => ({ ...f, verified: true })));
        }
    }

    return {
        verifiedFindings: allVerified,
        rejectedFindings: allRejected,
        stats: {
            totalEvaluated: findings.length,
            verified: allVerified.length,
            rejected: allRejected.length,
        },
        usage: totalUsage,
    };
}

/**
 * Parse the Stage 2 verification JSON output.
 */
function parseVerificationResult(raw: string): {
    verifiedFindings: VerifiedFinding[];
    rejectedFindings: Array<{ title: string; file: string; reason: string }>;
} {
    // Strip code fences
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    // Find JSON
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
        return { verifiedFindings: [], rejectedFindings: [] };
    }
    text = text.slice(firstBrace, lastBrace + 1);

    try {
        const parsed = JSON.parse(text);
        return {
            verifiedFindings: (parsed.verifiedFindings || []).map((f: any) => ({
                ...f,
                verified: true,
            })),
            rejectedFindings: parsed.rejectedFindings || [],
        };
    } catch {
        logger.error('Failed to parse Stage 2 verification result', undefined, { raw: raw.slice(0, 200) });
        return { verifiedFindings: [], rejectedFindings: [] };
    }
}
