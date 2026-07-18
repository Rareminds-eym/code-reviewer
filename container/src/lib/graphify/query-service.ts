/**
 * GraphQueryService — PR-scoped, read-only reverse-traversal over the graph.
 *
 * graphify `affected` requires a UNIQUE node match; bare labels (`Logger`,
 * `Env`, ...) fail with "No unique node match". So we resolve query subjects to
 * unique node IDs via `GraphData.nodesByFile[canonical(changedFile)]` (R2.2),
 * which is also language-agnostic (works for any file graphify indexed, not
 * just TS) (R2a). The tree-sitter `changedSymbols` are used ONLY to rank which
 * node IDs to query first (prefer nodes whose label matches a changed symbol).
 *
 * Paths are canonicalized on BOTH sides (repo-root-relative, forward-slashed,
 * leading `./` stripped) before matching against `parsed.nodesByFile` keys —
 * a mismatch would cause silent zero-result querying (R9.5).
 *
 * `affected` output carries NO confidence tag, so `confidence` is never set
 * here (R11.2). Never throws; per-query failures are isolated (R2.4).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.4, 9.5, 10.3, 11.2.
 */

import { execa } from 'execa';
import { join } from 'node:path';
import type { GraphData, AffectedResult, AffectedDependent } from './types.js';
import type { SymbolInfo } from '../../types.js';
import { canonicalizePath } from './graph-parser.js';

/** Safety bound: cap how many node IDs we query per PR (subprocess per call). */
const MAX_QUERIED_NODES = 25;
/** Per-query subprocess timeout (each `affected` call is ~0.2s in practice). */
const PER_QUERY_TIMEOUT_MS = 8_000;
/**
 * Aggregate wall-clock budget for the whole query phase. Even though each
 * `affected` call is normally ~0.2s, a degenerate case (cold/large graph, a
 * hung invocation) could otherwise stack up to MAX_QUERIED_NODES ×
 * PER_QUERY_TIMEOUT_MS. Once this budget is exceeded we stop launching new
 * queries and return what we have — the ContextBuilder degrades gracefully.
 */
const QUERY_PHASE_BUDGET_MS = 30_000;

// Path canonicalization is owned by the parser (`canonicalizePath`) so that
// `changedFiles` line up with `parsed.nodesByFile` keys (e.g. `./pkg/x.ts` ≡
// `pkg/x.ts`) — a single source of truth avoids silent zero-result querying.

/** Parse `graphify affected` stdout lines: `- <label> [<relation>] <loc>`. */
export function parseAffectedOutput(stdout: string): AffectedDependent[] {
	const deps: AffectedDependent[] = [];
	for (const raw of stdout.split('\n')) {
		const line = raw.trim();
		if (!line.startsWith('- ')) continue;
		const m = line.match(/^- (.+?) \[([^\]]+)\](?:\s+(.*))?$/);
		if (!m) continue;
		deps.push({
			label: m[1].trim(),
			relation: m[2].trim(),
			location: m[3]?.trim() || undefined,
			// `affected` output has NO confidence tag — do not populate (R11.2).
		});
	}
	return deps;
}

/**
 * Resolve which unique node IDs to query, from changed files → graph nodes.
 *
 * Ordering: nodes whose label matches a changed symbol name are queried first;
 * within that, files that had changed symbols come before files that did not.
 * Capped at {@link MAX_QUERIED_NODES}.
 */
export function resolveNodeIds(
	parsed: GraphData,
	changedFiles: string[],
	changedSymbols: SymbolInfo[]
): string[] {
	const changedFileSet = new Set(changedFiles.map(canonicalizePath));
	const rankedFiles = new Set(changedSymbols.map((s) => canonicalizePath(s.file)));
	const symbolNames = new Set(changedSymbols.map((s) => s.name));

	// Files that had changed symbols first, then the rest (stable within group).
	const orderedFiles = [
		...[...changedFileSet].filter((f) => rankedFiles.has(f)),
		...[...changedFileSet].filter((f) => !rankedFiles.has(f)),
	];

	const collected: Array<{ id: string; matchesSymbol: boolean }> = [];
	const seen = new Set<string>();
	for (const file of orderedFiles) {
		const nodes = parsed.nodesByFile.get(file);
		if (!nodes) continue;
		for (const n of nodes) {
			if (seen.has(n.id)) continue;
			seen.add(n.id);
			collected.push({
				id: n.id,
				matchesSymbol: n.label !== undefined && symbolNames.has(n.label),
			});
		}
	}

	// Prefer symbol-matching node IDs first, preserving the file-based order.
	const ranked = [
		...collected.filter((c) => c.matchesSymbol),
		...collected.filter((c) => !c.matchesSymbol),
	].map((c) => c.id);

	return ranked.slice(0, MAX_QUERIED_NODES);
}

/**
 * Compute PR-scoped blast radius. Never throws; per-query failures are isolated
 * and skipped so one bad query never aborts the batch (R2.4).
 *
 * Returns `[]` when no node IDs resolve for any changed file — the
 * ContextBuilder then emits a repo-level summary only (R2.5).
 *
 * @param graphDir       directory holding `graph.json`
 * @param parsed         parsed GraphData (used to resolve node IDs by file)
 * @param changedFiles   PR changed file paths (any path shape; canonicalized here)
 * @param changedSymbols tree-sitter changed symbols (query-ranking seeds only)
 * @param signal         abort signal propagated from the pipeline
 */
export async function blastRadius(
	graphDir: string,
	parsed: GraphData,
	changedFiles: string[],
	changedSymbols: SymbolInfo[],
	signal?: AbortSignal,
	queryBudgetMs: number = QUERY_PHASE_BUDGET_MS
): Promise<AffectedResult[]> {
	try {
		const nodeIds = resolveNodeIds(parsed, changedFiles, changedSymbols);
		if (nodeIds.length === 0) return []; // repo-level summary path (R2.5)

		const graphPath = join(graphDir, 'graph.json');
		const results: AffectedResult[] = [];
		const deadline = Date.now() + queryBudgetMs;

		for (const id of nodeIds) {
			// Aggregate budget + abort guard: stop launching new queries once the
			// query phase has spent its wall-clock budget (or the review aborted).
			if (Date.now() >= deadline || signal?.aborted) break;
			try {
				const res = await execa(
					'graphify',
					['affected', id, '--depth', '2', '--graph', graphPath],
					{ timeout: PER_QUERY_TIMEOUT_MS, cancelSignal: signal, reject: false }
				);
				if (res.exitCode !== 0) {
					// e.g. "No unique node match" — record zero-result, continue (R2.4).
					results.push({ subject: id, matchCount: 0, dependents: [] });
					continue;
				}
				const dependents = parseAffectedOutput(res.stdout ?? '');
				results.push({ subject: id, matchCount: dependents.length, dependents });
			} catch {
				// Per-query failure is recorded and skipped, never fatal (R2.4).
				results.push({ subject: id, matchCount: 0, dependents: [] });
			}
		}
		return results;
	} catch {
		// Never throw to the caller.
		return [];
	}
}
