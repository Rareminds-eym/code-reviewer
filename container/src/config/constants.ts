import type { AIProvider } from '../types/env';

export const DEFAULT_AI_PROVIDER: AIProvider = 'claude';

export const MODELS = {
    claude: 'claude-haiku-4-5',
    gemini: 'gemini-2.5-flash',
} as const satisfies Record<AIProvider, string>;

/** Maximum characters per LLM chunk. Guards against massive PR context windows. */
export const MAX_CHUNK_CHARS = 100_000;

/**
 * Hard limit on how many LLM chunks to process to prevent hitting 
 * the Cloudflare Worker subrequests limit. 
 * Workers Paid Plan: 10,000 default (configurable up to 10M via wrangler.jsonc).
 * Workers Free Plan: 50 external subrequests.
 * Note: with web search continuations, each chunk may consume up to 3 subrequests.
 */
export const MAX_LLM_CHUNKS = 50;

/**
 * Maximum number of findings a single chunk reviewer can report.
 * Prevents JSON explosion from overly verbose LLM responses.
 */
export const MAX_FINDINGS_PER_CHUNK = 50;

/**
 * Maximum characters for the synthesizer input payload.
 * 70K tokens ≈ 280K chars. Safe for Claude (200K ctx) and Gemini (1M ctx).
 * The synthesizer receives clustered JSON findings, not raw code.
 */
export const MAX_SYNTHESIZER_INPUT_CHARS = 280_000;

/**
 * Character budget for the global PR context prepended to every chunk.
 * Includes file list, PR metadata, and chunk position info.
 */
export const GLOBAL_CONTEXT_BUDGET_CHARS = 8_000;

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

/** PR actions that should trigger a review. */
export const REVIEWABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

/** Worker version — update in sync with package.json on releases. */
export const WORKER_VERSION = '1.0.0';

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
