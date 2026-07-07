/**
 * Repository Review Configuration — .codereview.yml Support
 *
 * Fetches and parses per-repo configuration from:
 *   1. .codereview.yml (repo root)
 *   2. .github/codereview.yml (GitHub convention directory)
 *
 * Config is cached in KV for 1 hour per repo to avoid redundant fetches.
 * If no config file exists, returns null — detection falls back to auto-detect.
 */

import type { TechStackProfile, DetectedFramework, DetectedStateLib, DetectedDataLib, DetectedStylingLib, DetectedArchPattern, DetectedFormLib, DetectedValidationLib, DetectedTestLib, DetectedLanguage } from '../types/stack';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Schema for .codereview.yml */
export interface RepoReviewConfig {
    /** Schema version. Currently only version 1 is supported. */
    version?: number;

    /** Explicit tech stack declaration — overrides auto-detection. */
    stack?: {
        language?: string;
        framework?: string;
        state?: string;
        styling?: string;
        architecture?: string;
        testing?: string;
        forms?: string;
        validation?: string;
        dataFetching?: string;
    };

    /** Severity overrides for specific finding categories or titles. */
    severity?: Record<string, string>;

    /** Additional custom review rules injected into the prompt. */
    rules?: Array<{
        name: string;
        description: string;
        severity?: string;
    }>;

    /** Glob patterns of files to exclude from review. */
    ignore?: string[];
}

// ---------------------------------------------------------------------------
// KV Cache
// ---------------------------------------------------------------------------

const CONFIG_CACHE_PREFIX = 'repo-config';
const CONFIG_CACHE_TTL = 3600; // 1 hour

function configCacheKey(repoFullName: string): string {
    return `${CONFIG_CACHE_PREFIX}:${repoFullName}`;
}

// ---------------------------------------------------------------------------
// YAML Parser (Minimal — no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Minimal YAML parser for .codereview.yml.
 *
 * Supports:
 *   - Key-value pairs: `key: value`
 *   - Nested objects via indentation
 *   - Array items (- prefix)
 *   - Comments (#)
 *   - Quoted strings
 *
 * Does NOT support:
 *   - Anchors/aliases
 *   - Multi-line strings (|, >)
 *   - Flow sequences/mappings
 *
 * For a Worker environment, this avoids the 100KB+ js-yaml dependency.
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
        { indent: -1, obj: result },
    ];
    let currentArray: unknown[] | null = null;
    let currentArrayKey = '';

    for (const rawLine of lines) {
        // Skip empty lines and comments
        const commentIdx = rawLine.indexOf('#');
        const line = commentIdx >= 0
            ? rawLine.substring(0, commentIdx)
            : rawLine;

        if (line.trim().length === 0) continue;

        const indent = line.search(/\S/);
        const trimmed = line.trim();

        // Array item
        if (trimmed.startsWith('- ')) {
            const itemContent = trimmed.substring(2).trim();

            // Check if it's a key-value in an array item
            const kvMatch = itemContent.match(/^(\w+):\s*(.*)/);
            if (kvMatch) {
                // This is a hash item in an array
                const obj: Record<string, unknown> = {};
                obj[kvMatch[1]] = parseYamlValue(kvMatch[2]);

                if (!currentArray) {
                    currentArray = [];
                    const parent = stack[stack.length - 1].obj;
                    parent[currentArrayKey] = currentArray;
                }
                currentArray.push(obj);

                // Push this object for nested key-values
                while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
                    stack.pop();
                }
                stack.push({ indent: indent + 2, obj });
            } else {
                // Simple array item
                if (!currentArray) {
                    currentArray = [];
                    const parent = stack[stack.length - 1].obj;
                    parent[currentArrayKey] = currentArray;
                }
                currentArray.push(parseYamlValue(itemContent));
            }
            continue;
        }

        // Key-value pair
        const match = trimmed.match(/^([\w.-]+):\s*(.*)/);
        if (!match) continue;

        const [, key, rawValue] = match;
        const value = rawValue.trim();

        // Pop stack to find the correct parent based on indentation
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        // Reset array tracking when we leave the array context
        currentArray = null;

        const parent = stack[stack.length - 1].obj;

        if (value === '' || value === undefined) {
            // This key has children (nested object or array)
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
            currentArrayKey = key;
        } else {
            parent[key] = parseYamlValue(value);
        }
    }

    return result;
}

function parseYamlValue(raw: string): string | number | boolean {
    const trimmed = raw.trim();

    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }

    // Boolean
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;

    // Number
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed.length > 0) return num;

    return trimmed;
}

// ---------------------------------------------------------------------------
// Config Fetching
// ---------------------------------------------------------------------------

/** Paths to check for the config file (in order of priority). */
const CONFIG_PATHS = ['.codereview.yml', '.github/codereview.yml'];

/**
 * Fetch and parse .codereview.yml from the repository.
 * Checks both repo root and .github/ directory.
 * Returns null if no config file exists.
 * Result is cached in KV for 1 hour.
 */
export async function fetchRepoConfig(
    repoFullName: string,
    token: string,
    kvNamespace?: any
): Promise<RepoReviewConfig | null> {
    // Check KV cache first
    if (kvNamespace) {
        try {
            const cached = await kvNamespace.get(configCacheKey(repoFullName));
            if (cached) {
                if (cached === '__NONE__') return null; // Negative cache
                return JSON.parse(cached) as RepoReviewConfig;
            }
        } catch {
            // Cache read failure — proceed to fetch
        }
    }

    // Try each config path
    for (const configPath of CONFIG_PATHS) {
        const url = `https://api.github.com/repos/${repoFullName}/contents/${configPath}`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github.raw+json',
                    'User-Agent': 'RaremindsCodeReviewer/1.0',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                signal: AbortSignal.timeout(5000),
            });

            if (response.status === 404) continue; // Try next path

            if (!response.ok) {
                logger.warn('Failed to fetch repo config', {
                    repoFullName, configPath, status: response.status,
                });
                continue;
            }

            const content = await response.text();
            const rawConfig = parseSimpleYaml(content);
            const config = validateConfig(rawConfig);

            logger.info('Loaded repo review config', {
                repoFullName,
                configPath,
                hasStack: !!config.stack,
                rulesCount: config.rules?.length ?? 0,
                ignoreCount: config.ignore?.length ?? 0,
            });

            // Cache the parsed config
            if (kvNamespace) {
                try {
                    await kvNamespace.put(
                        configCacheKey(repoFullName),
                        JSON.stringify(config),
                        { expirationTtl: CONFIG_CACHE_TTL }
                    );
                } catch { /* Non-fatal */ }
            }

            return config;
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                logger.warn('Config fetch timed out', { repoFullName, configPath });
            }
            continue;
        }
    }

    // No config found — cache negative result to avoid repeated 404s
    if (kvNamespace) {
        try {
            await kvNamespace.put(
                configCacheKey(repoFullName),
                '__NONE__',
                { expirationTtl: CONFIG_CACHE_TTL }
            );
        } catch { /* Non-fatal */ }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

function validateConfig(raw: Record<string, unknown>): RepoReviewConfig {
    const config: RepoReviewConfig = {};

    if (typeof raw['version'] === 'number') {
        config.version = raw['version'];
    }

    if (raw['stack'] && typeof raw['stack'] === 'object') {
        config.stack = {};
        const stack = raw['stack'] as Record<string, unknown>;
        const stringFields = ['language', 'framework', 'state', 'styling', 'architecture', 'testing', 'forms', 'validation', 'dataFetching'];
        for (const field of stringFields) {
            if (typeof stack[field] === 'string') {
                (config.stack as Record<string, string>)[field] = stack[field] as string;
            }
        }
    }

    if (raw['severity'] && typeof raw['severity'] === 'object') {
        config.severity = {};
        for (const [key, val] of Object.entries(raw['severity'] as Record<string, unknown>)) {
            if (typeof val === 'string') {
                config.severity[key] = val;
            }
        }
    }

    if (Array.isArray(raw['rules'])) {
        config.rules = [];
        for (const rule of raw['rules']) {
            if (rule && typeof rule === 'object' && 'name' in rule && 'description' in rule) {
                const r = rule as Record<string, unknown>;
                config.rules.push({
                    name: String(r['name']),
                    description: String(r['description']),
                    ...(typeof r['severity'] === 'string' ? { severity: r['severity'] } : {}),
                });
            }
        }
    }

    if (Array.isArray(raw['ignore'])) {
        config.ignore = raw['ignore'].filter((g): g is string => typeof g === 'string');
    }

    return config;
}

// ---------------------------------------------------------------------------
// Profile Overrides
// ---------------------------------------------------------------------------

/** Valid values for each stack dimension (for validation). */
const VALID_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'csharp', 'swift', 'dart']);
const VALID_FRAMEWORKS: ReadonlySet<string> = new Set(['react', 'nextjs', 'vue', 'nuxt', 'angular', 'svelte', 'solid', 'express', 'fastify', 'nestjs', 'koa', 'django', 'flask', 'fastapi', 'gin', 'echo', 'fiber']);
const VALID_STATE: ReadonlySet<string> = new Set(['zustand', 'redux', 'jotai', 'recoil', 'pinia', 'mobx']);
const VALID_STYLING: ReadonlySet<string> = new Set(['tailwind', 'css-modules', 'styled-components', 'emotion', 'vanilla-extract']);
const VALID_ARCH: ReadonlySet<string> = new Set(['fsd', 'clean-architecture', 'mvc', 'hexagonal']);
const VALID_FORMS: ReadonlySet<string> = new Set(['react-hook-form', 'formik']);
const VALID_VALIDATION: ReadonlySet<string> = new Set(['zod', 'yup', 'joi', 'valibot', 'pydantic']);
const VALID_TESTING: ReadonlySet<string> = new Set(['vitest', 'jest', 'pytest', 'go-test', 'mocha']);
const VALID_DATA_FETCHING: ReadonlySet<string> = new Set(['tanstack-query', 'swr', 'apollo', 'urql', 'trpc']);

/**
 * Apply .codereview.yml stack overrides to an auto-detected profile.
 * Config file declarations take priority over auto-detection.
 */
export function applyConfigOverrides(
    profile: TechStackProfile,
    config: RepoReviewConfig
): TechStackProfile {
    if (!config.stack) return profile;

    const updated = { ...profile };
    const s = config.stack;

    if (s.language && VALID_LANGUAGES.has(s.language)) {
        updated.languages = [s.language as DetectedLanguage, ...profile.languages.filter(l => l !== s.language)];
    }
    if (s.framework && VALID_FRAMEWORKS.has(s.framework)) {
        updated.frameworks = [s.framework as DetectedFramework, ...profile.frameworks.filter(f => f !== s.framework)];
    }
    if (s.state && VALID_STATE.has(s.state)) {
        updated.stateManagement = [s.state as DetectedStateLib, ...profile.stateManagement.filter(x => x !== s.state)];
    }
    if (s.dataFetching && VALID_DATA_FETCHING.has(s.dataFetching)) {
        updated.dataFetching = [s.dataFetching as DetectedDataLib, ...profile.dataFetching.filter(x => x !== s.dataFetching)];
    }
    if (s.styling && VALID_STYLING.has(s.styling)) {
        updated.styling = [s.styling as DetectedStylingLib, ...profile.styling.filter(x => x !== s.styling)];
    }
    if (s.architecture && VALID_ARCH.has(s.architecture)) {
        updated.architecture = [s.architecture as DetectedArchPattern, ...profile.architecture.filter(x => x !== s.architecture)];
    }
    if (s.forms && VALID_FORMS.has(s.forms)) {
        updated.forms = [s.forms as DetectedFormLib, ...profile.forms.filter(x => x !== s.forms)];
    }
    if (s.validation && VALID_VALIDATION.has(s.validation)) {
        updated.validation = [s.validation as DetectedValidationLib, ...profile.validation.filter(x => x !== s.validation)];
    }
    if (s.testing && VALID_TESTING.has(s.testing)) {
        updated.testing = [s.testing as DetectedTestLib, ...profile.testing.filter(x => x !== s.testing)];
    }

    updated.source = 'config-file';
    updated.confidence = 'high';

    return updated;
}

/**
 * Check if a filename matches any of the ignore patterns in the config.
 * Supports globbing: `*` (single segment), `**` (recursive), `?` (single char).
 *
 * Examples:
 *   - `dist/*` matches `dist/foo.js` but NOT `dist/sub/bar.js`
 *   - `dist/**` matches `dist/foo.js` AND `dist/sub/bar.js`
 *   - `*.test.ts` matches `foo.test.ts`
 *   - `src/generated/??.ts` matches `src/generated/AB.ts`
 */
export function shouldIgnore(filename: string, ignorePatterns?: string[]): boolean {
    if (!ignorePatterns || ignorePatterns.length === 0) return false;

    for (const pattern of ignorePatterns) {
        const regex = globToRegex(pattern);
        if (regex.test(filename)) return true;
    }

    return false;
}

/**
 * Convert a glob pattern to a RegExp with proper `**` and `*` semantics.
 *
 * - `**` → matches any path segment (including `/`)
 * - `*`  → matches anything within a single path segment (no `/`)
 * - `?`  → matches a single character (not `/`)
 */
function globToRegex(pattern: string): RegExp {
    let regexStr = '';
    let i = 0;

    while (i < pattern.length) {
        const ch = pattern[i];

        if (ch === '*' && pattern[i + 1] === '*') {
            // `**` → match any path depth
            regexStr += '.*';
            i += 2;
            // Skip trailing `/` after `**` if present
            if (pattern[i] === '/') i++;
        } else if (ch === '*') {
            // `*` → match within one segment only (no `/`)
            regexStr += '[^/]*';
            i++;
        } else if (ch === '?') {
            // `?` → single char, not `/`
            regexStr += '[^/]';
            i++;
        } else if ('.+^${}()|[]\\'.includes(ch)) {
            // Escape regex meta-characters
            regexStr += '\\' + ch;
            i++;
        } else {
            regexStr += ch;
            i++;
        }
    }

    return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Build a custom rules prompt string from .codereview.yml rules.
 */
export function buildCustomRulesPrompt(config: RepoReviewConfig): string | undefined {
    if (!config.rules || config.rules.length === 0) return undefined;

    const lines = config.rules.map((rule, i) =>
        `${i + 1}. **${rule.name}**${rule.severity ? ` [${rule.severity}]` : ''}: ${rule.description}`
    );

    return lines.join('\n');
}
