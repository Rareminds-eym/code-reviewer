// ---------------------------------------------------------------------------
// Provenance tracking + Consensus Router (R4, R5)
// ---------------------------------------------------------------------------
//
// Tier-1 of the hybrid review pipeline. Everything here is rule-based and
// costs $0 — no LLM calls. The Consensus_Router computes a confidence for
// each LLM finding from its Provenance (source-authority weights + agreement
// + verification status) and routes it to KEEP / DOWNGRADE / SUPPRESS /
// VERIFY. Ground-truth findings (static analysis, deterministic plugins,
// dependency audit) bypass scoring entirely and are never rejected (R5.2,
// Property 1).
//
// Confidence uses source-agreement + verification status ONLY. There is NO
// numeric hallucination-risk term (R4.6) — such a score does not exist in the
// codebase and is explicitly out of scope for this computation.

import type { ReviewFinding } from '../../types/review';
import {
    CONSENSUS_SOURCE_WEIGHTS,
    CONSENSUS_KEEP_THRESHOLD,
    CONSENSUS_DOWNGRADE_THRESHOLD,
    CONSENSUS_VERIFY_BAND,
    CONSENSUS_VERIFIED_FLOOR,
} from '../../config/constants';

// ---------------------------------------------------------------------------
// Provenance types (R4)
// ---------------------------------------------------------------------------

/**
 * Every source that can raise a Finding. Ground-truth sources
 * (`static-analysis`, the deterministic plugins, `dependency-audit`) carry the
 * highest authority weight and bypass scoring; the persona/MAP sources are the
 * LLM_Findings the router actually scores.
 */
export type AgentSource =
    | 'static-analysis'
    | 'secrets-plugin'
    | 'suspicious-patterns'
    | 'ts-strict-plugin'
    | 'dependency-audit'
    | 'security'
    | 'architect'
    | 'sre'
    | 'map-chunk';

/**
 * Metadata attached to every Finding (R4.1, R4.2). Records which source(s)
 * raised it, whether it was verified (Stage 2 or agentically), and whether it
 * is ground truth (never rejected by any LLM stage).
 */
export interface Provenance {
    /** Sources that raised this Finding (union after merge-by-identity). */
    sources: AgentSource[];
    /** True once the single-shot Stage 2 verifier confirmed the Finding. */
    stage2Verified: boolean;
    /** True once the Agentic_Verifier confirmed the Finding (R4.2). */
    agenticVerified?: boolean;
    /** True for static-analysis / plugin / dependency-audit findings (R5.2). */
    groundTruth: boolean;
}

/** A Finding enriched with Provenance. Stripped back to `ReviewFinding` before REDUCE (R4.3). */
export interface ProvenancedFinding extends ReviewFinding {
    provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Consensus Router types (R5)
// ---------------------------------------------------------------------------

/** The four terminal routes the router can assign to an LLM finding (Property 2). */
export type RouteDecision = 'keep' | 'downgrade' | 'suppress' | 'verify';

/** Tunable router configuration; defaults sourced from `config/constants.ts` (R11.2). */
export interface ConsensusConfig {
    /** Source-authority weights, keyed by `AgentSource` (R5.7). */
    weights: Record<AgentSource, number>;
    /** Confidence at or above this routes to KEEP (default 0.70). */
    keepThreshold: number;
    /** Confidence at or above this (but below KEEP) routes to DOWNGRADE (default 0.40). */
    downgradeThreshold: number;
    /** The uncertain VERIFY band `[low, high)` around the KEEP boundary (default [0.50, 0.70)). */
    verifyBand: readonly [number, number];
    /** Confidence floor applied to Stage-2 / agentically verified findings (default 0.60). */
    verifiedFloor: number;
}

/** The result of routing an entire Active_Finding_Set (R5). */
export interface RouterResult {
    /** Findings routed to KEEP, plus ground-truth pass-throughs. */
    keep: ProvenancedFinding[];
    /** Findings routed to DOWNGRADE — severity already forced to `low` (R5.8). */
    downgraded: ProvenancedFinding[];
    /** Ambiguous_Findings routed to the Agentic_Verifier (R5.5). */
    toVerify: ProvenancedFinding[];
    /** Count of findings routed to SUPPRESS (dropped, retained only in logs). */
    suppressedCount: number;
}

/** The disposition the Fallback_Decision (R5.6) can resolve a VERIFY finding to. */
export type FallbackDisposition = 'keep' | 'downgrade' | 'suppress';

// ---------------------------------------------------------------------------
// Default configuration (from Task 1 constants — do not redefine here)
// ---------------------------------------------------------------------------

/** Default router configuration assembled from the tunable constants (R5.7, R11.2). */
export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
    weights: CONSENSUS_SOURCE_WEIGHTS,
    keepThreshold: CONSENSUS_KEEP_THRESHOLD,
    downgradeThreshold: CONSENSUS_DOWNGRADE_THRESHOLD,
    verifyBand: CONSENSUS_VERIFY_BAND,
    verifiedFloor: CONSENSUS_VERIFIED_FLOOR,
};

// ---------------------------------------------------------------------------
// Merge by identity (R4.4, Property 9)
// ---------------------------------------------------------------------------

/**
 * Proximity window (in lines) within which two findings sharing a file and
 * normalized title are considered the same issue and merged.
 */
const LINE_PROXIMITY_WINDOW = 5;

/** Normalize a title for identity matching: lowercased, trimmed, whitespace-collapsed. */
function normalizeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Merge a non-empty cluster of matched findings into one, unioning provenance. */
function mergeCluster(cluster: ProvenancedFinding[]): ProvenancedFinding {
    if (cluster.length === 1) return cluster[0];

    // Anchor on the cluster's first (lowest-line) finding for the base shape.
    const base = cluster[0];
    const sources = new Set<AgentSource>();
    let stage2Verified = false;
    let agenticVerified = false;
    let groundTruth = false;

    for (const f of cluster) {
        for (const s of f.provenance.sources) sources.add(s);
        stage2Verified = stage2Verified || f.provenance.stage2Verified;
        agenticVerified = agenticVerified || (f.provenance.agenticVerified ?? false);
        groundTruth = groundTruth || f.provenance.groundTruth;
    }

    return {
        ...base,
        provenance: {
            // Sort for a canonical, order-independent representation (Property 9).
            sources: [...sources].sort(),
            stage2Verified,
            agenticVerified,
            groundTruth,
        },
    };
}

/**
 * Merge matched findings WITHIN a single Active_Finding_Set (R4.4). Two
 * findings match when they share the same file, the same normalized title, and
 * lines within a small proximity window. Matched findings collapse into one
 * whose `provenance.sources` is the union of the matched sources.
 *
 * Order-independent (Property 9): findings are grouped by `file + normalizedTitle`
 * and clustered over a deterministic line-sorted order, so the resulting sources
 * sets are identical regardless of the input order.
 */
export function mergeByIdentity(findings: ProvenancedFinding[]): ProvenancedFinding[] {
    // Group by file + normalized title (order-independent bucketing).
    const groups = new Map<string, ProvenancedFinding[]>();
    for (const f of findings) {
        const key = `${f.file}\u0000${normalizeTitle(f.title)}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(f);
        else groups.set(key, [f]);
    }

    const merged: ProvenancedFinding[] = [];

    for (const bucket of groups.values()) {
        // Deterministic canonical order: findings with a line sorted ascending,
        // findings without a line grouped together (treated as line -1).
        const sorted = [...bucket].sort((a, b) => (a.line ?? -1) - (b.line ?? -1));

        let cluster: ProvenancedFinding[] = [];
        let anchorLine: number | undefined;

        for (const f of sorted) {
            if (cluster.length === 0) {
                cluster = [f];
                anchorLine = f.line;
                continue;
            }

            const bothUndefined = f.line === undefined && anchorLine === undefined;
            const withinWindow =
                f.line !== undefined &&
                anchorLine !== undefined &&
                Math.abs(f.line - anchorLine) <= LINE_PROXIMITY_WINDOW;

            if (bothUndefined || withinWindow) {
                cluster.push(f);
            } else {
                merged.push(mergeCluster(cluster));
                cluster = [f];
                anchorLine = f.line;
            }
        }

        if (cluster.length > 0) merged.push(mergeCluster(cluster));
    }

    return merged;
}

// ---------------------------------------------------------------------------
// Confidence + routing (R5)
// ---------------------------------------------------------------------------

/**
 * Compute a finding's confidence from its Provenance (R5.1). Confidence is the
 * normalized sum of its UNIQUE source-authority weights (agreement across
 * sources raises confidence, capped at 1.0), floored to `verifiedFloor` when
 * the finding was Stage-2 or agentically verified. Ground-truth findings score
 * 1.0 (they bypass routing anyway). NO hallucination-risk term (R4.6).
 */
export function computeConfidence(f: ProvenancedFinding, cfg: ConsensusConfig): number {
    if (f.provenance.groundTruth) return 1;

    const uniqueSources = new Set(f.provenance.sources);
    let sum = 0;
    for (const source of uniqueSources) {
        sum += cfg.weights[source] ?? 0;
    }

    let confidence = Math.min(1, sum);

    if (f.provenance.stage2Verified || f.provenance.agenticVerified) {
        confidence = Math.max(confidence, cfg.verifiedFloor);
    }

    return confidence;
}

/**
 * Route a single finding (R5.2–R5.5, Property 2 — totality). Ground-truth
 * findings always KEEP (bypass scoring). Otherwise, by confidence:
 *   - `>= keepThreshold`            → keep
 *   - within the VERIFY band        → verify (Ambiguous_Finding)
 *   - `>= downgradeThreshold`       → downgrade (severity → low)
 *   - below                         → suppress
 * The ordering guarantees every LLM finding maps to exactly one route.
 */
export function route(f: ProvenancedFinding, cfg: ConsensusConfig): RouteDecision {
    if (f.provenance.groundTruth) return 'keep';

    const confidence = computeConfidence(f, cfg);
    const [verifyLow] = cfg.verifyBand;

    if (confidence >= cfg.keepThreshold) return 'keep';
    if (confidence >= verifyLow) return 'verify';
    if (confidence >= cfg.downgradeThreshold) return 'downgrade';
    return 'suppress';
}

/** Return a copy of the finding with severity forced to `low` (R5.8), otherwise unchanged. */
function toLowSeverity(f: ProvenancedFinding): ProvenancedFinding {
    if (f.severity === 'low') return f;
    return { ...f, severity: 'low' };
}

/**
 * Route an entire Active_Finding_Set (R5). Ground-truth findings pass through
 * to `keep` unchanged (R5.2). Downgraded findings have their severity forced to
 * `low` (R5.8). Suppressed findings are counted only. VERIFY findings become
 * Ambiguous_Findings for the Agentic_Verifier.
 */
export function routeAll(findings: ProvenancedFinding[], cfg: ConsensusConfig): RouterResult {
    const result: RouterResult = {
        keep: [],
        downgraded: [],
        toVerify: [],
        suppressedCount: 0,
    };

    for (const f of findings) {
        switch (route(f, cfg)) {
            case 'keep':
                result.keep.push(f);
                break;
            case 'downgrade':
                result.downgraded.push(toLowSeverity(f));
                break;
            case 'verify':
                result.toVerify.push(f);
                break;
            case 'suppress':
                result.suppressedCount += 1;
                break;
        }
    }

    return result;
}

/**
 * Fallback_Decision (R5.6): resolve a VERIFY-routed finding by its own
 * confidence band when the Agentic_Verifier is disabled or unavailable.
 * Uses the KEEP / DOWNGRADE thresholds directly (the VERIFY band does not
 * apply here): KEEP band → keep; DOWNGRADE band → downgrade (severity `low`);
 * below → suppress. Ground-truth findings always keep.
 */
export function resolveFallback(f: ProvenancedFinding, cfg: ConsensusConfig): FallbackDisposition {
    if (f.provenance.groundTruth) return 'keep';

    const confidence = computeConfidence(f, cfg);
    if (confidence >= cfg.keepThreshold) return 'keep';
    if (confidence >= cfg.downgradeThreshold) return 'downgrade';
    return 'suppress';
}
