/**
 * Tech Stack Detection Engine
 *
 * Automatically detects the technology stack of a repository/PR from
 * multiple signal sources, ordered by cost (free → 1 KV read → 1 subrequest):
 *
 *   1. File extensions in the PR            (free — always available)
 *   2. Directory paths in the PR            (free — architecture detection)
 *   3. Import statements in fetched content (free — already fetched)
 *   4. Manifest file in changed files       (free — if package.json is in the PR)
 *   5. Cached profile from KV              (1 KV read — microseconds)
 *   6. Manifest fetch from default branch  (1 subrequest — fallback only)
 *
 * All detection is pure static analysis — zero LLM calls.
 * Safe for V8 isolates, zero external dependencies.
 */

import type {
    TechStackProfile,
    DetectedLanguage,
    DetectedFramework,
    DetectedStateLib,
    DetectedDataLib,
    DetectedStylingLib,
    DetectedArchPattern,
    DetectedFormLib,
    DetectedValidationLib,
    DetectedTestLib,
    DetectionConfidence,
    DetectionSource,
    DetectionOptions,
} from '../types/stack';
import { emptyProfile } from '../types/stack';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Constants — Detection Maps
// ---------------------------------------------------------------------------

/** File extension → Language mapping. */
const EXTENSION_TO_LANGUAGE: Record<string, DetectedLanguage> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.rb': 'ruby',
    '.php': 'php',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.dart': 'dart',
};

/**
 * package.json dependency name → detection mapping.
 *
 * Each key is matched against both `dependencies` and `devDependencies`.
 * The value specifies which TechStackProfile dimension to populate.
 */
interface DependencySignal {
    dimension: keyof Pick<TechStackProfile,
        'frameworks' | 'stateManagement' | 'dataFetching' |
        'styling' | 'forms' | 'validation' | 'testing'
    >;
    value: string;
}

const PACKAGE_DEPENDENCY_MAP: Record<string, DependencySignal> = {
    // Frameworks
    'react': { dimension: 'frameworks', value: 'react' },
    'react-dom': { dimension: 'frameworks', value: 'react' },
    'next': { dimension: 'frameworks', value: 'nextjs' },
    'vue': { dimension: 'frameworks', value: 'vue' },
    'nuxt': { dimension: 'frameworks', value: 'nuxt' },
    '@angular/core': { dimension: 'frameworks', value: 'angular' },
    'svelte': { dimension: 'frameworks', value: 'svelte' },
    'solid-js': { dimension: 'frameworks', value: 'solid' },
    'express': { dimension: 'frameworks', value: 'express' },
    'fastify': { dimension: 'frameworks', value: 'fastify' },
    '@nestjs/core': { dimension: 'frameworks', value: 'nestjs' },
    'koa': { dimension: 'frameworks', value: 'koa' },

    // State Management
    'zustand': { dimension: 'stateManagement', value: 'zustand' },
    '@reduxjs/toolkit': { dimension: 'stateManagement', value: 'redux' },
    'redux': { dimension: 'stateManagement', value: 'redux' },
    'jotai': { dimension: 'stateManagement', value: 'jotai' },
    'recoil': { dimension: 'stateManagement', value: 'recoil' },
    'pinia': { dimension: 'stateManagement', value: 'pinia' },
    'mobx': { dimension: 'stateManagement', value: 'mobx' },

    // Data Fetching
    '@tanstack/react-query': { dimension: 'dataFetching', value: 'tanstack-query' },
    'react-query': { dimension: 'dataFetching', value: 'tanstack-query' },
    'swr': { dimension: 'dataFetching', value: 'swr' },
    '@apollo/client': { dimension: 'dataFetching', value: 'apollo' },
    'urql': { dimension: 'dataFetching', value: 'urql' },
    '@trpc/client': { dimension: 'dataFetching', value: 'trpc' },

    // Styling
    'tailwindcss': { dimension: 'styling', value: 'tailwind' },
    'styled-components': { dimension: 'styling', value: 'styled-components' },
    '@emotion/react': { dimension: 'styling', value: 'emotion' },
    '@emotion/styled': { dimension: 'styling', value: 'emotion' },
    '@vanilla-extract/css': { dimension: 'styling', value: 'vanilla-extract' },

    // Forms
    'react-hook-form': { dimension: 'forms', value: 'react-hook-form' },
    'formik': { dimension: 'forms', value: 'formik' },

    // Validation
    'zod': { dimension: 'validation', value: 'zod' },
    'yup': { dimension: 'validation', value: 'yup' },
    'joi': { dimension: 'validation', value: 'joi' },
    'valibot': { dimension: 'validation', value: 'valibot' },

    // Testing
    'vitest': { dimension: 'testing', value: 'vitest' },
    'jest': { dimension: 'testing', value: 'jest' },
    'mocha': { dimension: 'testing', value: 'mocha' },
};

/**
 * Python package name → detection mapping.
 * Matched against requirements.txt or pyproject.toml dependencies.
 */
const PYTHON_PACKAGE_MAP: Record<string, DependencySignal> = {
    'django': { dimension: 'frameworks', value: 'django' },
    'flask': { dimension: 'frameworks', value: 'flask' },
    'fastapi': { dimension: 'frameworks', value: 'fastapi' },
    'pytest': { dimension: 'testing', value: 'pytest' },
    'pydantic': { dimension: 'validation', value: 'pydantic' },
};

/**
 * Go module path → detection mapping.
 * Matched against go.mod require statements.
 */
const GO_MODULE_MAP: Record<string, DependencySignal> = {
    'github.com/gin-gonic/gin': { dimension: 'frameworks', value: 'gin' },
    'github.com/labstack/echo': { dimension: 'frameworks', value: 'echo' },
    'github.com/gofiber/fiber': { dimension: 'frameworks', value: 'fiber' },
};

/**
 * FSD layer directories. If ≥3 are present in the file paths,
 * Feature-Sliced Design is detected with high confidence.
 */
const FSD_LAYERS = ['app', 'processes', 'pages', 'widgets', 'features', 'entities', 'shared'] as const;
const FSD_DETECTION_THRESHOLD = 3;

/** Clean Architecture directories. */
const CLEAN_ARCH_DIRS = ['domain', 'application', 'infrastructure', 'presentation'] as const;

/** MVC directories. */
const MVC_DIRS = ['controllers', 'models', 'views'] as const;

// ---------------------------------------------------------------------------
// KV Cache
// ---------------------------------------------------------------------------

const CACHE_PREFIX = 'stack-profile';
const CACHE_TTL_SECONDS = 86400; // 24 hours

function cacheKey(repoFullName: string): string {
    return `${CACHE_PREFIX}:${repoFullName}`;
}

async function getCachedProfile(
    kvNamespace: any,
    repoFullName: string
): Promise<TechStackProfile | null> {
    try {
        const raw = await kvNamespace.get(cacheKey(repoFullName));
        if (!raw) return null;
        const profile = JSON.parse(raw) as TechStackProfile;
        profile.source = 'cached';
        return profile;
    } catch {
        return null;
    }
}

async function setCachedProfile(
    kvNamespace: any,
    repoFullName: string,
    profile: TechStackProfile
): Promise<void> {
    try {
        await kvNamespace.put(cacheKey(repoFullName), JSON.stringify(profile), {
            expirationTtl: CACHE_TTL_SECONDS,
        });
    } catch (error) {
        logger.warn('Failed to cache stack profile', {
            repoFullName,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

// ---------------------------------------------------------------------------
// Detection Phase 1: Language Detection (from file extensions)
// ---------------------------------------------------------------------------

/**
 * Detect languages from file extensions. Returns top languages by file count.
 * This is FREE — requires only the filename list we already have.
 */
export function detectLanguages(filenames: readonly string[]): DetectedLanguage[] {
    const counts = new Map<DetectedLanguage, number>();

    for (const filename of filenames) {
        const ext = getExtension(filename);
        const lang = EXTENSION_TO_LANGUAGE[ext];
        if (lang) {
            counts.set(lang, (counts.get(lang) ?? 0) + 1);
        }
    }

    // Sort by prevalence (most files first), return top 3
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([lang]) => lang);
}

// ---------------------------------------------------------------------------
// Detection Phase 2: Architecture Detection (from directory paths)
// ---------------------------------------------------------------------------

/**
 * Detect architectural patterns from directory paths in the PR.
 * Looks for well-known directory naming conventions.
 * This is FREE — uses the filename list only.
 */
export function detectArchitecture(filenames: readonly string[]): DetectedArchPattern[] {
    const patterns: DetectedArchPattern[] = [];

    // Normalize all paths to lowercase for case-insensitive matching
    const normalizedDirs = new Set<string>();
    for (const f of filenames) {
        const parts = f.toLowerCase().split('/');
        for (const part of parts) {
            normalizedDirs.add(part);
        }
    }

    // FSD detection: count how many FSD layer directories exist
    let fsdLayerCount = 0;
    for (const layer of FSD_LAYERS) {
        if (normalizedDirs.has(layer)) {
            fsdLayerCount++;
        }
    }
    if (fsdLayerCount >= FSD_DETECTION_THRESHOLD) {
        patterns.push('fsd');
    }

    // Clean Architecture detection
    let cleanArchCount = 0;
    for (const dir of CLEAN_ARCH_DIRS) {
        if (normalizedDirs.has(dir)) {
            cleanArchCount++;
        }
    }
    if (cleanArchCount >= 3) {
        patterns.push('clean-architecture');
    }

    // MVC detection
    let mvcCount = 0;
    for (const dir of MVC_DIRS) {
        if (normalizedDirs.has(dir)) {
            mvcCount++;
        }
    }
    if (mvcCount >= 2) {
        patterns.push('mvc');
    }

    return patterns;
}

// ---------------------------------------------------------------------------
// Detection Phase 3: Manifest Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a package.json and extract dependency signals.
 */
export function parsePackageJson(content: string): Partial<TechStackProfile> {
    const partial: Partial<TechStackProfile> = {};

    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
        pkg = JSON.parse(content);
    } catch {
        logger.warn('Failed to parse package.json during stack detection');
        return partial;
    }

    const allDeps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    // CSS Modules detection from config files isn't possible here,
    // but we check for the css-modules plugin in devDependencies
    if (allDeps.has('css-loader') || allDeps.has('postcss-modules')) {
        addToPartial(partial, 'styling', 'css-modules');
    }

    for (const dep of allDeps) {
        const signal = PACKAGE_DEPENDENCY_MAP[dep];
        if (signal) {
            addToPartial(partial, signal.dimension, signal.value);
        }
    }

    return partial;
}

/**
 * Parse requirements.txt (Python) and extract dependency signals.
 */
export function parseRequirementsTxt(content: string): Partial<TechStackProfile> {
    const partial: Partial<TechStackProfile> = {};

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Extract package name (before version specifier)
        const pkgName = trimmed.split(/[>=<!\[;]/)[0].trim().toLowerCase();
        const signal = PYTHON_PACKAGE_MAP[pkgName];
        if (signal) {
            addToPartial(partial, signal.dimension, signal.value);
        }
    }

    return partial;
}

/**
 * Parse go.mod and extract dependency signals.
 */
export function parseGoMod(content: string): Partial<TechStackProfile> {
    const partial: Partial<TechStackProfile> = {};

    // Match lines inside require (...) blocks and standalone require lines
    const requireBlockMatch = content.match(/require\s*\(([\s\S]*?)\)/g);
    const allModules: string[] = [];

    if (requireBlockMatch) {
        for (const block of requireBlockMatch) {
            const inner = block.replace(/require\s*\(/, '').replace(/\)/, '');
            for (const line of inner.split('\n')) {
                const modulePath = line.trim().split(/\s+/)[0];
                if (modulePath) allModules.push(modulePath);
            }
        }
    }

    for (const mod of allModules) {
        for (const [prefix, signal] of Object.entries(GO_MODULE_MAP)) {
            if (mod.startsWith(prefix)) {
                addToPartial(partial, signal.dimension, signal.value);
                break;
            }
        }
    }

    return partial;
}

/**
 * Dispatch to the correct manifest parser based on filename.
 */
export function parseManifest(content: string, filename: string): Partial<TechStackProfile> {
    const basename = filename.split('/').pop()?.toLowerCase() ?? '';

    if (basename === 'package.json') return parsePackageJson(content);
    if (basename === 'requirements.txt') return parseRequirementsTxt(content);
    if (basename === 'go.mod') return parseGoMod(content);

    // Unsupported manifest — return empty
    return {};
}

// ---------------------------------------------------------------------------
// Detection Phase 4: Import Scanning (from already-fetched content)
// ---------------------------------------------------------------------------

/**
 * Known import patterns → TechStackProfile dimension mapping.
 *
 * Scans ES/CJS imports in already-fetched file content.
 * This is FREE — the content was fetched for the review anyway.
 */
const IMPORT_PATTERNS: Array<{ pattern: RegExp; signal: DependencySignal }> = [
    // React ecosystem
    { pattern: /from\s+['"]react['"]/, signal: { dimension: 'frameworks', value: 'react' } },
    { pattern: /from\s+['"]next\//, signal: { dimension: 'frameworks', value: 'nextjs' } },
    { pattern: /from\s+['"]zustand['"]/, signal: { dimension: 'stateManagement', value: 'zustand' } },
    { pattern: /from\s+['"]@reduxjs\/toolkit['"]/, signal: { dimension: 'stateManagement', value: 'redux' } },
    { pattern: /from\s+['"]@tanstack\/react-query['"]/, signal: { dimension: 'dataFetching', value: 'tanstack-query' } },
    { pattern: /from\s+['"]react-hook-form['"]/, signal: { dimension: 'forms', value: 'react-hook-form' } },
    { pattern: /from\s+['"]zod['"]/, signal: { dimension: 'validation', value: 'zod' } },

    // Vue ecosystem
    { pattern: /from\s+['"]vue['"]/, signal: { dimension: 'frameworks', value: 'vue' } },
    { pattern: /from\s+['"]pinia['"]/, signal: { dimension: 'stateManagement', value: 'pinia' } },

    // Angular
    { pattern: /from\s+['"]@angular\/core['"]/, signal: { dimension: 'frameworks', value: 'angular' } },

    // Backend (Node.js)
    { pattern: /from\s+['"]express['"]/, signal: { dimension: 'frameworks', value: 'express' } },
    { pattern: /from\s+['"]fastify['"]/, signal: { dimension: 'frameworks', value: 'fastify' } },
    { pattern: /from\s+['"]@nestjs\//, signal: { dimension: 'frameworks', value: 'nestjs' } },

    // Python (import statements parsed differently)
    { pattern: /from\s+fastapi\s+import/, signal: { dimension: 'frameworks', value: 'fastapi' } },
    { pattern: /from\s+django/, signal: { dimension: 'frameworks', value: 'django' } },
    { pattern: /from\s+flask\s+import/, signal: { dimension: 'frameworks', value: 'flask' } },
];

/**
 * Scan already-fetched file contents for import statements
 * that reveal the tech stack.
 */
export function detectFromImports(
    fileContents: ReadonlyArray<{ filename: string; content: string }>
): Partial<TechStackProfile> {
    const partial: Partial<TechStackProfile> = {};

    for (const { content } of fileContents) {
        for (const { pattern, signal } of IMPORT_PATTERNS) {
            if (pattern.test(content)) {
                addToPartial(partial, signal.dimension, signal.value);
            }
        }
    }

    return partial;
}

// ---------------------------------------------------------------------------
// Detection Phase 5: Manifest Fetch (1 subrequest fallback)
// ---------------------------------------------------------------------------

/**
 * Detect which manifest files likely exist based on the primary language.
 * Returns the filename to attempt fetching from the repo default branch.
 */
function inferManifestFilename(languages: DetectedLanguage[]): string | null {
    if (languages.includes('typescript') || languages.includes('javascript')) {
        return 'package.json';
    }
    if (languages.includes('python')) return 'requirements.txt';
    if (languages.includes('go')) return 'go.mod';
    // Rust → Cargo.toml, Java → pom.xml — not yet supported
    return null;
}

/**
 * Fetch a manifest file from the repo's default branch via GitHub API.
 * Returns the decoded content or null on failure.
 */
async function fetchManifestFromRepo(
    repoFullName: string,
    manifestFilename: string,
    token: string
): Promise<string | null> {
    const url = `https://api.github.com/repos/${repoFullName}/contents/${manifestFilename}`;

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

        if (!response.ok) {
            if (response.status === 404) {
                logger.debug('Manifest file not found in repo', { repoFullName, manifestFilename });
            } else {
                logger.warn('Failed to fetch manifest', {
                    repoFullName,
                    manifestFilename,
                    status: response.status,
                });
            }
            return null;
        }

        return await response.text();
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.warn('Manifest fetch timed out (5s)', { repoFullName, manifestFilename });
        } else {
            logger.warn('Manifest fetch error', {
                repoFullName,
                manifestFilename,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Detect the technology stack of a repository from multiple signal sources.
 *
 * Detection is layered — each tier adds confidence:
 *   1. File extensions → language (free)
 *   2. Directory paths → architecture (free)
 *   3. Manifest in changed files → frameworks/libs (free if available)
 *   4. KV cache → previously detected profile (1 KV read)
 *   5. Manifest fetch from default branch → frameworks/libs (1 subrequest)
 *   6. Import scanning → ecosystem libs (free, runs after content fetch)
 *
 * The result is cached in KV for 24 hours per repo.
 */
export async function detectTechStack(options: DetectionOptions): Promise<TechStackProfile> {
    const { changedFiles, fileContents, kvNamespace, repoFullName, token } = options;

    const profile = emptyProfile();

    // ── Tier 1: Language detection from file extensions (FREE) ──
    profile.languages = detectLanguages(changedFiles);

    // ── Tier 2: Architecture detection from directory paths (FREE) ──
    profile.architecture = detectArchitecture(changedFiles);

    // ── Tier 3: Manifest in changed files (FREE if present) ──
    let hasManifestData = false;

    if (options.manifestContent && options.manifestFilename) {
        const manifestSignals = parseManifest(options.manifestContent, options.manifestFilename);
        mergePartialIntoProfile(profile, manifestSignals);
        hasManifestData = true;
        profile.source = 'manifest';
        profile.confidence = 'high';
    } else {
        // Check if any manifest file is among the changed files
        const manifestFiles = ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml'];
        const changedManifest = changedFiles.find(f => {
            const basename = f.split('/').pop()?.toLowerCase();
            return basename && manifestFiles.includes(basename);
        });

        if (changedManifest && fileContents) {
            const manifestEntry = fileContents.find(fc => fc.filename === changedManifest);
            if (manifestEntry) {
                const manifestSignals = parseManifest(manifestEntry.content, changedManifest);
                mergePartialIntoProfile(profile, manifestSignals);
                hasManifestData = true;
                profile.source = 'manifest';
                profile.confidence = 'high';
            }
        }
    }

    // ── Tier 4: KV cache check (1 KV read) ──
    if (!hasManifestData && kvNamespace && repoFullName) {
        const cached = await getCachedProfile(kvNamespace, repoFullName);
        if (cached) {
            logger.debug('Using cached stack profile', { repoFullName });
            // Merge cached data but keep fresh language/architecture detection
            cached.languages = profile.languages.length > 0 ? profile.languages : cached.languages;
            cached.architecture = profile.architecture.length > 0 ? profile.architecture : cached.architecture;
            return cached;
        }
    }

    // ── Tier 5: Manifest fetch from default branch (1 subrequest) ──
    if (!hasManifestData && repoFullName && token) {
        const manifestFilename = inferManifestFilename(profile.languages);
        if (manifestFilename) {
            const content = await fetchManifestFromRepo(repoFullName, manifestFilename, token);
            if (content) {
                const manifestSignals = parseManifest(content, manifestFilename);
                mergePartialIntoProfile(profile, manifestSignals);
                hasManifestData = true;
                profile.source = 'manifest';
                profile.confidence = 'high';
            }
        }
    }

    // ── Tier 6: Import scanning from already-fetched content (FREE) ──
    if (fileContents && fileContents.length > 0) {
        const importSignals = detectFromImports(fileContents);
        mergePartialIntoProfile(profile, importSignals);

        // Upgrade confidence if we got import data
        if (!hasManifestData && Object.keys(importSignals).length > 0) {
            profile.source = 'imports';
            if (profile.confidence === 'low') {
                profile.confidence = 'medium';
            }
        }
    }

    // ── Set final confidence if nothing upgraded it ──
    if (!hasManifestData && profile.source === 'file-extensions') {
        profile.confidence = profile.languages.length > 0 ? 'medium' : 'low';
    }

    // ── Cache the profile for future PRs ──
    if (kvNamespace && repoFullName && profile.confidence !== 'low') {
        await setCachedProfile(kvNamespace, repoFullName, profile);
    }

    logger.info('Tech stack detection complete', {
        languages: profile.languages,
        frameworks: profile.frameworks,
        stateManagement: profile.stateManagement,
        architecture: profile.architecture,
        styling: profile.styling,
        confidence: profile.confidence,
        source: profile.source,
    });

    return profile;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the file extension (with leading dot). */
function getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filename.substring(lastDot).toLowerCase();
}

/** Add a value to an array dimension in a partial profile, avoiding duplicates. */
function addToPartial(
    partial: Partial<TechStackProfile>,
    dimension: string,
    value: string
): void {
    const key = dimension as keyof TechStackProfile;
    if (!partial[key]) {
        (partial as Record<string, unknown[]>)[dimension] = [];
    }
    const arr = (partial as Record<string, unknown[]>)[dimension];
    if (!arr.includes(value)) {
        arr.push(value);
    }
}

/** Merge a partial detection result into the main profile without duplicates. */
function mergePartialIntoProfile(
    profile: TechStackProfile,
    partial: Partial<TechStackProfile>
): void {
    const arrayKeys: Array<keyof TechStackProfile> = [
        'languages', 'frameworks', 'stateManagement', 'dataFetching',
        'styling', 'architecture', 'forms', 'validation', 'testing',
    ];

    for (const key of arrayKeys) {
        const partialArr = partial[key] as string[] | undefined;
        if (partialArr && partialArr.length > 0) {
            const profileArr = profile[key] as string[];
            for (const val of partialArr) {
                if (!profileArr.includes(val)) {
                    profileArr.push(val);
                }
            }
        }
    }
}
