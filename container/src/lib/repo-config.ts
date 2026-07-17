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
// YAML Parser (Minimal — no external dependencies, fully generic)
// ---------------------------------------------------------------------------

/**
 * Generic, indentation-aware YAML parser for .codereview.yml.
 *
 * Builds a proper nested object tree using indentation to determine structure.
 * Works with any .codereview.yml format — properly indented standard YAML,
 * flat-format YAML (everything at indent 0), or any mixture.
 *
 * Supports:
 *   - Key-value pairs: `key: value`
 *   - Nested objects via indentation
 *   - Sequence items (`-` and `*` prefix)
 *   - Block scalar strings (`|` indicator)
 *   - Comments (`#`)
 *   - Quoted strings, booleans, numbers
 *
 * Does NOT support (intentionally — keeps the parser small for Workers/Containers):
 *   - Anchors/aliases (&anchor / *alias)
 *   - Folded strings (>)
 *   - Flow sequences/mappings ([a, b] / {a: b})
 *   - Multi-document (---)
 *   - Tags (!!str, !!int)
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const lines = content.replace(/\r/g, '').split('\n');

    // Stack tracks nesting context via indentation.
    // Each entry holds the indent level and the container (object or array) at that level.
    type StackEntry = { indent: number; container: Record<string, unknown> | unknown[] };
    const stack: StackEntry[] = [{ indent: -1, container: root }];

    // Block scalar (|) state
    let mlKey: string | null = null;
    let mlBaseIndent = 0;
    let mlLines: string[] = [];
    let mlTarget: Record<string, unknown> | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.trimStart();

        // Skip blank lines and whole-line comments (but capture blanks in multiline blocks)
        if (stripped === '' || stripped.startsWith('#')) {
            if (mlKey !== null && stripped === '') mlLines.push('');
            continue;
        }

        const indent = line.length - stripped.length;
        const trimmed = stripped;

        // ── Block scalar termination ──────────────────────────────────────
        // Content of a block scalar must be at indent > the key's indent.
        // In flat mode (where indent <= key's indent), a block scalar ends
        // when a line matches a new key-value pair or list item.
        if (mlKey !== null) {
            const isNewKey = trimmed.match(/^([\w][\w.-]*):\s*(.*)/);
            const isNewListItem = trimmed.startsWith('- ') || trimmed.startsWith('* ');
            if (indent < mlBaseIndent || (indent === mlBaseIndent && (isNewKey || isNewListItem))) {
                mlTarget![mlKey] = mlLines.join('\n').trim();
                mlKey = null;
                mlTarget = null;
                mlLines = [];
                // Fall through — this line is NOT part of the block.
            } else {
                mlLines.push(line);
                continue;
            }
        }

        // ── Stack management ─────────────────────────────────────────────
        // In standard YAML, we pop any container at >= current indent.
        // In flat mode, the container and its children have the same indent.
        // We only pop the container if the current line is a new section header
        // (key with empty value, or list item).
        const isListItem = trimmed.startsWith('- ') || trimmed.startsWith('* ');
        const tempKv = trimmed.match(/^([\w][\w.-]*):\s*(.*)/);
        const isHeader = (tempKv && (tempKv[2].trim() === '' || tempKv[2].trim() === '|')) || isListItem;

        if (isListItem) {
            // Pop entries strictly deeper than this indent
            while (stack.length > 1 && stack[stack.length - 1].indent > indent) {
                stack.pop();
            }
        } else {
            const limit = isHeader ? indent : indent + 1;
            while (stack.length > 1 && stack[stack.length - 1].indent >= limit) {
                stack.pop();
            }
        }

        const parent = stack[stack.length - 1].container;

        // ── Sequence item (- or *) ───────────────────────────────────────
        if (isListItem) {
            const itemContent = trimmed.substring(2).trim();

            // Find the array to push into.
            // Parent must be an array (set up when we saw the key with peek-ahead).
            let arr: unknown[];
            if (Array.isArray(parent)) {
                arr = parent;
            } else {
                // Edge case: the sequence item is at the same indent as its
                // parent key but the parent was initialised as an object
                // (no peek-ahead matched). Convert on the fly.
                // In practice this shouldn't happen with the peek-ahead logic,
                // so we skip gracefully.
                continue;
            }

            // Check if the item starts with a key-value (object element in sequence)
            const kvMatch = itemContent.match(/^([\w][\w.-]*):\s*(.*)/);
            if (kvMatch) {
                const obj: Record<string, unknown> = {};
                const key = kvMatch[1];
                const val = kvMatch[2].trim();

                if (val === '|') {
                    mlKey = key;
                    mlBaseIndent = indent;
                    mlLines = [];
                    mlTarget = obj;
                } else {
                    obj[key] = val !== '' ? parseYamlValue(val) : '';
                }
                arr.push(obj);
                // Push the object at indent + 1 so that:
                //   • Children at indent > list-item-indent go into this object
                //   • The next `- ` at the same indent pops this object but keeps the array
                stack.push({ indent: indent + 1, container: obj });
            } else {
                // Simple scalar item
                arr.push(parseYamlValue(itemContent));
            }
            continue;
        }

        // ── Key-value pair ───────────────────────────────────────────────
        const kvMatch = trimmed.match(/^([\w][\w.-]*):\s*(.*)/);
        if (!kvMatch) continue; // Skip lines that aren't parseable

        // Can only add keys to an object, not an array
        if (Array.isArray(parent)) continue;
        const parentObj = parent as Record<string, unknown>;

        const key = kvMatch[1];
        const rawVal = kvMatch[2].trim();

        if (rawVal === '|') {
            // ── Block scalar indicator ───────────────────────────────────
            mlKey = key;
            mlBaseIndent = indent;
            mlLines = [];
            mlTarget = parentObj;
        } else if (rawVal === '') {
            // ── Empty value → nested object or sequence ──────────────────
            const nextInfo = peekNextLineInfo(lines, i + 1);

            if (nextInfo) {
                // If next line has indent > current indent, use next line's indent.
                // Otherwise (flat mode), use current indent so subsequent key-values at
                // the same indent level nest inside this container instead of popping it.
                const childIndent = nextInfo.indent > indent ? nextInfo.indent : indent;
                if (nextInfo.type === 'sequence') {
                    const arr: unknown[] = [];
                    parentObj[key] = arr;
                    stack.push({ indent: childIndent, container: arr });
                } else {
                    const child: Record<string, unknown> = {};
                    parentObj[key] = child;
                    stack.push({ indent: childIndent, container: child });
                }
            } else {
                parentObj[key] = '';
            }
        } else {
            // ── Simple scalar value ──────────────────────────────────────
            parentObj[key] = parseYamlValue(rawVal);
        }
    }

    // Finalize any pending block scalar at EOF
    if (mlKey !== null && mlTarget) {
        mlTarget[mlKey] = mlLines.join('\n').trim();
    }

    return root;
}

type LineInfo = { indent: number; type: 'sequence' | 'mapping' };

/**
 * Peek ahead in the line array to determine key details of the next line.
 * Skips blank lines and comments.
 */
function peekNextLineInfo(lines: string[], startIdx: number): LineInfo | null {
    for (let j = startIdx; j < lines.length; j++) {
        const line = lines[j];
        const stripped = line.trimStart();
        if (stripped === '' || stripped.startsWith('#')) continue;

        const indent = line.length - stripped.length;
        const type = (stripped.startsWith('- ') || stripped.startsWith('* ')) ? 'sequence' : 'mapping';
        return { indent, type };
    }
    return null;
}

/**
 * Parse a raw YAML scalar value into its JS type.
 * Handles: quoted strings, booleans, numbers, bare strings.
 */
function parseYamlValue(raw: string): string | number | boolean {
    const trimmed = raw.trim();

    // Strip inline comments (only if preceded by a space)
    const commentIdx = trimmed.indexOf(' #');
    const effective = commentIdx > 0 ? trimmed.substring(0, commentIdx).trim() : trimmed;

    // Quoted string
    if ((effective.startsWith('"') && effective.endsWith('"')) ||
        (effective.startsWith("'") && effective.endsWith("'"))) {
        return effective.slice(1, -1);
    }

    // Boolean
    if (effective === 'true') return true;
    if (effective === 'false') return false;

    // Number
    const num = Number(effective);
    if (!isNaN(num) && effective.length > 0) return num;

    return effective;
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
// Deep Tree Search Utilities
// ---------------------------------------------------------------------------

/**
 * Recursively collect every occurrence of `key` in a nested tree.
 * Returns an array of all values found (deepest-first traversal).
 */
function deepFindAll(tree: Record<string, unknown>, key: string): unknown[] {
    const results: unknown[] = [];

    for (const [k, v] of Object.entries(tree)) {
        if (k === key) results.push(v);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            results.push(...deepFindAll(v as Record<string, unknown>, key));
        }
    }

    return results;
}

/**
 * Find the first string value for `key` anywhere in the tree.
 * Checks `primary` object first (for standard paths), then falls back
 * to a full tree search (for flat or deeply nested formats).
 */
function findString(primary: Record<string, unknown>, tree: Record<string, unknown>, ...keys: string[]): string | undefined {
    // First pass: check the primary container
    for (const key of keys) {
        const val = primary[key];
        if (typeof val === 'string' && val.trim() !== '') return val.trim().toLowerCase();
    }

    // Second pass: deep search the entire tree
    for (const key of keys) {
        const hits = deepFindAll(tree, key);
        for (const hit of hits) {
            if (typeof hit === 'string' && hit.trim() !== '') return hit.trim().toLowerCase();
        }
    }

    return undefined;
}

/**
 * Find the first string value for `key` anywhere in the tree
 * that also appears in a given validation set.
 */
function findValidatedString(
    primary: Record<string, unknown>,
    tree: Record<string, unknown>,
    validSet: ReadonlySet<string>,
    ...keys: string[]
): string | undefined {
    // First pass: check the primary container
    for (const key of keys) {
        const val = primary[key];
        if (typeof val === 'string' && validSet.has(val.trim().toLowerCase())) {
            return val.trim().toLowerCase();
        }
    }

    // Second pass: deep search the entire tree
    for (const key of keys) {
        const hits = deepFindAll(tree, key);
        for (const hit of hits) {
            if (typeof hit === 'string' && validSet.has(hit.trim().toLowerCase())) {
                return (hit as string).trim().toLowerCase();
            }
        }
    }

    return undefined;
}

/**
 * Find an array of strings at `key`, checking primary then full tree.
 */
function findStringArray(primary: Record<string, unknown>, tree: Record<string, unknown>, ...keys: string[]): string[] | undefined {
    for (const key of keys) {
        const val = primary[key];
        if (Array.isArray(val)) {
            const strings = val.filter((v): v is string => typeof v === 'string');
            if (strings.length > 0) return strings;
        }
    }

    for (const key of keys) {
        const hits = deepFindAll(tree, key);
        for (const hit of hits) {
            if (Array.isArray(hit)) {
                const strings = (hit as unknown[]).filter((v): v is string => typeof v === 'string');
                if (strings.length > 0) return strings;
            }
        }
    }

    return undefined;
}

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

function validateConfig(raw: Record<string, unknown>): RepoReviewConfig {
    const config: RepoReviewConfig = {};

    // ── Version ──────────────────────────────────────────────────────────
    const version = deepFindAll(raw, 'version').find(v => typeof v === 'number');
    if (typeof version === 'number') config.version = version;

    // ── Stack ────────────────────────────────────────────────────────────
    // The "stack" object is the primary source, but keys may appear at any
    // depth for flat-format or deeply-nested configs. Deep search handles both.
    const stackObj = (raw['stack'] && typeof raw['stack'] === 'object' && !Array.isArray(raw['stack']))
        ? raw['stack'] as Record<string, unknown>
        : {};

    // Only build a stack config if we can find at least one stack-related key
    const language = findString(stackObj, raw, 'language', 'languages');
    const framework = findValidatedString(stackObj, raw, VALID_FRAMEWORKS, 'framework', 'frameworks');
    const architecture = findString(stackObj, raw, 'architecture', 'architectures');
    const state = findValidatedString(stackObj, raw, VALID_STATE, 'state', 'client_state');
    const styling = findValidatedString(stackObj, raw, VALID_STYLING, 'styling', 'framework');
    const testing = findValidatedString(stackObj, raw, VALID_TESTING, 'testing', 'runner');
    const forms = findValidatedString(stackObj, raw, VALID_FORMS, 'forms');
    const validation = findValidatedString(stackObj, raw, VALID_VALIDATION, 'validation', 'schema_validation');
    const dataFetching = findValidatedString(stackObj, raw, VALID_DATA_FETCHING, 'dataFetching', 'data_fetching', 'server_state');

    // Process ecosystem array — route libraries to their correct stack dimension
    const ecosystem = findStringArray(stackObj, raw, 'ecosystem', 'ecosystems');

    const hasAnyStack = language || framework || architecture || state || styling ||
        testing || forms || validation || dataFetching || ecosystem;

    if (hasAnyStack) {
        config.stack = {};
        if (language) config.stack.language = language;
        if (framework) config.stack.framework = framework;
        if (architecture) config.stack.architecture = architecture;
        if (state) config.stack.state = state;
        if (styling) config.stack.styling = styling;
        if (testing) config.stack.testing = testing;
        if (forms) config.stack.forms = forms;
        if (validation) config.stack.validation = validation;
        if (dataFetching) config.stack.dataFetching = dataFetching;

        // Ecosystem fallback — route values to empty dimensions
        if (ecosystem) {
            for (const lib of ecosystem) {
                const normalized = lib.toLowerCase().trim();
                if (VALID_STATE.has(normalized) && !config.stack.state) config.stack.state = normalized;
                if (VALID_STYLING.has(normalized) && !config.stack.styling) config.stack.styling = normalized;
                if (VALID_FORMS.has(normalized) && !config.stack.forms) config.stack.forms = normalized;
                if (VALID_VALIDATION.has(normalized) && !config.stack.validation) config.stack.validation = normalized;
                if (VALID_TESTING.has(normalized) && !config.stack.testing) config.stack.testing = normalized;
                if (VALID_DATA_FETCHING.has(normalized) && !config.stack.dataFetching) config.stack.dataFetching = normalized;
            }
        }
    }

    // ── Severity overrides ───────────────────────────────────────────────
    if (raw['severity'] && typeof raw['severity'] === 'object' && !Array.isArray(raw['severity'])) {
        config.severity = {};
        for (const [key, val] of Object.entries(raw['severity'] as Record<string, unknown>)) {
            if (typeof val === 'string') {
                config.severity[key] = val.toLowerCase().trim();
            }
        }
    }

    // ── Rules ────────────────────────────────────────────────────────────
    if (Array.isArray(raw['rules'])) {
        config.rules = [];
        for (const rule of raw['rules']) {
            if (rule && typeof rule === 'object') {
                const r = rule as Record<string, unknown>;
                const ruleName = r['name'] || r['title'];
                const description = r['description'];
                if (ruleName && description) {
                    config.rules.push({
                        name: String(ruleName),
                        description: String(description),
                        ...(typeof r['severity'] === 'string' ? { severity: r['severity'].toLowerCase().trim() } : {}),
                    });
                }
            }
        }
    }

    // ── Ignore patterns ──────────────────────────────────────────────────
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
const VALID_STYLING: ReadonlySet<string> = new Set(['tailwind', 'tailwindcss', 'css-modules', 'styled-components', 'emotion', 'vanilla-extract']);
const VALID_ARCH: ReadonlySet<string> = new Set(['fsd', 'feature-sliced-design', 'clean-architecture', 'mvc', 'hexagonal']);
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
