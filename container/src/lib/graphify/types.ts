/**
 * Shared types for the Graphify integration module.
 *
 * These model the subset of graphify 0.9.5 outputs the pipeline relies on
 * (networkx node-link `graph.json` + the `.graphify_analysis.json` sidecar)
 * plus the internal representations produced by each component.
 *
 * Requirements: 1.7 (only real graphify keys), 6.4 (structured context).
 */

/** A highly-connected node from `.graphify_analysis.json` → `gods[]`. */
export interface GodNode {
	id: string;
	label: string;
	degree: number;
}

/**
 * The subset of a networkx node-link node we rely on. graphify emits many more
 * fields (community, norm_label, ...) which we intentionally ignore.
 */
export interface RawGraphNode {
	id: string;
	label?: string;
	source_file?: string;
}

/**
 * Typed, safe representation parsed from `graph.json` + the analysis sidecar.
 * Produced by the GraphParser; never contains raw `any`.
 */
export interface GraphData {
	/** `nodes.length` (Requirement 1.2). */
	nodeCount: number;
	/** `links.length` — NOT a phantom `edges` key (Requirement 1.1). */
	edgeCount: number;
	/** From the sidecar `gods[]` — NOT `graph.json.godNodes` (Requirement 1.4). */
	godNodes: GodNode[];
	/** `built_at_commit` when present (Requirement 1.5). */
	builtAtCommit?: string;
	/**
	 * Canonical (repo-root-relative, forward-slashed, no leading `./`)
	 * source_file → nodes index, for mapping changed files to node IDs.
	 */
	nodesByFile: Map<string, RawGraphNode[]>;
	/** false when graph.json is missing/unreadable/malformed (Requirement 4.2). */
	available: boolean;
}

/** Result of one reverse-traversal (`graphify affected`) query for a node. */
export interface AffectedDependent {
	label: string;
	/** calls | imports | references | inherits | ... */
	relation: string;
	location?: string;
	/**
	 * Only populated when the optional `explain` pass ran — `affected` output
	 * does NOT carry confidence tags (Requirement 11.2).
	 */
	confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

export interface AffectedResult {
	/** The unique node ID queried (never a bare, possibly-ambiguous label). */
	subject: string;
	/** Number of dependents returned (Requirement 5.2). */
	matchCount: number;
	dependents: AffectedDependent[];
}

/** Why the integration produced degraded output, for observability + notice. */
export type DegradationReason =
	| 'missing-key' // docs need a semantic key that is absent
	| 'timeout' // exceeded the Time_Budget / aborted
	| 'malformed-graph' // graph.json unreadable/invalid
	| 'unexpected-error'; // any uncaught failure

/** Outcome of an extraction/update run, for control flow + telemetry. */
export interface ExtractionOutcome {
	ok: boolean;
	mode: 'full' | 'incremental' | 'none';
	/** Directory (outside the cloned repo) holding graph.json + sidecar. */
	graphDir: string;
	durationMs: number;
	degradationReason?: DegradationReason;
}

/**
 * Structured graph context (Requirement 6.4 allows structured data).
 * `render()` serializes it to the string consumed at both prompt-injection
 * points; `reviewNotice()` yields the human-facing failure notice (R12).
 */
export interface GraphifyContext {
	readonly available: boolean;
	readonly degradationReason?: DegradationReason;
	/** Pure, bounded serialization to the prompt string (Requirement 7). */
	render(): string;
	/**
	 * Concise one-line notice for the POSTED review when degraded (R12).
	 * Returns `undefined` when extraction + querying fully succeeded, so no
	 * notice is added on the happy path (Requirement 12.3).
	 */
	reviewNotice(): string | undefined;
}

/** Telemetry emitted once per run (Requirement 5). */
export interface GraphifyTelemetry {
	nodeCount: number;
	edgeCount: number;
	godNodeCount: number;
	mode: ExtractionOutcome['mode'];
	durationMs: number;
	queriedSymbols: number;
	totalMatches: number;
	degradationReason?: DegradationReason;
}

/** What GraphifyIntegration.run() returns to the pipeline. */
export interface GraphifyResult {
	context: GraphifyContext;
	telemetry: GraphifyTelemetry;
}
