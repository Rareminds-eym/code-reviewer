import type { AIProvider } from '../types/env';

export const DEFAULT_AI_PROVIDER: AIProvider = 'claude';

export const MODELS = {
    claude: 'claude-haiku-4-5',
    gemini: 'gemini-2.5-flash',
} as const satisfies Record<AIProvider, string>;

/** Dual-agent pipeline: Stage 1 uses Sonnet for deep reasoning, Stage 2 uses Flash for verification. */
export const DUAL_AGENT_MODELS = {
    stage1: {
        claude: 'claude-sonnet-4-6',
        gemini: 'gemini-2.5-flash',
    },
    stage2: {
        claude: 'claude-haiku-4-5',
        gemini: 'gemini-2.0-flash',
    },
} as const;

/** Maximum characters per LLM chunk. Guards against massive PR context windows. */
export const MAX_CHUNK_CHARS = 100_000;

/**
 * Maximum number of findings a single chunk reviewer can report.
 * Prevents JSON explosion from overly verbose LLM responses.
 */
export const MAX_FINDINGS_PER_CHUNK = 50;

/**
 * Character budget for the global PR context prepended to every chunk.
 * Includes file list, PR metadata, and chunk position info.
 */
export const GLOBAL_CONTEXT_BUDGET_CHARS = 8_000;

/** Hard upper bound on the graphify knowledge-graph context injected into prompts. */
export const MAX_GRAPH_CONTEXT_CHARS = 6_000;

/** Wall-clock budget for graphify extraction/update (matches prior 120s timeout). */
export const GRAPHIFY_BUDGET_MS = 120_000;

/**
 * Tier 1: Maximum files that get FULL content fetched (patch + raw file).
 * Increased from 15 to 100 on Cloudflare Workers Paid Plan (1000 subrequests ceiling).
 */
export const TIER1_MAX_FILES = 100;

/**
 * Maximum total files we consider from the PR at all.
 * GitHub can return up to 3000, but reviewing all of them isn't practical.
 */
export const MAX_TOTAL_FILES = 300;

/** Only fetch full content for files below this byte size (200KB). */
export const MAX_FILE_SIZE_BYTES = 200_000;

// ---------------------------------------------------------------------------
// Noise File Filtering
// ---------------------------------------------------------------------------

/** File extensions that should be auto-skipped (no review value). */
export const NOISE_EXTENSIONS = new Set([
    'lock', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2',
    'ttf', 'eot', 'otf', 'mp4', 'mp3', 'wav', 'pdf', 'zip', 'tar', 'gz',
    'map', 'snap', 'min.js', 'min.css', 'chunk.js', 'chunk.css',
    'DS_Store', 'pyc', 'class', 'o', 'so', 'dll', 'exe',
]);

/** Exact filenames that should be auto-skipped. */
export const NOISE_FILENAMES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
    '.gitignore', '.gitattributes', '.editorconfig', '.prettierrc',
    '.eslintignore', '.npmrc', '.nvmrc', '.node-version',
    'LICENSE', 'LICENSE.md', 'LICENSE.txt',
    'CHANGELOG.md', 'CHANGELOG',
]);

/** Directory prefixes that indicate auto-generated or vendor code. */
export const NOISE_DIRECTORIES = [
    'node_modules/', 'vendor/', 'dist/', 'build/', '.next/',
    'coverage/', '__snapshots__/', '.turbo/', '.cache/',
    'public/assets/', 'static/assets/',
];

/**
 * File extensions that get priority scoring bonus (business logic files).
 * These are the files most likely to contain reviewable code.
 */
export const PRIORITY_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'kt',
    'rb', 'php', 'cs', 'swift', 'dart', 'vue', 'svelte',
]);

// ---------------------------------------------------------------------------
// Agentic Review Pipeline — Consensus Router (R5.7)
// ---------------------------------------------------------------------------
// All values below are tunable defaults; per-repo `.codereview.yml` may override
// (R11.2). Confidence is derived from source-agreement weights + verification
// status only — there is NO numeric hallucination-risk term (R4.6).

/**
 * Default source-authority weights for the Consensus_Router (R5.7).
 * Keyed by `AgentSource` (defined in `lib/llm/consensus.ts`). Ground-truth
 * sources (static-analysis, deterministic plugins, dependency-audit) carry a
 * weight of 1.00, though they bypass scoring entirely and are never rejected.
 */
export const CONSENSUS_SOURCE_WEIGHTS = {
    'static-analysis': 1.0,
    'secrets-plugin': 1.0,
    'suspicious-patterns': 1.0,
    'ts-strict-plugin': 1.0,
    'dependency-audit': 1.0,
    security: 0.9,
    architect: 0.8,
    sre: 0.7,
    'map-chunk': 0.5,
} as const;

/** Confidence at or above this routes an LLM finding to KEEP (R5.7). */
export const CONSENSUS_KEEP_THRESHOLD = 0.7;

/**
 * Confidence in [DOWNGRADE, KEEP) routes to DOWNGRADE (severity → low);
 * below this routes to SUPPRESS (R5.7).
 */
export const CONSENSUS_DOWNGRADE_THRESHOLD = 0.4;

/**
 * The uncertain VERIFY band around the KEEP boundary (R5.5, R5.7). Findings
 * whose confidence falls in this half-open range `[low, high)` become
 * Ambiguous_Findings and are routed to the Agentic_Verifier (or resolved by
 * Fallback_Decision).
 *
 * The lower bound is 0.50 so that the lowest-authority single-LLM-source
 * findings — `map-chunk` (weight 0.50) — are the "uncertain" ones forwarded to
 * the verifier when consensus + verifier are enabled. Personas score higher
 * (`sre` 0.70, `architect` 0.80, `security` 0.90) so they sit at or above the
 * KEEP threshold and are KEPT on their own authority. Without a 0.50 lower
 * bound the band would be empty for any single-source finding and the verifier
 * would never run on the MAP path. Note the verifier-OFF Fallback_Decision path
 * ignores this band entirely (it uses the KEEP/DOWNGRADE thresholds), so a
 * map-chunk 0.50 finding still DOWNGRADES when the verifier is disabled —
 * preserving disabled-equivalence.
 */
export const CONSENSUS_VERIFY_BAND: readonly [number, number] = [0.5, 0.7];

/** A Stage-verified or agentically-verified finding gets this confidence floor (R5.7). */
export const CONSENSUS_VERIFIED_FLOOR = 0.6;

// ---------------------------------------------------------------------------
// Agentic Review Pipeline — Per-Track Verifier Budgets (R7.6)
// ---------------------------------------------------------------------------
// Hard bounds for the Agentic_Verifier, scaled per Review_Track. `deep` permits
// the largest budgets; `fast` never runs the verifier but retains minimal
// bounds for safety. `wallClockFraction` is the fraction of the review's
// remaining time budget the stage may consume (R7.8), so verification never
// starves the REDUCE/post stage.

export interface VerifierBudgets {
    /** Max Verification_Tool calls per Ambiguous_Finding (R7.1). */
    toolBudgetPerFinding: number;
    /** Max agent-loop turns per Ambiguous_Finding (R7.1). */
    stepBudgetPerFinding: number;
    /** Max cumulative LLM tokens for the whole stage (R7.2). */
    stageTokenBudget: number;
    /** Fraction of remaining review time the stage may use (R7.8). */
    wallClockFraction: number;
    /** Max Ambiguous_Findings verified concurrently (R6.11). */
    maxConcurrentFindings: number;
}

/** Per-track verifier budgets with documented defaults (larger for `deep`, R7.6). */
export const VERIFIER_BUDGETS_BY_TRACK = {
    fast: {
        toolBudgetPerFinding: 2,
        stepBudgetPerFinding: 3,
        stageTokenBudget: 10_000,
        wallClockFraction: 0.2,
        maxConcurrentFindings: 2,
    },
    full: {
        toolBudgetPerFinding: 4,
        stepBudgetPerFinding: 6,
        stageTokenBudget: 40_000,
        wallClockFraction: 0.3,
        maxConcurrentFindings: 3,
    },
    deep: {
        toolBudgetPerFinding: 8,
        stepBudgetPerFinding: 10,
        stageTokenBudget: 100_000,
        wallClockFraction: 0.4,
        maxConcurrentFindings: 4,
    },
} as const satisfies Record<'fast' | 'full' | 'deep', VerifierBudgets>;

// ---------------------------------------------------------------------------
// Agentic Review Pipeline — Verification Tools (R6.2–R6.4, R9.3)
// ---------------------------------------------------------------------------
// Read-only, sandboxed tool layer for the Agentic_Verifier. `read_file` reads a
// bounded line range strictly inside the Workspace; graphify tools run the CLI's
// read-only subcommands against `<graphDir>/graph.json`. All args are passed as
// an argv array (never shell-interpolated) and no tool writes/execs a shell.

/** Default number of lines `read_file` returns when the caller omits a count. */
export const READ_FILE_DEFAULT_LINES = 80;

/** Hard cap on the number of lines a single `read_file` call may return (R6.3). */
export const READ_FILE_MAX_LINES = 400;

/** Hard cap on the byte size of any file `read_file` will open. */
export const READ_FILE_MAX_BYTES = 1_000_000;

/** Per-invocation timeout (ms) for a graphify read-only subprocess. */
export const VERIFIER_GRAPHIFY_TIMEOUT_MS = 8_000;

/** Token budget passed to `graphify query` so tool output stays bounded. */
export const VERIFIER_GRAPHIFY_QUERY_BUDGET = 1_500;

/** Reverse-traversal depth passed to `graphify affected`. */
export const VERIFIER_GRAPHIFY_AFFECTED_DEPTH = 2;
