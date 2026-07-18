/**
 * GraphifyIntegration — the orchestrator and sole public entry point.
 *
 * Chains ExtractionRunner → GraphParser → GraphQueryService → ContextBuilder,
 * wrapped in a single try/catch that guarantees a valid fallback context on any
 * unexpected error (R4.5). graphify is the authoritative blast-radius source;
 * tree-sitter remains the caller's fallback when the graph is unavailable (R8).
 *
 * Emits one structured log + tracer span with the run telemetry (R5).
 */

import { ensureGraph } from './extraction-runner.js';
import { parse } from './graph-parser.js';
import { blastRadius } from './query-service.js';
import { build, unavailableContext } from './context-builder.js';
import type { GraphifyResult, GraphifyTelemetry } from './types.js';
import type { SymbolInfo } from '../../types.js';
import { logger } from '../logger.js';
import { startSpan } from '../observability/tracer.js';

export type { GraphifyResult } from './types.js';

/**
 * Run the full graphify integration for one review.
 *
 * @param workDir     the cloned repo root
 * @param changedFiles PR changed file paths (repo-relative)
 * @param changedSymbols tree-sitter changed symbols (query-ranking seeds)
 * @param signal      abort signal propagated from the pipeline
 * @param maxChars    hard bound on the injected context size
 * @param budgetMs    wall-clock budget for extraction
 */
export async function run(
	workDir: string,
	changedFiles: string[],
	changedSymbols: SymbolInfo[],
	signal: AbortSignal | undefined,
	maxChars: number,
	budgetMs: number
): Promise<GraphifyResult> {
	const span = startSpan('graphify.run');

	try {
		const outcome = await ensureGraph(workDir, signal, budgetMs);
		const data = parse(outcome.graphDir); // never throws

		// Query only when we actually have a usable graph.
		const affected =
			outcome.ok && data.available
				? await blastRadius(outcome.graphDir, data, changedFiles, changedSymbols, signal)
				: [];

		// A degradation from extraction still surfaces in the notice/telemetry
		// even if we parsed a partial graph.
		const degradationReason = data.available ? outcome.degradationReason : (outcome.degradationReason ?? 'malformed-graph');

		const context = data.available
			? build(data, affected, maxChars, degradationReason)
			: unavailableContext(degradationReason ?? 'malformed-graph', maxChars);

		const totalMatches = affected.reduce((sum, a) => sum + a.matchCount, 0);
		const telemetry: GraphifyTelemetry = {
			nodeCount: data.nodeCount,
			edgeCount: data.edgeCount,
			godNodeCount: data.godNodes.length,
			mode: outcome.mode,
			durationMs: outcome.durationMs,
			queriedSymbols: affected.length,
			totalMatches,
			degradationReason,
		};

		emitTelemetry(span, telemetry);
		return { context, telemetry };
	} catch (err) {
		logger.error('graphify.run failed unexpectedly', err instanceof Error ? err : new Error(String(err)));
		const telemetry: GraphifyTelemetry = {
			nodeCount: 0,
			edgeCount: 0,
			godNodeCount: 0,
			mode: 'none',
			durationMs: 0,
			queriedSymbols: 0,
			totalMatches: 0,
			degradationReason: 'unexpected-error',
		};
		emitTelemetry(span, telemetry);
		return { context: unavailableContext('unexpected-error', maxChars), telemetry };
	} finally {
		try {
			span.end();
		} catch {
			/* noop span or already ended */
		}
	}
}

function emitTelemetry(
	span: { setAttribute?: (k: string, v: string | number | boolean) => void },
	t: GraphifyTelemetry
): void {
	logger.info('graphify.complete', {
		nodeCount: t.nodeCount,
		edgeCount: t.edgeCount,
		godNodeCount: t.godNodeCount,
		mode: t.mode,
		durationMs: t.durationMs,
		queriedSymbols: t.queriedSymbols,
		totalMatches: t.totalMatches,
		degradationReason: t.degradationReason ?? 'none',
	});
	if (span.setAttribute) {
		span.setAttribute('graphify.node_count', t.nodeCount);
		span.setAttribute('graphify.edge_count', t.edgeCount);
		span.setAttribute('graphify.god_node_count', t.godNodeCount);
		span.setAttribute('graphify.mode', t.mode);
		span.setAttribute('graphify.duration_ms', t.durationMs);
		span.setAttribute('graphify.queried_symbols', t.queriedSymbols);
		span.setAttribute('graphify.total_matches', t.totalMatches);
		span.setAttribute('graphify.degradation_reason', t.degradationReason ?? 'none');
	}
}
