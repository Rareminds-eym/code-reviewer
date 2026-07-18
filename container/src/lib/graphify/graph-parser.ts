/**
 * GraphParser — defensive reader for graphify 0.9.5 output.
 *
 * Reads `<graphDir>/graph.json` (networkx node-link) and the
 * `<graphDir>/.graphify_analysis.json` sidecar and projects them into the
 * typed, safe {@link GraphData} the rest of the pipeline consumes.
 *
 * Design contract ("GraphParser" section):
 *  - `edgeCount` comes from `links.length` (NEVER a phantom `edges` key).
 *  - `nodeCount` comes from `nodes.length`.
 *  - node identity/label comes from each node's `.label`.
 *  - `godNodes` come from the sidecar `gods[]`, coerced to {id,label,degree},
 *    skipping malformed entries. WHEN the sidecar is absent/unreadable (e.g. the
 *    code-only `graphify update` path emits no `.graphify_analysis.json`), god
 *    nodes are DERIVED deterministically from the graph's own `links` (top nodes
 *    by degree) so the god-node signal survives on the default path. Sidecar
 *    values, when present, take precedence (graphify's own selection is richer).
 *  - `builtAtCommit` comes from `built_at_commit` only when it is a string.
 *  - `nodesByFile` is keyed by a CANONICAL source_file (repo-root-relative,
 *    forward-slashed, leading `./` stripped) so the query service can match
 *    changed files.
 *
 * Property 1: this function NEVER throws for any input. Every field access is
 * guarded and all I/O is wrapped; on any missing/unreadable/malformed input it
 * returns an `available:false` empty {@link GraphData}.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.2.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GodNode, GraphData, RawGraphNode } from './types.js';

/**
 * How many god nodes to derive from graph structure when the analysis sidecar
 * is absent (the code-only `graphify update` path emits no sidecar). Matches the
 * ContextBuilder's `MAX_GOD_NODES` so nothing derived is wasted.
 */
const MAX_DERIVED_GOD_NODES = 10;

/** The empty, "unavailable" result returned on any failure (Requirement 4.2). */
function unavailable(): GraphData {
	return {
		available: false,
		nodeCount: 0,
		edgeCount: 0,
		godNodes: [],
		nodesByFile: new Map<string, RawGraphNode[]>(),
		builtAtCommit: undefined,
	};
}

/**
 * Normalize a source_file / changed-file path to graphify's canonical form:
 * repo-root-relative, forward-slashed, with any leading `./` stripped.
 *
 * Exported so the query service normalizes changed-file paths identically —
 * a mismatch would cause silent zero-result querying.
 */
export function canonicalizePath(raw: string): string {
	let p = raw.replace(/\\/g, '/');
	// Strip a single leading `./` (graphify emits no leading `./`).
	while (p.startsWith('./')) {
		p = p.slice(2);
	}
	return p;
}

/** Read + JSON.parse a file, returning `undefined` on any failure. */
function readJsonSafe(path: string): unknown {
	try {
		const raw = readFileSync(path, 'utf-8');
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** True when `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce one raw node into a {@link RawGraphNode}, or `undefined` when it lacks
 * a usable string `id`. `label`/`source_file` are optional strings.
 */
function coerceNode(entry: unknown): RawGraphNode | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}
	const id = entry.id;
	if (typeof id !== 'string') {
		return undefined;
	}
	const node: RawGraphNode = { id };
	if (typeof entry.label === 'string') {
		node.label = entry.label;
	}
	if (typeof entry.source_file === 'string') {
		node.source_file = entry.source_file;
	}
	return node;
}

/** Coerce one sidecar `gods[]` entry into a {@link GodNode}, or `undefined`. */
function coerceGodNode(entry: unknown): GodNode | undefined {
	if (!isRecord(entry)) {
		return undefined;
	}
	const { id, label, degree } = entry;
	if (typeof id !== 'string' || typeof label !== 'string' || typeof degree !== 'number') {
		return undefined;
	}
	return { id, label, degree };
}

/**
 * Build the canonical `source_file` → nodes index (Requirement 1.3). Nodes with
 * no `source_file` are simply not indexed by file.
 */
function buildNodesByFile(nodes: RawGraphNode[]): Map<string, RawGraphNode[]> {
	const byFile = new Map<string, RawGraphNode[]>();
	for (const node of nodes) {
		if (typeof node.source_file !== 'string' || node.source_file.length === 0) {
			continue;
		}
		const key = canonicalizePath(node.source_file);
		const bucket = byFile.get(key);
		if (bucket) {
			bucket.push(node);
		} else {
			byFile.set(key, [node]);
		}
	}
	return byFile;
}

/** Read the sidecar `gods[]`, coercing entries; empty when absent/malformed. */
function parseGodNodes(graphDir: string): GodNode[] {
	const sidecar = readJsonSafe(join(graphDir, '.graphify_analysis.json'));
	if (!isRecord(sidecar) || !Array.isArray(sidecar.gods)) {
		return [];
	}
	const gods: GodNode[] = [];
	for (const entry of sidecar.gods) {
		const god = coerceGodNode(entry);
		if (god) {
			gods.push(god);
		}
	}
	return gods;
}

/**
 * Derive god nodes from graph structure when the sidecar is unavailable.
 *
 * "God nodes" are the most-connected nodes; graphify's sidecar computes them,
 * but the code-only `graphify update` path writes no sidecar. We reproduce a
 * degree-based approximation from the raw `links` (undirected degree = count of
 * links where the node is `source` or `target`). Deterministic: sorted by degree
 * desc, then node id asc, so identical graphs always yield identical god nodes
 * (keeps the ContextBuilder pure/idempotent downstream).
 *
 * @param nodes coerced graph nodes (for id → label lookup)
 * @param links raw `graph.json` links array (each may carry `source`/`target`)
 */
function deriveGodNodes(nodes: RawGraphNode[], links: unknown[]): GodNode[] {
	const degree = new Map<string, number>();
	for (const link of links) {
		if (!isRecord(link)) continue;
		for (const endpoint of [link.source, link.target]) {
			if (typeof endpoint === 'string' && endpoint.length > 0) {
				degree.set(endpoint, (degree.get(endpoint) ?? 0) + 1);
			}
		}
	}
	if (degree.size === 0) return [];

	const labelById = new Map<string, string>();
	for (const node of nodes) {
		labelById.set(node.id, node.label ?? node.id);
	}

	return [...degree.entries()]
		.filter(([, d]) => d > 0)
		.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
		.slice(0, MAX_DERIVED_GOD_NODES)
		.map(([id, d]) => ({ id, label: labelById.get(id) ?? id, degree: d }));
}

/**
 * Parse a graphify graph directory into typed {@link GraphData}.
 *
 * @param graphDir directory containing `graph.json` (+ optional sidecar).
 * @returns a fully-populated {@link GraphData} on success, or an
 *          `available:false` empty result on any failure. Never throws.
 */
export function parse(graphDir: string): GraphData {
	try {
		const graph = readJsonSafe(join(graphDir, 'graph.json'));

		// available:true only when graph.json parsed as an object with a nodes array.
		if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
			return unavailable();
		}

		// Nodes → coerced RawGraphNode[] (skip malformed entries).
		const nodes: RawGraphNode[] = [];
		for (const entry of graph.nodes) {
			const node = coerceNode(entry);
			if (node) {
				nodes.push(node);
			}
		}

		// edgeCount from `links` — NEVER a phantom `edges` key (Requirement 1.1).
		const links = Array.isArray(graph.links) ? graph.links : [];
		const edgeCount = links.length;

		// nodeCount from the raw nodes array length (Requirement 1.2).
		const nodeCount = graph.nodes.length;

		// builtAtCommit only when it is a string (Requirement 1.5).
		const builtAtCommit = typeof graph.built_at_commit === 'string' ? graph.built_at_commit : undefined;

		// God nodes: sidecar `gods[]` is authoritative; fall back to a
		// degree-based derivation from `links` when the sidecar is absent (the
		// code-only `update` path writes none) so the signal survives (R1.4/1.6).
		const sidecarGods = parseGodNodes(graphDir);
		const godNodes = sidecarGods.length > 0 ? sidecarGods : deriveGodNodes(nodes, links);

		return {
			available: true,
			nodeCount,
			edgeCount,
			godNodes,
			nodesByFile: buildNodesByFile(nodes),
			builtAtCommit,
		};
	} catch {
		// Property 1: never throw — degrade to unavailable on any failure.
		return unavailable();
	}
}
