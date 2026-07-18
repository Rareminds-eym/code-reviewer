# Requirements Document

## Introduction

This feature is an industrial-grade overhaul of how the `graphify` knowledge-graph CLI is integrated into the AI code-review pipeline. Today the integration lives only in `runGraphifyIndexing(workDir, signal)` in `container/src/pipeline.ts`. It shells out to `graphify . --output <workDir>/graphify-out`, reads `graph.json`, and builds a context string that is injected into (a) the map-phase chunk prompts via `containerBlastRadiusText` → `buildReviewChunks`, and (b) the dual-agent Stage-1 persona prompts via `runStage1Review` → `buildStage1SystemPrompt`.

The current integration is decorative rather than functional:

- It reads `graphJson.edges` (always `0` — the real key is `links`), `graphJson.metadata.changedFiles` (no such key exists), and `graphJson.godNodes[].name` (god nodes live in the sidecar `.graphify_analysis.json` under `gods`, and nodes use `.label` not `.name`). Net effect: only total node count is ever real; edges, changed files, and god nodes are always `0`/blank.
- It re-extracts the whole repo from scratch on every PR, never using `graphify update` incremental mode.
- It hard-fails and discards all graph context when a docs/markdown repo has no `GEMINI_API_KEY`.
- It never queries the graph (`graphify query`, `graphify affected`, `graphify explain`, `graphify path`), so context is whole-repo scoped rather than PR-scoped.
- It duplicates blast-radius logic already available (more accurately) from `graphify affected`, via the hand-rolled tree-sitter `buildBlastRadius` in `container/src/ast-graph.ts`.

The overhaul makes the graph a first-class, PR-scoped, queried capability that measurably improves review quality: correct parsing, focused querying around changed files and their true blast radius, incremental extraction for speed, graceful degradation so no failure mode wipes out a review, and observability so the graph's contribution is measurable. All changes preserve the two existing prompt-injection points.

This document describes WHAT the overhauled integration must do. Implementation choices (module boundaries, exact command flags, prompt wording) are deferred to the design phase.

## Glossary

- **Graphify_Integration**: The overall subsystem inside the review container responsible for producing knowledge-graph context and injecting it into review prompts. Successor to the current `runGraphifyIndexing` function.
- **Graph_Parser**: The component that reads and interprets `graph.json` and the `.graphify_analysis.json` sidecar into a typed internal representation.
- **Graph_Data**: The typed internal representation produced by the Graph_Parser (node count, link/edge count, god nodes, build commit, and any changed-file metadata).
- **Analysis_Sidecar**: The file `.graphify_analysis.json` emitted by graphify alongside `graph.json`, containing `gods` (each entry `{id, label, degree}`), communities, cohesion, and related analytics.
- **Graph_Json**: The `graphify-out/graph.json` file, a networkx node-link document whose top-level keys are `directed`, `multigraph`, `graph`, `nodes`, `links`, `hyperedges`, `built_at_commit`. Nodes carry a `label` field.
- **Extraction_Runner**: The component that invokes the graphify CLI to produce or update the graph (full extraction or incremental `update`).
- **Graph_Query_Service**: The component that runs read-only graphify subcommands (`query`, `affected`, `explain`, `path`) against an existing graph to retrieve PR-scoped subgraphs.
- **Context_Builder**: The pure function that transforms Graph_Data and query results into the `graphifyContext` string injected into prompts.
- **Graphify_Context**: The string produced by the Context_Builder and consumed at the two injection points.
- **Map_Phase_Injection_Point**: The concatenation of Graphify_Context onto `containerBlastRadiusText`, which feeds `buildReviewChunks`.
- **Stage1_Injection_Point**: The `graphifyContext` argument passed to `runStage1Review` and concatenated in `buildStage1SystemPrompt` for the architect/sre/security personas.
- **Changed_Files**: The set of file paths modified by the pull request under review.
- **Blast_Radius**: The set of files and symbols reachable via reverse dependency traversal from the Changed_Files (i.e. what the change could affect).
- **Time_Budget**: The per-review wall-clock allowance the container must respect, coordinated with the CheckRun heartbeat mechanism.
- **Semantic_Extraction_Key**: An LLM API key (e.g. `GEMINI_API_KEY`) required by graphify only when semantic extraction of non-code files (docs/markdown) is needed.
- **Tree_Sitter_Blast_Radius**: The existing hand-rolled reverse-dependency analysis in `container/src/ast-graph.ts` (`buildBlastRadius`).

## Requirements

### Requirement 1: Correct parsing of graphify outputs

**User Story:** As a review pipeline maintainer, I want graphify outputs parsed against their actual schema, so that real graph facts (edges, god nodes, commit) reach the reviewer instead of always-zero placeholders.

#### Acceptance Criteria

1. WHEN Graph_Json is read, THE Graph_Parser SHALL derive the edge count from the `links` array length.
2. WHEN Graph_Json is read, THE Graph_Parser SHALL derive the node count from the `nodes` array length.
3. WHEN a node label is required, THE Graph_Parser SHALL read the node `label` field.
4. WHEN the Analysis_Sidecar is present, THE Graph_Parser SHALL derive god nodes from the `gods` array, using each entry's `label` and `degree`.
5. WHEN Graph_Json contains a `built_at_commit` value, THE Graph_Parser SHALL include that commit identifier in Graph_Data.
6. IF the Analysis_Sidecar is absent or unreadable (as on the code-only `graphify update` path, which emits no sidecar), THEN THE Graph_Parser SHALL derive god nodes deterministically from the graph's own `links` (top nodes by degree) and SHALL continue processing the remaining graph fields; the derivation SHALL yield an empty god-node set only when there are no links. Sidecar `gods`, when present, take precedence over the derivation.
7. THE Graph_Parser SHALL populate Graph_Data using only keys that exist in graphify 0.9.5 outputs (`nodes`, `links`, `built_at_commit`, and sidecar `gods`).

### Requirement 2: PR-scoped graph querying

**User Story:** As a code reviewer, I want graph context focused on the files and symbols the PR actually changes, so that the injected context is relevant rather than whole-repo noise.

#### Acceptance Criteria

1. WHEN an extracted graph is available and Changed_Files is non-empty, THE Graph_Query_Service SHALL query the graph for the Blast_Radius of the Changed_Files using graphify's reverse-traversal capability.
2. WHERE a changed symbol is identifiable in the graph, THE Graph_Query_Service SHALL retrieve the affected dependents of that symbol by its unique node identifier rather than by its bare label, so that symbols with duplicate labels (e.g. `Logger`, `Env`) resolve to a unique node.
2a. WHEN mapping Changed_Files to query subjects, THE Graph_Query_Service SHALL derive candidate node identifiers from the parsed graph nodes indexed by `source_file`, so that query seeding is language-agnostic and not limited to the tree-sitter symbol extractor's supported languages.
3. THE Graph_Query_Service SHALL scope retrieved results to the Changed_Files and their Blast_Radius rather than the entire repository.
4. IF a graph query returns no matching nodes for a changed file, THEN THE Graph_Query_Service SHALL record a zero-result outcome for that file and SHALL continue querying the remaining Changed_Files.
5. WHEN Changed_Files is empty, THE Graph_Query_Service SHALL skip PR-scoped querying and THE Context_Builder SHALL produce repository-level summary context.
6. THE Graph_Query_Service SHALL execute only read-only graphify subcommands (`query`, `affected`, `explain`, `path`) against the existing graph.

### Requirement 3: Incremental extraction within the time budget

**User Story:** As a pipeline operator, I want graphify to update an existing graph incrementally when possible, so that indexing stays within the per-review time budget.

#### Acceptance Criteria

1. THE Extraction_Runner SHALL use `graphify update <workDir>` on the default (code-only) path and `graphify extract <workDir> --out <parent> --backend <b>` only on the semantic opt-in path. RATIONALE (verified against graphify 0.9.5): `graphify extract` hard-fails (exit 1, no graph written) when the repo contains any doc/paper/image file and no LLM key is set — nearly every real repo — and has no code-only/skip-docs flag. `graphify update` is the documented headless no-LLM code-only command and succeeds with docs present and no key; it writes in-repo (no `--out`), so the Extraction_Runner SHALL delete any pre-existing `<workDir>/graphify-out` first to avoid updating against a committed/stale/foreign graph (Requirement 3.8b). Cross-review incremental caching is out of scope (ephemeral containers), so the default path rebuilds cleanly each run.
2. WHERE no previously extracted graph exists, THE Extraction_Runner SHALL perform a full extraction (using the headless command form per Requirement 9.1).
3. THE Extraction_Runner SHALL be able to run extraction without a Semantic_Extraction_Key (code-only), incurring no key requirement on the default path.
4. IF an extraction or update does not complete within the configured Time_Budget, THEN THE Extraction_Runner SHALL terminate the graphify process and THE Graphify_Integration SHALL proceed using any graph produced by a prior successful run or the fallback path of Requirement 4.
5. WHILE an extraction or update is running, THE Graphify_Integration SHALL allow the CheckRun heartbeat mechanism to continue reporting progress.
6. WHEN an extraction or update completes successfully within the Time_Budget, THE Extraction_Runner SHALL use the newly extracted graph immediately for subsequent parsing and querying.
7. WHEN extraction mode is selected, THE Extraction_Runner SHALL first check whether a previously extracted graph exists for the repository and SHALL choose incremental update mode or full extraction based on that check.
8. WHEN a full extraction runs, THE Extraction_Runner SHALL default to code-only offline extraction (no backend), and SHALL only enable semantic extraction of non-code files WHERE an explicit opt-in is configured AND a Semantic_Extraction_Key is present, so that the default path incurs no container-egress dependency and no untracked LLM cost.
8a. WHEN semantic doc extraction is not enabled, THE Extraction_Runner SHALL produce a code-only graph rather than hanging on or failing over non-code files.
8b. THE Extraction_Runner SHALL write graphify output to a location outside the cloned repository tree, so that a repository-committed `graphify-out/` never causes incremental update against a foreign or stale graph, and so graphify never indexes its own prior output.
9. THE Extraction_Runner SHALL NOT pass flags that the `graphify extract` command does not accept (e.g. `--no-viz`, `--directed`); `extract` produces no visualization/HTML output, so none needs disabling. (The headless-invocation-form requirement itself is stated once in Requirement 9.1.)
10. THE Extraction_Runner SHALL invoke a graphify version pinned to the schema the Graph_Parser expects, and the container image SHALL install that pinned version rather than an unpinned latest.

### Requirement 4: Graceful degradation and fallback

**User Story:** As a PR author, I want my review to complete even when graphify fails, so that a graph problem never blocks or empties my code review.

#### Acceptance Criteria

1. IF graphify exits non-zero because a Semantic_Extraction_Key is required for docs/markdown, THEN THE Graphify_Integration SHALL retain any code-only graph produced and SHALL continue the review with best-effort context.
2. IF Graph_Json is missing, unreadable, or malformed, THEN THE Context_Builder SHALL return a valid non-null Graphify_Context string describing that graph context is unavailable.
3. IF graphify execution exceeds the Time_Budget or is aborted via the abort signal, THEN THE Graphify_Integration SHALL return a valid non-null Graphify_Context string and SHALL allow the review to continue.
4. THE Context_Builder SHALL return a non-null string for every input, including empty, partial, or degenerate Graph_Data.
5. IF any step of the Graphify_Integration raises an unexpected error, THEN THE Graphify_Integration SHALL catch the error, log a diagnostic message, and return a valid fallback Graphify_Context string.

### Requirement 5: Observability of graph contribution

**User Story:** As a pipeline maintainer, I want to see what graphify contributed to each review, so that I can measure its value and diagnose regressions.

#### Acceptance Criteria

1. WHEN extraction completes, THE Graphify_Integration SHALL log the node count, edge count, and god-node count derived from Graph_Data.
2. WHEN a PR-scoped query completes, THE Graphify_Integration SHALL log the query subject and the number of matching nodes returned.
3. WHEN extraction or update finishes, THE Graphify_Integration SHALL log the elapsed extraction duration in milliseconds.
4. WHEN an extraction mode is selected, THE Graphify_Integration SHALL log whether full extraction or incremental update was used.
5. IF a fallback path is taken, THEN THE Graphify_Integration SHALL log the specific degradation reason (missing key, timeout, malformed graph, or unexpected error).

### Requirement 6: Backward-compatible prompt injection

**User Story:** As a maintainer of the review prompts, I want the overhauled integration to keep feeding the existing injection points, so that the map-phase and Stage-1 reviews continue to receive graph context without prompt-wiring changes.

#### Acceptance Criteria

1. THE Graphify_Integration SHALL expose Graphify_Context in the form consumed at the Map_Phase_Injection_Point (appended to `containerBlastRadiusText` feeding `buildReviewChunks`).
2. WHERE dual-agent Stage-1 review is enabled (deepReview or `ENABLE_DUAL_AGENT=true`), THE Graphify_Integration SHALL supply Graphify_Context as the `graphifyContext` argument to `runStage1Review`.
3. WHEN Graphify_Context is empty or a fallback string, THE Map_Phase_Injection_Point and Stage1_Injection_Point SHALL each still receive a valid string that does not break prompt assembly.
4. WHERE the integration produces structured context (multiple components or structured data), THE Graphify_Integration SHALL update the concatenation logic at each injection point to serialize and assemble that structured context into the string form the prompts consume, such that the end result at each injection point remains a valid string compatible with the concatenation in `buildStage1SystemPrompt` and does not break prompt assembly (consistent with 6.3).

### Requirement 7: Bounded context size

**User Story:** As a reviewer working within model context limits, I want the injected graph context to be size-bounded, so that PR-scoped insight does not crowd out the diff or blow the prompt budget.

#### Acceptance Criteria

1. THE Context_Builder SHALL produce a Graphify_Context whose length does not exceed a configured maximum character bound, WHERE the configured maximum character bound MAY be any positive value, including extremely low values such as 1 character, and no minimum-usefulness floor is enforced.
2. WHERE retrieved query results would exceed the maximum character bound, THE Context_Builder SHALL truncate lower-priority content while preserving the PR-scoped Blast_Radius summary.
3. THE Context_Builder SHALL be a pure function of its inputs, producing identical output for identical Graph_Data and query results.
4. WHILE the configured maximum character bound is any positive value, THE Context_Builder SHALL honor the bound by truncating per 7.2 so that the produced Graphify_Context length does not exceed that bound.

### Requirement 8: Relationship to the existing tree-sitter blast radius

**User Story:** As an architect, I want a decided relationship between the tree-sitter blast radius and graphify's affected analysis, so that the pipeline does not maintain two overlapping, divergent implementations.

#### Acceptance Criteria

1. THE Graphify_Integration SHALL treat graphify's affected/blast-radius output as the authoritative Blast_Radius source when an extracted graph is available, and SHALL NOT run the expensive tree-sitter reverse-dependency scan in that case.
2. IF graphify blast-radius results are unavailable (any degradation reason), THEN THE Graphify_Integration SHALL fall back to the Tree_Sitter_Blast_Radius (`buildBlastRadius`).
3. THE cheap tree-sitter changed-symbol extraction (parse only the changed files) SHALL run on every review to seed/rank graphify queries and summarize the PR, independent of the expensive reverse-dependency scan.
4. THE design phase SHALL record the decision of whether the Tree_Sitter_Blast_Radius is retained as a fallback or removed, with rationale.

### Requirement 9: Correct headless invocation and backend selection

**User Story:** As a pipeline operator, I want graphify invoked the way its documentation prescribes for non-interactive/CI use, so that extraction is reliable and not dependent on an IDE model session.

#### Acceptance Criteria

1. THE Extraction_Runner SHALL use the documented headless extraction command form for a non-interactive environment (the `graphify extract` / `graphify update` family), not the interactive IDE-skill invocation. (This is the single canonical statement of the invocation-form rule; Requirements 3.2 and 3.9 defer to it.)
2. THE Extraction_Runner SHALL apply the backend policy defined in Requirement 3.8 (code-only by default; an explicit backend only when semantic-doc extraction is opted in and a Semantic_Extraction_Key is present) — not restated here.
3. WHEN semantic doc extraction is not enabled or no Semantic_Extraction_Key is present, THE Extraction_Runner SHALL proceed code-only per Requirements 3.8a and 4.1, without hanging on non-code files.
4. THE Extraction_Runner SHALL run read-only query subcommands against `graph.json` using an explicit graph path argument.
5. THE Graph_Query_Service SHALL canonicalize file paths (repo-root-relative, forward-slashed, no leading `./`) on both the Changed_Files side and the parsed `source_file` side before matching, so PR-scoped lookups do not silently miss due to path-format differences.

### Requirement 10: Evaluate and, where feasible, adopt graphify's native PR-impact capability

**User Story:** As an architect, I want a decision on whether to use graphify's built-in PR-impact/graph-impact features instead of a hand-rolled blast radius, so that the pipeline uses the tool's purpose-built capability rather than duplicating it.

#### Acceptance Criteria

1. THE design phase SHALL evaluate graphify's native PR-impact features (e.g. `graphify prs` graph impact and the MCP `get_pr_impact` tool) against the webhook-driven container model.
2. THE design phase SHALL record a decision to adopt, partially adopt, or decline the native PR-impact capability, WITH rationale covering its runtime prerequisites (local git / `gh` state, MCP server lifecycle) versus the container's inputs.
3. WHERE the native PR-impact capability is not adopted, THE Graph_Query_Service SHALL achieve equivalent PR-scoped blast radius via reverse-traversal queries (Requirement 2).

### Requirement 11: Directionality and confidence signal

**User Story:** As a code reviewer, I want blast-radius direction and edge-confidence to reach the reviewer, so that "what calls what" is accurate and graph claims are weighted by how they were derived.

#### Acceptance Criteria

1. WHERE call/dependency direction affects blast-radius interpretation, THE Graph_Query_Service SHALL obtain directional dependents from the reverse-traversal query output (`affected`), which reports the relation and direction of each dependent; directionality is NOT configured at graph-build time (the headless `extract` command has no direction flag).
2. WHERE a confidence tag (`EXTRACTED`, `INFERRED`, or `AMBIGUOUS`) is available for a relationship, THE Context_Builder MAY include that tag in the Graphify_Context so reviewers can weight graph-derived claims. Because reverse-traversal (`affected`) output omits confidence tags, this is optional and, when enabled, sourced from a targeted `explain` query on the highest-priority nodes only.
3. THE inclusion of confidence tags SHALL remain subject to the bounded-size rule of Requirement 7.

### Requirement 12: Surface graphify failures in the posted review

**User Story:** As a PR author, I want to be told in the review itself when graph context was degraded or unavailable, so that I know the review ran with reduced graph insight rather than silently assuming full coverage.

#### Acceptance Criteria

1. WHEN the Graphify_Integration takes any degradation path (missing key, timeout, malformed graph, unexpected error, or graph unavailable), THE Graphify_Integration SHALL expose a concise human-readable notice describing what degraded and the consequence for the review.
2. WHEN a degradation notice exists AND the pipeline posts a final review, THE pipeline SHALL include that notice in the posted review output (the PR review body and/or the CheckRun summary), not only in logs/traces.
3. WHEN extraction and querying complete without any degradation, THE pipeline SHALL NOT add a degradation notice to the posted review.
4. THE degradation notice SHALL be bounded in size and SHALL NOT prevent the review from posting if notice assembly fails.
5. WHERE the final review is produced by an error path that already reports a pipeline failure, THE degradation notice SHALL be included without suppressing the existing error content.

## Correctness Properties (candidates for property-based testing)

These properties are candidates for property-based tests during design and implementation:

1. **Parser never throws (error conditions):** For arbitrary and degenerate `graph.json` / sidecar inputs (missing keys, wrong types, empty arrays, oversized values), the Graph_Parser produces Graph_Data or a defined error result and never throws. (Requirement 1, 4)
2. **Context builder totality:** For all Graph_Data and query-result inputs, the Context_Builder returns a non-null string. (Requirement 4.4)
3. **Context builder purity and idempotence:** The Context_Builder is a pure function — identical inputs yield identical output, and rebuilding from the same inputs yields the same string. (Requirement 7.3)
4. **Bounded output (invariant):** For all inputs and for any positive configured maximum character bound (including extremely low bounds such as 1), the Context_Builder output length is less than or equal to that bound. (Requirement 7.1, 7.4)
5. **Fallback validity (metamorphic):** For every degradation reason (missing key, timeout, malformed graph, unexpected error), the resulting Graphify_Context is a valid, non-empty string that does not break prompt assembly at either injection point. (Requirement 4, 6.3)
6. **Scope monotonicity (metamorphic):** The set of nodes in PR-scoped query results is a subset of the full graph's nodes. (Requirement 2.3)
