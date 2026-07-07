/**
 * Three-phase finding clustering engine.
 *
 * Groups ReviewFinding[] into semantically meaningful clusters
 * with dependency metadata. Pure TypeScript — zero external deps,
 * safe for V8 isolates.
 *
 * Pipeline:
 *   Phase 1: Category-File grouping   (deterministic)
 *   Phase 2: Similarity detection     (Jaccard on title tokens)
 *   Phase 3: Dependency detection     (cross-file reference scan)
 */

import type { ReviewFinding, FindingSeverity } from '../types/review';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/** Why findings were grouped into this cluster. */
export type GroupReason = 'category-file' | 'similar-pattern';

/** A cluster of related findings with optional dependency edges. */
export interface FindingCluster {
    /** Unique cluster identifier (e.g., "cluster-0"). */
    id: string;
    /** Human-readable label summarizing the cluster. */
    label: string;
    /** Why these findings were grouped. */
    groupReason: GroupReason;
    /** Highest severity in the cluster — used for sorting. */
    severity: FindingSeverity;
    /** Findings in this cluster. */
    findings: ReviewFinding[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Jaccard similarity threshold for merging clusters. */
const SIMILARITY_THRESHOLD = 0.6;

/** Severity sort order (lower = more severe). */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

// ---------------------------------------------------------------------------
// Utility: Text Tokenization & Similarity
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase word tokens.
 * Strips punctuation, splits on whitespace.
 */
function tokenize(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 1) // Drop single-char tokens
    );
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns 0.0–1.0 where 1.0 = identical.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1.0;
    if (a.size === 0 || b.size === 0) return 0.0;

    let intersection = 0;
    for (const token of a) {
        if (b.has(token)) intersection++;
    }

    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Get the highest (most severe) severity from a list of findings.
 */
function highestSeverity(findings: ReadonlyArray<ReviewFinding>): FindingSeverity {
    let best: FindingSeverity = 'low';
    for (const f of findings) {
        if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[best]) {
            best = f.severity;
        }
    }
    return best;
}

/**
 * Extract the directory path from a file path.
 * e.g., "src/features/auth/LoginForm.tsx" → "src/features/auth"
 */
function dirName(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
}

// ---------------------------------------------------------------------------
// Phase 1: Category-File Grouping (deterministic)
// ---------------------------------------------------------------------------

/**
 * Group findings that share the same `category` AND `file`.
 * This is the base clustering — always correct, no heuristics.
 */
function groupByCategoryFile(findings: ReviewFinding[]): Map<string, ReviewFinding[]> {
    const groups = new Map<string, ReviewFinding[]>();
    for (const f of findings) {
        const key = `${f.category}::${f.file}`;
        const group = groups.get(key);
        if (group) {
            group.push(f);
        } else {
            groups.set(key, [f]);
        }
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Phase 2: Similarity Detection (fuzzy)
// ---------------------------------------------------------------------------

interface ProtoCluster {
    key: string;
    findings: ReviewFinding[];
    titleTokens: Set<string>;
    category: string;
}

/**
 * Merge clusters with similar titles (Jaccard > threshold)
 * within the same category. Cross-category merging is not done
 * to avoid nonsensical groupings.
 */
function mergeSimilarClusters(groups: Map<string, ReviewFinding[]>): ProtoCluster[] {
    // Build proto-clusters with tokenized titles
    const protos: ProtoCluster[] = [];
    for (const [key, findings] of groups) {
        const category = key.split('::')[0];
        // Combine all titles in the group into one token set
        const combinedTokens = new Set<string>();
        for (const f of findings) {
            for (const t of tokenize(f.title)) {
                combinedTokens.add(t);
            }
        }
        protos.push({ key, findings, titleTokens: combinedTokens, category });
    }

    // Merge similar clusters (same category, Jaccard > threshold)
    const merged = new Set<number>(); // Indices that were merged into another
    for (let i = 0; i < protos.length; i++) {
        if (merged.has(i)) continue;
        for (let j = i + 1; j < protos.length; j++) {
            if (merged.has(j)) continue;
            if (protos[i].category !== protos[j].category) continue;

            const sim = jaccardSimilarity(protos[i].titleTokens, protos[j].titleTokens);
            if (sim >= SIMILARITY_THRESHOLD) {
                // Absorb j into i
                protos[i].findings.push(...protos[j].findings);
                for (const t of protos[j].titleTokens) {
                    protos[i].titleTokens.add(t);
                }
                merged.add(j);
            }
        }
    }

    return protos.filter((_, idx) => !merged.has(idx));
}

// ---------------------------------------------------------------------------
// Public API: clusterFindings()
// ---------------------------------------------------------------------------

/**
 * Cluster deduplicated findings into semantically meaningful groups
 * with dependency metadata.
 *
 * Pipeline:
 *   1. Group by category + file (deterministic)
 *   2. Merge similar clusters within same category (Jaccard ≥ 0.6)
 *   3. Detect inter-finding dependencies within each cluster
 *
 * All findings are assigned to exactly one cluster — singletons get
 * their own cluster of size 1 for uniform data model.
 *
 * Clusters are sorted by highest severity (critical first).
 */
export function clusterFindings(findings: ReviewFinding[]): FindingCluster[] {
    if (findings.length === 0) return [];

    // Phase 1: Category-File grouping
    const categoryFileGroups = groupByCategoryFile(findings);

    // Phase 2: Similarity merging
    const mergedProtos = mergeSimilarClusters(categoryFileGroups);

    // Phase 3: Build clusters (Dependency detection removed — handled by LLM)
    const clusters: FindingCluster[] = mergedProtos.map((proto, idx) => {
        const clusterFindings = proto.findings;

        // Determine group reason
        let groupReason: GroupReason = 'category-file';
        if (new Set(clusterFindings.map(f => f.file)).size > 1) {
            groupReason = 'similar-pattern';
        }

        // Generate a human-readable label
        const files = [...new Set(clusterFindings.map(f => f.file))];
        const category = proto.category;
        const label = files.length === 1
            ? `${category} issues in ${files[0]}`
            : `${category} pattern across ${files.length} files`;

        return {
            id: `cluster-${idx}`,
            label,
            groupReason,
            severity: highestSeverity(clusterFindings),
            findings: clusterFindings,
        };
    });

    // Sort clusters: highest severity first, then by finding count (more = more important)
    clusters.sort((a, b) => {
        const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return b.findings.length - a.findings.length;
    });

    // Re-assign sequential IDs after sorting
    for (let i = 0; i < clusters.length; i++) {
        clusters[i].id = `cluster-${i}`;
    }

    return clusters;
}

/**
 * Flatten clusters back to a findings array.
 * Useful when you need the raw list for counting or filtering.
 */
export function flattenClusters(clusters: ReadonlyArray<FindingCluster>): ReviewFinding[] {
    const result: ReviewFinding[] = [];
    for (const c of clusters) {
        result.push(...c.findings);
    }
    return result;
}
