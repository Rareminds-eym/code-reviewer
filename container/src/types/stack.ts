/**
 * Tech Stack Detection Types
 *
 * Defines the complete type surface for auto-detecting the tools,
 * frameworks, and architectural patterns used in a repository or PR.
 *
 * These types drive the modular prompt composition engine:
 *   detection → TechStackProfile → composer → per-chunk system prompt
 */

// ---------------------------------------------------------------------------
// Detected Dimensions
// ---------------------------------------------------------------------------

/** Programming language detected from file extensions. */
export type DetectedLanguage =
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'java'
    | 'kotlin'
    | 'ruby'
    | 'php'
    | 'csharp'
    | 'swift'
    | 'dart';

/** UI or backend framework detected from manifest dependencies. */
export type DetectedFramework =
    | 'react'
    | 'nextjs'
    | 'vue'
    | 'nuxt'
    | 'angular'
    | 'svelte'
    | 'solid'
    | 'express'
    | 'fastify'
    | 'nestjs'
    | 'koa'
    | 'django'
    | 'flask'
    | 'fastapi'
    | 'gin'
    | 'echo'
    | 'fiber';

/** State management library. */
export type DetectedStateLib =
    | 'zustand'
    | 'redux'
    | 'jotai'
    | 'recoil'
    | 'pinia'
    | 'mobx';

/** Async / server-state data-fetching library. */
export type DetectedDataLib =
    | 'tanstack-query'
    | 'swr'
    | 'apollo'
    | 'urql'
    | 'trpc';

/** CSS / styling approach. */
export type DetectedStylingLib =
    | 'tailwind'
    | 'css-modules'
    | 'styled-components'
    | 'emotion'
    | 'vanilla-extract';

/** Architectural pattern detected from directory structure. */
export type DetectedArchPattern =
    | 'fsd'
    | 'clean-architecture'
    | 'mvc'
    | 'hexagonal';

/** Form management library. */
export type DetectedFormLib =
    | 'react-hook-form'
    | 'formik';

/** Schema / runtime validation library. */
export type DetectedValidationLib =
    | 'zod'
    | 'yup'
    | 'joi'
    | 'valibot';

/** Testing framework. */
export type DetectedTestLib =
    | 'vitest'
    | 'jest'
    | 'pytest'
    | 'go-test'
    | 'mocha';

// ---------------------------------------------------------------------------
// Detection Metadata
// ---------------------------------------------------------------------------

/**
 * Confidence level of the overall detection.
 *
 * - `high`: Detected from manifest file (package.json, go.mod, etc.)
 * - `medium`: Inferred from file extensions + directory structure
 * - `low`: Minimal signals (e.g., only 1-2 files in the PR)
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/**
 * How the profile was obtained.
 *
 * Ordered by priority (config-file > manifest > imports > file-extensions > cached).
 */
export type DetectionSource =
    | 'config-file'       // From .codereview.yml in the repo
    | 'manifest'          // From package.json / go.mod / requirements.txt
    | 'imports'           // From import statements in fetched file content
    | 'file-extensions'   // From file extensions alone (weakest signal)
    | 'cached';           // Previously detected and retrieved from KV

// ---------------------------------------------------------------------------
// TechStackProfile — The Core Detection Result
// ---------------------------------------------------------------------------

/**
 * Complete technology stack profile for a repository or PR.
 *
 * Produced by `detectTechStack()`, consumed by `composeChunkPrompt()`.
 * Each array is ordered by confidence/prevalence (most prominent first).
 *
 * An empty array means "not detected" for that dimension — the composer
 * will simply skip the corresponding prompt module.
 */
export interface TechStackProfile {
    /** Primary programming languages, ranked by file-count prevalence. */
    languages: DetectedLanguage[];

    /** UI / backend frameworks detected from dependencies. */
    frameworks: DetectedFramework[];

    /** Client-side state management libraries. */
    stateManagement: DetectedStateLib[];

    /** Async / server-state data-fetching libraries. */
    dataFetching: DetectedDataLib[];

    /** CSS / styling approach. */
    styling: DetectedStylingLib[];

    /** Architectural patterns detected from directory structure. */
    architecture: DetectedArchPattern[];

    /** Form management libraries. */
    forms: DetectedFormLib[];

    /** Schema / runtime validation libraries. */
    validation: DetectedValidationLib[];

    /** Testing frameworks. */
    testing: DetectedTestLib[];

    /** Overall detection confidence. */
    confidence: DetectionConfidence;

    /** How this profile was sourced. */
    source: DetectionSource;
}

// ---------------------------------------------------------------------------
// Detection Options
// ---------------------------------------------------------------------------

/**
 * Input options for the `detectTechStack()` entry point.
 *
 * Only `changedFiles` is required — all other fields progressively
 * improve detection accuracy when available.
 */
export interface DetectionOptions {
    /** All filenames from `fetchChangedFiles()` — always available. */
    changedFiles: string[];

    /**
     * Already-fetched Tier 1 file contents — for import-statement scanning.
     * Available after `buildReviewChunks()`. Pass to avoid extra fetches.
     */
    fileContents?: ReadonlyArray<{ filename: string; content: string }>;

    /**
     * If `package.json` (or equivalent manifest) is among the changed files,
     * pass its content here to avoid a separate fetch.
     */
    manifestContent?: string;

    /**
     * Manifest filename — used to select the right parser.
     * e.g., 'package.json', 'requirements.txt', 'go.mod', 'Cargo.toml'
     */
    manifestFilename?: string;

    /** Repository full name (owner/repo) — for manifest fetch fallback. */
    repoFullName?: string;

    /** GitHub installation token — for manifest fetch fallback. */
    token?: string;

    /**
     * KV namespace for caching — enables 24h profile cache per repo
     * and manifest content cache.
     */
    kvNamespace?: any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an empty TechStackProfile with sensible defaults. */
export function emptyProfile(): TechStackProfile {
    return {
        languages: [],
        frameworks: [],
        stateManagement: [],
        dataFetching: [],
        styling: [],
        architecture: [],
        forms: [],
        validation: [],
        testing: [],
        confidence: 'low',
        source: 'file-extensions',
    };
}
