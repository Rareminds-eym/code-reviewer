import type { TokenUsage } from '../../types/usage';
import type { WebSearchMetadata } from '../web-search';

/**
 * LLM Provider Adapter Interface
 * Defines the contract that all LLM providers must implement.
 * This enables easy addition of new providers (OpenAI, Mistral, etc.)
 */

export interface LLMProviderConfig {
    apiKey: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    /** Enable web search grounding (Gemini: google_search, Claude: web_search). */
    webSearchEnabled?: boolean;
}

export interface LLMResponse {
    content: string;
    usage: TokenUsage;
    /** Web search metadata when grounding was active. */
    webSearchMetadata?: WebSearchMetadata;
}

export interface ChunkReviewRequest {
    chunkContent: string;
    prTitle: string;
    chunkLabel: string;
    systemPrompt?: string;
}

export interface SynthesisRequest {
    payload: string;
    systemPrompt?: string;
    /** Dynamic output budget — overrides the adapter default when set. */
    maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Tool-calling capability (R8) — used by the Agentic Verifier (R6/R7)
// ---------------------------------------------------------------------------

/**
 * Definition of a tool the model may call.
 * `inputSchema` is a JSON-Schema object describing the tool arguments.
 *
 * NOTE (Task 5 → Task 6/7): `ToolDef`, `ToolCall`, `ToolLoopStep`, and
 * `ToolMessage` are defined HERE (adapter layer) so the adapters can use them
 * without depending on the verifier-tools module. Task 6 (verification tools)
 * should import `ToolDef` from this file (`../adapter`) when declaring
 * `VERIFIER_TOOLS`, and Task 7 (agentic verifier) should import `ToolCall`,
 * `ToolLoopStep`, and `ToolMessage` from here.
 */
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: object;
}

/** A single tool invocation requested by the model. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: unknown;
}

/** Result of executing a tool, fed back to the model on the next step. */
export interface ToolResultInput {
    /** Correlates with the `ToolCall.id` that requested this tool. */
    toolCallId: string;
    /** The tool name — required by providers (e.g. Gemini) that key results by name. */
    toolName: string;
    /** Stringified tool output. Treated as UNTRUSTED DATA by the verifier (R6.12). */
    content: string;
    /** Marks the result as an error so the model can react (R6.10). */
    isError?: boolean;
}

/**
 * Provider-neutral conversation message for the tool-calling loop.
 * Each adapter translates these into its native wire format.
 *
 * - `system`: policy/instructions (mapped to Claude `system` / Gemini `systemInstruction`).
 * - `user`: user/task text.
 * - `assistant`: model text and/or the tool calls it previously requested.
 * - `tool`: results of executed tools (paired with a preceding assistant `toolCalls`).
 */
export interface ToolMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResultInput[];
}

/**
 * One step of a tool-calling loop. The model either requests tool calls
 * (`toolCalls`) or emits a final answer (`finalText`); `usage` is always
 * reported per completion for budget/cost enforcement (R8.3).
 */
export interface ToolLoopStep {
    toolCalls?: ToolCall[];
    finalText?: string;
    usage: TokenUsage;
}

/**
 * Abstract base class for LLM provider adapters.
 * All concrete providers must extend this class.
 */
export abstract class LLMProviderAdapter {
    protected config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = config;
    }

    /**
     * Perform a chunk review (Map phase).
     * Analyzes a code chunk and returns structured findings as JSON.
     */
    abstract reviewChunk(
        request: ChunkReviewRequest,
        signal?: AbortSignal
    ): Promise<LLMResponse>;

    /**
     * Perform synthesis (Reduce phase).
     * Combines findings into a cohesive markdown review.
     */
    abstract synthesize(
        request: SynthesisRequest,
        signal?: AbortSignal
    ): Promise<LLMResponse>;

    /**
     * Get the provider name for logging and metrics.
     */
    abstract getProviderName(): string;

    /**
     * Get the model name being used.
     */
    abstract getModelName(): string;

    /**
     * Check if the provider is available (API key configured).
     */
    isAvailable(): boolean {
        return !!this.config.apiKey && this.config.apiKey.length > 0;
    }

    /**
     * Whether this provider implements the tool-calling loop (R8.2).
     * Defaults to `false`; providers that support it override to return `true`.
     */
    supportsToolCalling(): boolean {
        return false;
    }

    /**
     * Run a single step of a tool-calling loop (R8.1): send the conversation so
     * far plus the available tool definitions, and receive either tool-call
     * requests or a final message, along with per-completion token usage (R8.3).
     *
     * Providers that do not support tool calling leave this default, which
     * reports the capability as unavailable by throwing. Callers MUST gate on
     * `supportsToolCalling()` first (the Agentic Verifier does).
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async runToolStep(
        messages: ToolMessage[],
        tools: ToolDef[],
        signal?: AbortSignal
    ): Promise<ToolLoopStep> {
        throw new Error(
            `${this.getProviderName()} does not support tool calling (runToolStep is unavailable)`
        );
    }
}

/**
 * Factory for creating LLM provider adapters.
 */
export class LLMProviderFactory {
    private static adapters = new Map<string, new (config: LLMProviderConfig) => LLMProviderAdapter>();

    /**
     * Register a new LLM provider adapter.
     */
    static registerProvider(
        name: string,
        adapterClass: new (config: LLMProviderConfig) => LLMProviderAdapter
    ): void {
        this.adapters.set(name.toLowerCase(), adapterClass);
    }

    /**
     * Create a provider adapter instance.
     */
    static createProvider(name: string, config: LLMProviderConfig): LLMProviderAdapter {
        const AdapterClass = this.adapters.get(name.toLowerCase());
        if (!AdapterClass) {
            throw new Error(`Unknown LLM provider: ${name}. Available: ${Array.from(this.adapters.keys()).join(', ')}`);
        }
        return new AdapterClass(config);
    }
}
