/**
 * Track-aware Scheduler (Requirement 2).
 *
 * Builds an {@link AgentSchedule} — the per-review execution plan describing
 * which pipeline phases run, at what concurrency, and with what timeouts — from
 * the {@link ReviewTrack} and the current circuit-breaker state.
 *
 * Design contract (R2.1, R2.5):
 *   - `buildAgentSchedule` is a PURE function of `track` + breaker state + env
 *     feature flags. It performs NO LLM call and is recomputed fresh on every
 *     review.
 *   - It MUST NOT depend on durable per-namespace rate-limiter state; only the
 *     in-memory circuit breakers in `lib/retry.ts` are consulted.
 *
 * Track rules:
 *   - `fast`  → skip graphify, Stage 1 personas, consensus, and verify; never
 *     runs Stage 2 either (fast posts static + MAP directly). (R2.2, R2.6)
 *   - `deep`  → enable all phases, personas forced on, largest budgets. (R2.3, R2.7)
 *   - `full`  → personas enabled only if the dual-agent flag is set. (R2.7)
 *
 * Breaker-aware disabling (R2.4): when a required provider's circuit breaker is
 * open, the phases depending on it are disabled and that decision is recorded
 * in the returned schedule (`enabled: false`).
 *
 * Schedule-wins-over-flag (R2.8): a phase's `enabled` value is the AND of the
 * track allowance, the feature flag, and the breaker being closed. Because the
 * flag can only ever be one AND-term, a phase disabled by the track or a breaker
 * can NEVER be re-enabled by its flag being on.
 */

import type { Env, ReviewTrack } from '../../types/env';
import {
    type VerifierBudgets,
    VERIFIER_BUDGETS_BY_TRACK,
} from '../../config/constants';
import { GRAPHIFY_BUDGET_MS } from '../../config/constants';
import { circuitBreakers } from '../retry';

/** All pipeline phases the Scheduler can gate. */
export type PhaseName =
    | 'static-analysis'
    | 'dependency-audit'
    | 'graphify'
    | 'map'
    | 'stage1'
    | 'consensus'
    | 'verify'
    | 'stage2'
    | 'smart-dedup'
    | 'reduce';

/** Per-phase execution plan entry. */
export interface PhasePlan {
    /** Whether this phase runs for the current review. */
    enabled: boolean;
    /** Suggested intra-phase concurrency (e.g. parallel chunk reviews). */
    concurrency: number;
    /** Wall-clock budget for the phase in milliseconds. */
    timeoutMs: number;
}

/** The per-review execution plan derived from the track + breaker state. */
export interface AgentSchedule {
    track: ReviewTrack;
    phases: Record<PhaseName, PhasePlan>;
    /** Per-track verifier hard bounds (R7.6). */
    budgets: VerifierBudgets;
    /** deep forces on; full if the dual-agent flag is set; fast never (R2.7). */
    personasEnabled: boolean;
    /** Consensus router enabled: respects flag AND track (fast never) AND breaker. */
    consensusEnabled: boolean;
    /** Agentic verifier enabled: respects flag AND track (fast never verifies) AND breaker. */
    verifierEnabled: boolean;
}

/** Parse a string feature flag (`"true"` enables; anything else disables). */
function flagOn(value: string | undefined): boolean {
    return value === 'true';
}

/**
 * Resolve the provider circuit breakers relevant to LLM phases from the
 * configured AI provider. Defaults to Claude when unset.
 */
function providerBreakers(env: Env): { map: boolean; synth: boolean } {
    const provider = env.AI_PROVIDER === 'gemini' ? 'gemini' : 'claude';
    const mapBreaker =
        provider === 'gemini' ? circuitBreakers.geminiMap : circuitBreakers.anthropicMap;
    const synthBreaker =
        provider === 'gemini' ? circuitBreakers.geminiSynth : circuitBreakers.anthropicSynth;
    // A breaker is "available" when it is NOT open.
    return { map: !mapBreaker.isOpen, synth: !synthBreaker.isOpen };
}

/**
 * Per-track concurrency for the MAP phase (parallel chunk reviews). Larger
 * tracks fan out wider.
 */
function mapConcurrency(track: ReviewTrack): number {
    switch (track) {
        case 'fast':
            return 3;
        case 'deep':
            return 6;
        case 'full':
        default:
            return 4;
    }
}

/**
 * Build the Agent_Schedule for a review (R2.1).
 *
 * Pure function of `track`, the in-memory circuit-breaker state, and the env
 * feature flags. Recomputed fresh each review; never touches durable state.
 */
export function buildAgentSchedule(track: ReviewTrack, env: Env): AgentSchedule {
    const isFast = track === 'fast';
    const isDeep = track === 'deep';

    const breakers = providerBreakers(env);
    const depBreakerOk = !circuitBreakers.dependencyAudit.isOpen;
    const consensusBreakerOk = !circuitBreakers.consensus.isOpen;

    // Feature flags (all default off).
    const dualAgentFlag = flagOn(env.ENABLE_DUAL_AGENT);
    const dependencyAuditFlag = flagOn(env.ENABLE_DEPENDENCY_AUDIT);
    const consensusFlag = flagOn(env.ENABLE_CONSENSUS);
    const verifierFlag = flagOn(env.ENABLE_AGENTIC_VERIFIER);

    // Personas (Stage 1): deep forces on; full only with the dual-agent flag;
    // fast never (R2.7). Also gated by the provider "map" breaker being closed.
    const personaIntent = isDeep ? true : track === 'full' ? dualAgentFlag : false;
    const stage1Enabled = personaIntent && breakers.map;

    // Consensus & verifier: respect their flags AND the track (fast never) AND
    // the relevant breaker. Schedule decision wins over flag (R2.8): the flag is
    // only one AND-term, so a track/breaker veto cannot be undone by the flag.
    const consensusEnabled = !isFast && consensusFlag && consensusBreakerOk;
    const verifierEnabled = !isFast && verifierFlag && breakers.synth;

    // Original single-shot Stage 2 runs on the dual-agent (persona) path and is
    // never used on the fast track. Gated by the synthesis-provider breaker.
    const stage2Enabled = !isFast && stage1Enabled && breakers.synth;

    const budgets = VERIFIER_BUDGETS_BY_TRACK[track];

    const phases: Record<PhaseName, PhasePlan> = {
        // Ground-truth deterministic stage — always runs, no breaker dependency.
        'static-analysis': { enabled: true, concurrency: 4, timeoutMs: 30_000 },
        // Supply-chain scan — flag + its own breaker. Harmless on fast (no dep files).
        'dependency-audit': {
            enabled: dependencyAuditFlag && depBreakerOk,
            concurrency: 2,
            timeoutMs: 20_000,
        },
        // graphify extraction is LLM-driven — skipped on fast (R2.2), gated by map breaker.
        graphify: {
            enabled: !isFast && breakers.map,
            concurrency: 1,
            timeoutMs: GRAPHIFY_BUDGET_MS,
        },
        // MAP chunk reviews run on every track; gated by the map-provider breaker.
        map: {
            enabled: breakers.map,
            concurrency: mapConcurrency(track),
            timeoutMs: 60_000,
        },
        // Stage 1 personas — see personaIntent above.
        stage1: {
            enabled: stage1Enabled,
            concurrency: 3,
            timeoutMs: 90_000,
        },
        consensus: {
            enabled: consensusEnabled,
            concurrency: 1,
            timeoutMs: 10_000,
        },
        verify: {
            enabled: verifierEnabled,
            concurrency: budgets.maxConcurrentFindings,
            timeoutMs: 60_000,
        },
        stage2: {
            enabled: stage2Enabled,
            concurrency: 2,
            timeoutMs: 60_000,
        },
        // Deterministic downstream stages — always run.
        'smart-dedup': { enabled: true, concurrency: 1, timeoutMs: 15_000 },
        reduce: { enabled: true, concurrency: 1, timeoutMs: 30_000 },
    };

    return {
        track,
        phases,
        budgets,
        personasEnabled: stage1Enabled,
        consensusEnabled,
        verifierEnabled,
    };
}
