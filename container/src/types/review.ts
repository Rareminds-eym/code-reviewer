// ---------------------------------------------------------------------------
// Map-Reduce Review Types
// ---------------------------------------------------------------------------



/**
 * Severity levels for review findings.
 * Maps directly to the emoji tags in the final markdown output.
 */
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Universal categories — always valid regardless of detected tech stack.
 * These represent fundamental code quality dimensions.
 */
export type UniversalCategory =
    | 'bug'              // Logic errors, race conditions, off-by-one
    | 'security'         // XSS, injection, secrets, auth
    | 'performance'      // N+1, memory leaks, unnecessary computation
    | 'error-handling'   // Missing try/catch, unhandled promises
    | 'type-safety'      // `any` usage, type assertions, loose types
    | 'dead-code'        // Unused variables, unreachable branches
    | 'naming'           // Poor names, inconsistent conventions
    | 'accessibility'    // Missing ARIA, semantic HTML
    | 'architecture'     // Layer violations, circular deps
    | 'clean-code'       // General code quality
    | 'testing'          // Missing tests, brittle tests
    | 'documentation';   // Missing JSDoc, unclear comments

/**
 * Stack-specific categories — emitted when the corresponding
 * technology is detected in the repo. Kept for backward compatibility
 * with existing findings and prompt modules.
 */
export type StackCategory =
    | 'react'           // Hooks violations, component patterns
    | 'fsd'             // FSD layer boundary violations
    | 'zustand'         // State management anti-patterns
    | 'tanstack-query'  // Query key issues, staleTime
    | 'tailwind'        // Utility-first violations
    | 'forms'           // Form library anti-patterns
    | 'typescript';     // TS-specific (strict mode, generics)

/**
 * Categories for classifying the domain of each finding.
 * Two-tier system: universal categories are always valid,
 * stack-specific categories activate when detected.
 * Used by the synthesizer to group and deduplicate findings.
 */
export type FindingCategory = UniversalCategory | StackCategory;

/**
 * A single structured finding produced by a chunk reviewer (Map phase).
 */
export interface ReviewFinding {
    /** Severity classification */
    severity: FindingSeverity;
    /** File path relative to repo root */
    file: string;
    /** Approximate line number (if identifiable from the diff) */
    line?: number;
    /** Short, descriptive title */
    title: string;
    /** One sentence describing the problem */
    issue: string;
    /** The problematic code snippet */
    currentCode?: string;
    /** The corrected code snippet */
    suggestedCode?: string;
    /** Domain category for grouping */
    category: FindingCategory;
}

/**
 * A finding enriched with cluster-derived annotations for the synthesizer.
 * This is what the LLM receives — a FLAT list, not nested clusters.
 */
export interface AnnotatedFinding extends ReviewFinding {
    /** Inline annotations from cluster analysis (similar patterns, etc.) */
    annotations?: string[];
}

/**
 * The payload sent to the synthesizer LLM (Reduce phase).
 *
 * Findings are presented as a FLAT, severity-sorted array — not nested
 * inside clusters. This prevents the LLM from consolidating similar
 * findings into a single discussion block.
 *
 * Cluster metadata (similar patterns) is preserved as
 * inline annotations on individual findings.
 */
export interface SynthesizerInput {
    /** PR title from GitHub */
    prTitle: string;
    /** Complete list of all files in the PR (for cross-file analysis) */
    allFiles: string[];
    /** Number of files skipped as noise */
    skippedCount: number;
    /** All findings, flattened and sorted by severity (critical first) */
    findings: AnnotatedFinding[];
    /** Total number of unique findings (before any payload truncation) */
    totalFindingsCount: number;
    /** Total chunks processed */
    totalChunks: number;
    /** Number of chunks that failed */
    failedChunks: number;
    /** Number of findings dropped due to payload size limits */
    droppedFindingsCount: number;
    /** Files that were in failed chunks (no coverage) */
    failedChunkFiles: string[];
    /** Pre-computed verdict — the LLM MUST use this, not derive its own */
    verdict: 'approve' | 'request_changes' | 'needs_discussion';
    /** Pre-computed severity counts for the summary table */
    severityCounts: { critical: number; high: number; medium: number; low: number };
    /** GitHub Check Run conclusion mapped from verdict */
    conclusion: 'success' | 'failure' | 'neutral';
}
