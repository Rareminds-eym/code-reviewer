/**
 * Triage_Gatekeeper types (R1).
 *
 * Shared classification types used by BOTH the edge worker (provisional
 * classification at webhook time) and the container (finalization once the
 * changed-file list is known). This file is a duplicated-in-sync copy —
 * `container/src/lib/triage-types.ts` MUST remain byte-for-byte identical
 * (R1.9).
 *
 * All classification is rule-based with NO LLM call (R1.1).
 */

import type { ReviewTrack } from '../types/env';

export type { ReviewTrack };

/**
 * Input signals available to the Triage_Gatekeeper.
 *
 * `files` may be absent at webhook time (R1.8); when absent the gatekeeper
 * produces a provisional decision from the remaining signals (title, labels,
 * target branch) and the container finalizes once the file list is known.
 */
export interface TriageInput {
  /** Changed files with per-file status and line deltas. Absent at webhook time (R1.8). */
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  /** PR labels (lower/upper-case preserved; matched case-insensitively). */
  labels: string[];
  /** PR title. */
  title: string;
  /** Target branch the PR merges into. */
  targetBranch: string;
  /** Total added lines across the PR, when known independently of `files`. */
  totalAdditions?: number;
}

/** The reason a track was assigned, for observability (R10.1). */
export type TriageReason =
  | 'security-sensitive'
  | 'docs-only'
  | 'dependency-change'
  | 'large'
  | 'default'
  | 'provisional';

/** The outcome of triage classification. */
export interface TriageDecision {
  /** Assigned Review_Track. */
  track: ReviewTrack;
  /** Human-readable reason the track was chosen (R10.1). */
  reason: TriageReason;
  /** True when the changed-file list was unavailable and the track is provisional (R1.8). */
  provisional: boolean;
  /** Phase names the scheduler should skip for this review (populated for `fast`). */
  skipAgents: string[];
}

/**
 * Tunable triage configuration with documented defaults (R1.2, R11.2).
 * Per-repo `.codereview.yml` may override these, but SHALL NOT lower a
 * security-driven `deep` escalation (R11.3).
 */
export interface TriageConfig {
  /** Glob-like path patterns marking security-sensitive files → `deep` (R1.2). */
  securityGlobs: string[];
  /** Security-related labels forcing `deep` (matched case-insensitively) (R1.2). */
  securityLabels: string[];
  /** Max added lines for a change to qualify as `fast` (R1.3). */
  fastMaxAdditions: number;
  /** Max changed-file count for a change to qualify as `fast` (R1.3). */
  fastMaxFiles: number;
  /** Dependency-relevant patterns: lockfiles, manifests, Dockerfiles, CI workflows (R1.6). */
  dependencyGlobs: string[];
  /** Documentation/config patterns; only an all-doc/config change may be `fast` (R1.3, R1.7). */
  docGlobs: string[];
}

/**
 * Default triage configuration (R1.2, R1.3, R1.6, R11.2).
 *
 * Patterns are simple glob strings supporting `*` (any run of non-`/` chars),
 * `**` (any run including `/`), and `?` (single non-`/` char); matched against
 * the POSIX-style file path. Labels are matched case-insensitively.
 */
export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  securityGlobs: [
    '**/auth/**',
    '**/authn/**',
    '**/authz/**',
    '**/security/**',
    '**/*secret*',
    '**/*credential*',
    '**/*password*',
    '**/*.pem',
    '**/*.key',
    '**/crypto/**',
    '**/middleware/**',
    '**/.github/workflows/**',
    '**/Dockerfile',
    '**/Dockerfile.*',
  ],
  securityLabels: ['security', 'security-sensitive', 'vulnerability', 'cve'],
  fastMaxAdditions: 50,
  fastMaxFiles: 3,
  dependencyGlobs: [
    '**/package.json',
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/bun.lockb',
    '**/composer.json',
    '**/composer.lock',
    '**/Gemfile',
    '**/Gemfile.lock',
    '**/Cargo.toml',
    '**/Cargo.lock',
    '**/go.mod',
    '**/go.sum',
    '**/poetry.lock',
    '**/pyproject.toml',
    '**/requirements*.txt',
    '**/Pipfile',
    '**/Pipfile.lock',
    '**/Dockerfile',
    '**/Dockerfile.*',
    '**/.github/workflows/**',
    '**/*.yml',
    '**/*.yaml',
  ],
  docGlobs: [
    '**/*.md',
    '**/*.mdx',
    '**/*.txt',
    '**/*.rst',
    '**/docs/**',
    '**/LICENSE',
    '**/LICENSE.*',
    '**/CHANGELOG',
    '**/CHANGELOG.*',
    '**/*.json',
    '**/*.yml',
    '**/*.yaml',
    '**/*.toml',
    '**/*.ini',
    '**/*.cfg',
    '**/.editorconfig',
    '**/.gitignore',
    '**/.prettierrc',
  ],
};
