import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { build, unavailableContext } from '../../src/lib/graphify/context-builder.js';
import type { GraphData, AffectedResult, DegradationReason } from '../../src/lib/graphify/types.js';

const REASONS: DegradationReason[] = ['missing-key', 'timeout', 'malformed-graph', 'unexpected-error'];

function graphData(over: Partial<GraphData> = {}): GraphData {
	return {
		nodeCount: 10,
		edgeCount: 20,
		godNodes: [{ id: 'a', label: 'foo()', degree: 5 }],
		builtAtCommit: 'abc123',
		nodesByFile: new Map(),
		available: true,
		...over,
	};
}

const affected: AffectedResult[] = [
	{
		subject: 'pkg_top_x',
		matchCount: 2,
		dependents: [
			{ label: 'x', relation: 'calls', location: 'pkg/top.ts:L2' },
			{ label: 'top.ts', relation: 'imports', location: 'pkg/top.ts:L1' },
		],
	},
];

describe('ContextBuilder', () => {
	it('renders blast radius, god nodes, and totals on the happy path', () => {
		const out = build(graphData(), affected, 5000).render();
		expect(out).toContain('Blast Radius');
		expect(out).toContain('pkg_top_x');
		expect(out).toContain('God Nodes');
		expect(out).toContain('Edges: 20');
		expect(out).toContain('commit abc123');
	});

	it('prioritises blast radius: a tight bound keeps it and drops totals', () => {
		const brOnly = build(graphData(), affected, 200).render();
		expect(brOnly).toContain('Blast Radius');
		// Lower-priority "Knowledge Graph" totals section should be dropped first.
		expect(brOnly).not.toContain('- Nodes:');
	});

	it('reviewNotice: undefined on success, defined per degradation reason', () => {
		expect(build(graphData(), affected, 5000).reviewNotice()).toBeUndefined();
		for (const r of REASONS) {
			const notice = unavailableContext(r, 5000).reviewNotice();
			expect(notice).toBeTypeOf('string');
			expect(notice!.length).toBeGreaterThan(0);
		}
	});

	it('unavailable context still renders a valid non-empty string', () => {
		for (const r of REASONS) {
			const out = unavailableContext(r, 500).render();
			expect(out.length).toBeGreaterThan(0);
			expect(out).toContain('unavailable');
		}
	});

	// Property 2: totality — non-null string for every input.
	it('Property 2: render() always returns a string', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 10 }),
				fc.integer({ min: 1, max: 10000 }),
				(nGods, max) => {
					const data = graphData({
						godNodes: Array.from({ length: nGods }, (_, i) => ({ id: `g${i}`, label: `n${i}()`, degree: i })),
					});
					const out = build(data, affected, max).render();
					expect(typeof out).toBe('string');
				}
			),
			{ numRuns: 100 }
		);
	});

	// Property 3: purity / idempotence.
	it('Property 3: identical inputs produce identical output', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 8000 }), (max) => {
				const a = build(graphData(), affected, max).render();
				const b = build(graphData(), affected, max).render();
				expect(a).toBe(b);
			}),
			{ numRuns: 100 }
		);
	});

	// Property 4: bounded output for ANY positive bound including 1.
	it('Property 4: render().length <= maxChars for any positive bound', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 20000 }), (max) => {
				const out = build(graphData(), affected, max).render();
				expect(out.length).toBeLessThanOrEqual(max);
			}),
			{ numRuns: 200 }
		);
	});

	it('Property 4: holds at the extreme bound of 1', () => {
		expect(build(graphData(), affected, 1).render().length).toBeLessThanOrEqual(1);
		expect(unavailableContext('timeout', 1).render().length).toBeLessThanOrEqual(1);
	});

	// Property 5: fallback validity — concatenation-safe non-empty string.
	it('Property 5: degraded contexts concatenate safely at injection points', () => {
		for (const r of REASONS) {
			const ctx = unavailableContext(r, 2000);
			const rendered = ctx.render();
			// Simulates the map-phase concatenation onto blast-radius text.
			const combined = `## Container Blast Radius Analysis\n...` + rendered;
			expect(combined.endsWith(rendered)).toBe(true);
			expect(rendered.length).toBeGreaterThan(0);
		}
	});
});
