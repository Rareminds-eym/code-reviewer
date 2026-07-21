import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    type AgentSource,
    type ConsensusConfig,
    type ProvenancedFinding,
    type Provenance,
    DEFAULT_CONSENSUS_CONFIG,
    mergeByIdentity,
    computeConfidence,
    route,
    routeAll,
} from '../src/lib/llm/consensus';
import type { FindingSeverity, FindingCategory } from '../src/types/review';

/**
 * Tests for Provenance merge-by-identity + the Consensus_Router (Task 11).
 *
 * Property 9 — merge commutativity: `mergeByIdentity` is order-independent; the
 *   resulting union `sources` set per identity is the same regardless of input
 *   order (Validates: Requirement 4.4).
 * Property 2 — router totality: `route` returns exactly one of the four
 *   decisions and `routeAll` partitions the input with counts summing to the
 *   input length (Validates: Requirements 5.1, 5.3, 5.4, 5.5).
 *
 * Unit tests cover band boundaries (0.40 / 0.50 / 0.70), the verified floor
 * (0.60), ground-truth pass-through (R5.2), downgrade→`low` (R5.8), and that the
 * router operates only on the active set it is given (R5.1a).
 */

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const ALL_SOURCES: AgentSource[] = [
    'static-analysis',
    'secrets-plugin',
    'suspicious-patterns',
    'ts-strict-plugin',
    'dependency-audit',
    'security',
    'architect',
    'sre',
    'map-chunk',
];

const LLM_SOURCES: AgentSource[] = ['security', 'architect', 'sre', 'map-chunk'];

function prov(overrides: Partial<Provenance> = {}): Provenance {
    return {
        sources: ['map-chunk'],
        stage2Verified: false,
        groundTruth: false,
        ...overrides,
    };
}

function finding(overrides: Partial<ProvenancedFinding> = {}): ProvenancedFinding {
    return {
        severity: 'medium',
        file: 'src/a.ts',
        line: 10,
        title: 'Potential null dereference',
        issue: 'value may be null here',
        category: 'bug',
        provenance: prov(),
        ...overrides,
    };
}

/** A config whose `map-chunk` weight is set precisely so a map-chunk-only
 * finding's confidence lands exactly on a chosen boundary value. */
function configWithMapWeight(weight: number): ConsensusConfig {
    return {
        ...DEFAULT_CONSENSUS_CONFIG,
        weights: { ...DEFAULT_CONSENSUS_CONFIG.weights, 'map-chunk': weight },
    };
}

function normalizeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Canonicalize a merged result to compare order-independently: a sorted list
 * of `identity → sorted union sources`. Identity = file + normalized title +
 * anchor line (deterministic minimum line of the cluster). */
function canonicalize(findings: ProvenancedFinding[]): string {
    const entries = findings.map((f) => {
        const key = `${f.file}\u0000${normalizeTitle(f.title)}\u0000${f.line ?? -1}`;
        const sources = [...f.provenance.sources].sort().join(',');
        return `${key}=>${sources}`;
    });
    entries.sort();
    return JSON.stringify(entries);
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const arbSeverity = fc.constantFrom<FindingSeverity>('critical', 'high', 'medium', 'low');
const arbCategory = fc.constantFrom<FindingCategory>('bug', 'security', 'performance', 'type-safety');
const arbFile = fc.constantFrom('src/a.ts', 'src/b.ts', 'src/c.ts');
// Titles chosen so some normalize to the same identity (whitespace/case variants).
const arbTitle = fc.constantFrom('Null deref', 'null   DEREF', 'Race condition', 'Missing await');
const arbLine = fc.option(fc.integer({ min: 1, max: 25 }), { nil: undefined });

const arbProvenance: fc.Arbitrary<Provenance> = fc.record({
    sources: fc.uniqueArray(fc.constantFrom(...ALL_SOURCES), { minLength: 0, maxLength: 4 }),
    stage2Verified: fc.boolean(),
    agenticVerified: fc.boolean(),
    groundTruth: fc.boolean(),
});

const arbFinding: fc.Arbitrary<ProvenancedFinding> = fc.record({
    severity: arbSeverity,
    file: arbFile,
    line: arbLine,
    title: arbTitle,
    issue: fc.constant('generated issue'),
    category: arbCategory,
    provenance: arbProvenance,
});

// ---------------------------------------------------------------------------
// Property 9: merge commutativity (Validates: Requirements 4.4)
// ---------------------------------------------------------------------------

describe('mergeByIdentity — Property 9: merge commutativity', () => {
    it('produces identical identity→union-sources regardless of input order', () => {
        // Pair each finding with a sort key so fast-check drives varied orderings.
        const arbWithKey = fc.record({
            finding: arbFinding,
            key: fc.double({ min: 0, max: 1, noNaN: true }),
        });

        fc.assert(
            fc.property(fc.array(arbWithKey, { maxLength: 12 }), (pairs) => {
                const original = pairs.map((p) => p.finding);
                const asc = [...pairs].sort((a, b) => a.key - b.key).map((p) => p.finding);
                const desc = [...pairs].sort((a, b) => b.key - a.key).map((p) => p.finding);
                const reversed = [...original].reverse();

                const base = canonicalize(mergeByIdentity(original));
                expect(canonicalize(mergeByIdentity(asc))).toBe(base);
                expect(canonicalize(mergeByIdentity(desc))).toBe(base);
                expect(canonicalize(mergeByIdentity(reversed))).toBe(base);
            }),
            { numRuns: 300 },
        );
    });

    it('unions sources of matched findings within the proximity window', () => {
        const a = finding({
            line: 10,
            title: 'Null deref',
            provenance: prov({ sources: ['map-chunk'] }),
        });
        const b = finding({
            line: 12, // within window (<= 5)
            title: 'null   DEREF', // normalizes to the same identity
            provenance: prov({ sources: ['security'] }),
        });

        const merged = mergeByIdentity([a, b]);
        expect(merged).toHaveLength(1);
        expect([...merged[0].provenance.sources].sort()).toEqual(['map-chunk', 'security']);
    });

    it('does not merge findings beyond the proximity window', () => {
        const a = finding({ line: 10, title: 'Null deref', provenance: prov({ sources: ['map-chunk'] }) });
        const b = finding({ line: 20, title: 'Null deref', provenance: prov({ sources: ['security'] }) });

        const merged = mergeByIdentity([a, b]);
        expect(merged).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Property 2: router totality (Validates: Requirements 5.1, 5.3, 5.4, 5.5)
// ---------------------------------------------------------------------------

describe('route / routeAll — Property 2: router totality', () => {
    it('route returns exactly one of the four decisions for any finding', () => {
        fc.assert(
            fc.property(arbFinding, (f) => {
                const decision = route(f, DEFAULT_CONSENSUS_CONFIG);
                expect(['keep', 'downgrade', 'suppress', 'verify']).toContain(decision);
            }),
            { numRuns: 500 },
        );
    });

    it('routeAll partitions the input; counts sum to the input length', () => {
        fc.assert(
            fc.property(fc.array(arbFinding, { maxLength: 20 }), (fs) => {
                const result = routeAll(fs, DEFAULT_CONSENSUS_CONFIG);
                const total =
                    result.keep.length +
                    result.downgraded.length +
                    result.toVerify.length +
                    result.suppressedCount;
                expect(total).toBe(fs.length);

                // Each bucket must classify consistently with route().
                for (const f of result.keep) expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('keep');
                for (const f of result.toVerify) expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('verify');
            }),
            { numRuns: 300 },
        );
    });
});

// ---------------------------------------------------------------------------
// Unit: band boundaries 0.40 / 0.55 / 0.70
// ---------------------------------------------------------------------------

describe('route — band boundaries', () => {
    const mapOnly = () => finding({ provenance: prov({ sources: ['map-chunk'] }) });

    it('confidence exactly 0.70 → keep (KEEP threshold inclusive)', () => {
        const cfg = configWithMapWeight(0.7);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.7, 10);
        expect(route(mapOnly(), cfg)).toBe('keep');
    });

    it('confidence exactly 0.50 → verify (VERIFY band lower bound inclusive)', () => {
        const cfg = configWithMapWeight(0.5);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.5, 10);
        expect(route(mapOnly(), cfg)).toBe('verify');
    });

    it('confidence exactly 0.55 → verify (inside the VERIFY band)', () => {
        const cfg = configWithMapWeight(0.55);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.55, 10);
        expect(route(mapOnly(), cfg)).toBe('verify');
    });

    it('confidence just below 0.50 → downgrade (DOWNGRADE band upper bound exclusive)', () => {
        const cfg = configWithMapWeight(0.49);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.49, 10);
        expect(route(mapOnly(), cfg)).toBe('downgrade');
    });

    it('confidence exactly 0.40 → downgrade (DOWNGRADE threshold inclusive)', () => {
        const cfg = configWithMapWeight(0.4);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.4, 10);
        expect(route(mapOnly(), cfg)).toBe('downgrade');
    });

    it('confidence just below 0.40 → suppress', () => {
        const cfg = configWithMapWeight(0.39);
        expect(computeConfidence(mapOnly(), cfg)).toBeCloseTo(0.39, 10);
        expect(route(mapOnly(), cfg)).toBe('suppress');
    });

    it('default weights: sre-only lands on the 0.70 keep boundary', () => {
        const f = finding({ provenance: prov({ sources: ['sre'] }) });
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBeCloseTo(0.7, 10);
        expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('keep');
    });

    it('default weights: map-chunk-only (0.50) → verify', () => {
        // The VERIFY band lower bound is 0.50 (inclusive), so the lowest-authority
        // single LLM source (map-chunk, 0.50) is the "uncertain" one forwarded to
        // the verifier when consensus + verifier are enabled.
        const f = finding({ provenance: prov({ sources: ['map-chunk'] }) });
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBeCloseTo(0.5, 10);
        expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('verify');
    });
});

// ---------------------------------------------------------------------------
// Unit: verified floor 0.60
// ---------------------------------------------------------------------------

describe('computeConfidence — verified floor', () => {
    it('floors a low-weight stage2-verified finding to 0.60', () => {
        const f = finding({ provenance: prov({ sources: ['map-chunk'], stage2Verified: true }) });
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBeCloseTo(0.6, 10);
        // 0.60 falls inside the VERIFY band [0.50, 0.70).
        expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('verify');
    });

    it('floors a low-weight agentically-verified finding to 0.60', () => {
        const f = finding({
            provenance: prov({ sources: ['map-chunk'], agenticVerified: true }),
        });
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBeCloseTo(0.6, 10);
    });

    it('does not lower confidence already above the floor', () => {
        const f = finding({ provenance: prov({ sources: ['security'], stage2Verified: true }) });
        // security = 0.90 > floor 0.60, so it stays at 0.90.
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBeCloseTo(0.9, 10);
    });
});

// ---------------------------------------------------------------------------
// Unit: ground-truth pass-through (R5.2)
// ---------------------------------------------------------------------------

describe('route — ground-truth pass-through', () => {
    it('always keeps a ground-truth finding, even with an empty source set', () => {
        const f = finding({ provenance: prov({ sources: [], groundTruth: true }) });
        expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('keep');
        expect(computeConfidence(f, DEFAULT_CONSENSUS_CONFIG)).toBe(1);
    });

    it('keeps ground-truth regardless of weird provenance flags', () => {
        fc.assert(
            fc.property(
                fc.record({
                    sources: fc.uniqueArray(fc.constantFrom(...ALL_SOURCES), { minLength: 0, maxLength: 4 }),
                    stage2Verified: fc.boolean(),
                    agenticVerified: fc.boolean(),
                }),
                (p) => {
                    const f = finding({ provenance: { ...p, groundTruth: true } });
                    expect(route(f, DEFAULT_CONSENSUS_CONFIG)).toBe('keep');
                },
            ),
        );
    });
});

// ---------------------------------------------------------------------------
// Unit: downgrade → severity 'low' (R5.8)
// ---------------------------------------------------------------------------

describe('routeAll — downgrade forces severity low', () => {
    it('downgraded findings have severity low', () => {
        // A confidence in the DOWNGRADE band [0.40, 0.50) routes to downgrade.
        const cfg = configWithMapWeight(0.45);
        const high = finding({ severity: 'high', provenance: prov({ sources: ['map-chunk'] }) });
        const result = routeAll([high], cfg);
        expect(result.downgraded).toHaveLength(1);
        expect(result.downgraded[0].severity).toBe('low');
    });

    it('every downgraded finding across arbitrary inputs has severity low', () => {
        fc.assert(
            fc.property(fc.array(arbFinding, { maxLength: 20 }), (fs) => {
                const result = routeAll(fs, DEFAULT_CONSENSUS_CONFIG);
                for (const f of result.downgraded) expect(f.severity).toBe('low');
            }),
        );
    });
});

// ---------------------------------------------------------------------------
// Unit: operates on the active set it is given (R5.1a)
// ---------------------------------------------------------------------------

describe('routeAll — operates only on the active set', () => {
    it('every routed finding is a member of the input set', () => {
        const fs = [
            finding({ title: 'A', provenance: prov({ sources: ['security'] }) }), // 0.90 keep
            finding({ title: 'B', provenance: prov({ sources: ['map-chunk'] }) }), // 0.50 verify
            finding({ title: 'C', provenance: prov({ sources: ['map-chunk'], stage2Verified: true }) }), // 0.60 verify
        ];
        const result = routeAll(fs, DEFAULT_CONSENSUS_CONFIG);

        const routed = [...result.keep, ...result.downgraded, ...result.toVerify];
        for (const f of routed) {
            const origin = fs.find((o) => o.title === f.title);
            expect(origin).toBeDefined();
        }
        expect(result.keep.map((f) => f.title)).toContain('A');
        expect(result.toVerify.map((f) => f.title)).toContain('C');
    });

    it('an empty active set produces an empty partition', () => {
        const result = routeAll([], DEFAULT_CONSENSUS_CONFIG);
        expect(result.keep).toHaveLength(0);
        expect(result.downgraded).toHaveLength(0);
        expect(result.toVerify).toHaveLength(0);
        expect(result.suppressedCount).toBe(0);
    });
});
