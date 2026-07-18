/**
 * ContextBuilder — a PURE function turning `GraphData` + PR-scoped query
 * results into a bounded `GraphifyContext`.
 *
 * Guarantees (Requirements 4.4, 7.1–7.4, 11.2–11.3, 12.1/12.3/12.4; Properties
 * 2–5):
 * - `build` is pure/deterministic: no I/O, no Date/random. Identical inputs
 *   yield byte-identical `render()` output (Property 3, Requirement 7.3).
 * - `render()` assembles sections in PRIORITY order and stops adding
 *   lower-priority content once the running length would exceed `maxChars`,
 *   truncating mid-section if needed. `render().length <= maxChars` holds for
 *   ANY positive `maxChars`, including 1 (Property 4, Requirements 7.1/7.4).
 * - The highest-priority PR-scoped blast-radius summary is never dropped before
 *   the lower god-node / repo-total sections (Requirement 7.2).
 * - `render()` NEVER returns null/undefined — always a string (Property 2).
 * - `unavailableContext()` renders a short, valid, non-empty, concatenation-safe
 *   one-line string and yields a human-readable `reviewNotice()` (Property 5).
 */

import type {
	GraphData,
	AffectedResult,
	GraphifyContext,
	DegradationReason,
} from './types.js';

/** Stable header that every rendered context begins with (Requirement 7). */
const HEADER = '## Graphify AST Knowledge Graph';

/** One-line body used when there is no usable graph context. */
const UNAVAILABLE_BODY = '_Graph context unavailable._';

/** Cap the number of "top" dependents summarized per changed node (readability). */
const MAX_DEPENDENTS_PER_SUBJECT = 5;

/** Cap the number of god nodes summarized. */
const MAX_GOD_NODES = 10;

/**
 * Human-readable one-line notices per degradation reason (Requirement 12.1).
 * Bounded, single line, concatenation-safe.
 */
const NOTICE_BY_REASON: Record<DegradationReason, string> = {
	'missing-key':
		'Graph built from code only — documentation nodes were skipped (no semantic-extraction key).',
	timeout:
		'Graph context was unavailable for this review (extraction timed out); analysis proceeded without knowledge-graph blast radius.',
	'malformed-graph': 'Graph context was unavailable (could not read the knowledge graph).',
	'unexpected-error':
		'Graph context was unavailable (unexpected error building the knowledge graph).',
};

/** Hard-truncate to a positive bound, guaranteeing `result.length <= max`. */
function clamp(s: string, max: number): string {
	if (max <= 0) return '';
	if (!Number.isFinite(max)) return s;
	return s.length <= max ? s : s.slice(0, max);
}

/**
 * Build the ordered section list (highest priority first, excluding the stable
 * top-level header). Kept separate so ordering is easy to reason about.
 *
 *   1. PR-scoped blast radius (changed nodes → top dependents, each with its
 *      `[relation]`; confidence tag ONLY if the dependent already carries one —
 *      never fabricated; Requirements 11.2/11.3).
 *   2. God nodes.
 *   3. Repo totals (nodeCount, edgeCount, builtAtCommit).
 */
function buildSections(data: GraphData, affected: AffectedResult[]): string[] {
	const sections: string[] = [];

	// 1. PR-scoped blast radius (never dropped before lower sections — R7.2).
	const withDeps = affected.filter((a) => a.dependents.length > 0);
	if (withDeps.length > 0) {
		const lines: string[] = ['### PR-Scoped Blast Radius'];
		for (const a of withDeps) {
			lines.push(`- ${a.subject} (${a.matchCount} dependents):`);
			for (const d of a.dependents.slice(0, MAX_DEPENDENTS_PER_SUBJECT)) {
				// Confidence tag only when the dependent already carries one (R11.2).
				const conf = d.confidence ? ` {${d.confidence}}` : '';
				const loc = d.location ? ` ${d.location}` : '';
				lines.push(`    <- ${d.label} [${d.relation}]${loc}${conf}`);
			}
		}
		sections.push(lines.join('\n'));
	}

	// 2. God nodes.
	if (data.godNodes.length > 0) {
		const gods = data.godNodes
			.slice(0, MAX_GOD_NODES)
			.map((g) => `${g.label} (${g.degree} edges)`)
			.join(', ');
		sections.push(`### God Nodes (core abstractions)\n${gods}`);
	}

	// 3. Repo totals.
	const commit = data.builtAtCommit ? `\n- commit ${data.builtAtCommit}` : '';
	sections.push(`### Repo Totals\n- Nodes: ${data.nodeCount}\n- Edges: ${data.edgeCount}${commit}`);

	return sections;
}

class ConcreteContext implements GraphifyContext {
	constructor(
		readonly available: boolean,
		private readonly sections: string[],
		private readonly maxChars: number,
		readonly degradationReason?: DegradationReason
	) {}

	/**
	 * Serialize to the prompt string. Always begins with the stable header, then
	 * appends priority-ordered sections while they fit; the first section that
	 * would overflow is truncated mid-section to fill the remaining budget and no
	 * lower-priority sections are added. Output length <= maxChars always.
	 */
	render(): string {
		const max = this.maxChars;
		if (max <= 0) return '';

		// No usable sections → a short, valid, non-empty one-liner (R4.2–R4.4).
		if (this.sections.length === 0) {
			return clamp(`${HEADER}\n${UNAVAILABLE_BODY}`, max);
		}

		// Header always leads; if it alone fills the bound, stop there.
		let out = clamp(HEADER, max);
		if (out.length >= max) return out;

		for (const section of this.sections) {
			const candidate = `${out}\n\n${section}`;
			if (candidate.length <= max) {
				out = candidate;
			} else {
				// Truncate this (highest remaining priority) section to fill the
				// remaining space, then stop (Requirements 7.1/7.2/7.4).
				return clamp(candidate, max);
			}
		}
		return out;
	}

	/**
	 * One-line human-readable notice for the POSTED review when degraded (R12);
	 * `undefined` on the fully-available happy path (Requirement 12.3).
	 */
	reviewNotice(): string | undefined {
		if (!this.degradationReason) return undefined;
		return NOTICE_BY_REASON[this.degradationReason];
	}
}

/**
 * Pure builder: `GraphData` + PR-scoped `AffectedResult[]` → bounded context.
 * Identical inputs → identical output (Property 3, Requirement 7.3).
 *
 * @param graphData parsed graph (may be code-only / degraded but available).
 * @param affected  PR-scoped reverse-traversal results.
 * @param maxChars  any positive bound (including 1); no minimum floor (R7.1).
 * @param degradationReason optional — set when the (still available) graph is
 *   degraded (e.g. `missing-key` code-only build) so `reviewNotice()` surfaces
 *   it while `render()` still emits the usable graph content (Requirement 12.1).
 */
export function build(
	graphData: GraphData,
	affected: AffectedResult[],
	maxChars: number,
	degradationReason?: DegradationReason
): GraphifyContext {
	const sections = graphData.available ? buildSections(graphData, affected) : [];
	return new ConcreteContext(
		graphData.available,
		sections,
		maxChars,
		degradationReason
	);
}

/**
 * Factory for a degraded/unavailable context (no usable GraphData). Its
 * `render()` returns a short, valid, non-empty, concatenation-safe one-line
 * string and its `reviewNotice()` returns the human notice for `reason`
 * (Property 5, Requirements 4.2–4.5, 12.1/12.3/12.4).
 *
 * @param reason   why the graph is unavailable; defaults to `malformed-graph`.
 * @param maxChars optional bound; defaults to unbounded (the one-liner is short).
 */
export function unavailableContext(
	reason: DegradationReason = 'malformed-graph',
	maxChars: number = Number.POSITIVE_INFINITY
): GraphifyContext {
	return new ConcreteContext(false, [], maxChars, reason);
}
