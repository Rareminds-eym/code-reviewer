# Requirements Document

## Introduction

This feature adds an **agentic verification stage** to the code-review pipeline. Today Stage 2 verification (`runStage2Verification` in `container/src/lib/llm/dual-agent.ts`) is a single-shot LLM call: Stage 1 findings are batched (20 at a time) and sent to Gemini with a fixed `codeContext` string via `adapter.synthesize(...)`, which returns a verified/rejected JSON verdict. The verifier cannot go read the cited code, trace callers, or consult the knowledge graph — it judges only from whatever context was pre-stuffed into the prompt. This is the root cause of both false positives (the finding didn't actually hold once you read the surrounding code) and false negatives (the verifier lacked the context to confirm a real issue).

The pipeline's own `ZERO_TRUST_POLICY` already instructs reviewers to "verify by physically locating and reading the code, not assuming" — but the current architecture gives the verifier no way to do that. This feature closes that gap by making verification **agentic**: the verifier is given a bounded set of read-only tools (read a file range, and query the graphify knowledge graph via `affected`/`explain`/`query`) and runs a tool-use loop where it decides what to inspect before ruling on each finding.

The design is deliberately **hybrid and additive**, not a rewrite:
- The existing map-reduce scaffold, Stage 1 personas, static-analysis ground truth, graphify integration, and smart dedup are unchanged.
- Static-analysis findings remain non-negotiable ground truth; the agent adds investigative depth for LLM-generated findings only.
- Every agent run is hard-bounded (tool-call cap, step cap, token budget, wall-clock deadline) and guarded by the existing cost circuit breaker.
- Any failure, budget exhaustion, missing capability, or disabled flag falls back to today's single-shot verification — the review never stalls or empties.

This document describes WHAT the agentic verifier must do. Implementation details (exact tool schemas, prompt wording, loop mechanics) are deferred to the design phase.

## Glossary

- **Agentic_Verifier**: The new verification component that replaces/augments the single-shot Stage 2 with a bounded tool-use loop. Successor entry point to `runStage2Verification`.
- **Verification_Agent**: One bounded tool-use loop instance that evaluates a finding (or small batch) by calling tools and then emitting a verdict.
- **Finding**: A Stage 1 LLM-produced `ReviewFinding` (severity, file, line, title, issue, category) that requires verification. Static-analysis findings are NOT subject to agentic verification (see Ground_Truth).
- **Tool**: A read-only capability exposed to the Verification_Agent. Initial set: `read_file` (a bounded line range of a file in the workspace), `graphify_affected`, `graphify_explain`, `graphify_query`.
- **Tool_Call**: One invocation of a Tool by the agent during its loop.
- **Agent_Step**: One turn of the loop = one model completion that may request Tool_Calls or emit a final verdict.
- **Verdict**: The agent's decision for a finding — `verified` or `rejected` (with a reason) — matching the existing Stage 2 output contract (`verifiedFindings` / `rejectedFindings`).
- **Tool_Budget**: The maximum number of Tool_Calls allowed per finding.
- **Step_Budget**: The maximum number of Agent_Steps allowed per finding.
- **Token_Budget**: The maximum cumulative LLM tokens allowed for the whole agentic-verification stage.
- **Wall_Clock_Deadline**: The maximum elapsed time allowed for the whole agentic-verification stage, coordinated with the CheckRun heartbeat.
- **Cost_Circuit_Breaker**: The existing `CostCircuitBreaker` that gates LLM spend across the review.
- **Workspace**: The cloned repository root (`workDir`) the review runs against.
- **Graph_Dir**: The out-of-repo graphify output directory produced by the graphify integration (`<workDir>-gfx/graphify-out`), holding `graph.json` for tool queries.
- **Fallback_Verification**: The current single-shot `runStage2Verification` behavior, used when agentic verification is disabled, unsupported, budget-exhausted, or errors.
- **Ground_Truth**: Static-analysis findings (oxlint/biome/semgrep), which are treated as confirmed and are never rejected by the Agentic_Verifier.
- **Tool_Calling_Capability**: An LLM provider adapter's ability to run a function/tool-calling loop (request tool calls, receive tool results, continue).

## Requirements

### Requirement 1: Agentic verification loop

**User Story:** As a code reviewer, I want the verifier to actively read the cited code and trace dependencies before ruling on a finding, so that verdicts are based on the real code rather than pre-stuffed context.

#### Acceptance Criteria

1. WHEN the Agentic_Verifier evaluates a Finding, THE Verification_Agent SHALL run a tool-use loop in which each Agent_Step may either request one or more Tool_Calls or emit a final Verdict.
2. WHEN the Verification_Agent requests a Tool_Call, THE Agentic_Verifier SHALL execute the tool, return its result to the agent, and continue the loop.
3. WHEN the Verification_Agent emits a Verdict, THE Agentic_Verifier SHALL stop the loop for that Finding and record the Verdict.
4. THE Agentic_Verifier SHALL produce, for every evaluated Finding, a Verdict of `verified` or `rejected` with a reason.
5. THE Agentic_Verifier SHALL emit output in the same shape as Fallback_Verification (`verifiedFindings`, `rejectedFindings`, `stats`, `usage`) so downstream smart-dedup and posting are unchanged.

### Requirement 2: Read-only tool set

**User Story:** As a security-conscious operator, I want the agent's tools to be strictly read-only and confined to the workspace, so that verification can never modify the repo, escape the sandbox, or execute arbitrary commands.

#### Acceptance Criteria

1. THE Agentic_Verifier SHALL expose only read-only tools: `read_file`, `graphify_affected`, `graphify_explain`, `graphify_query`.
2. WHEN `read_file` is called, THE Agentic_Verifier SHALL read only a bounded line range of a file resolved inside the Workspace, and SHALL reject any path that resolves outside the Workspace.
3. THE graphify tools SHALL execute only read-only graphify subcommands against the Graph_Dir's `graph.json` and SHALL NOT trigger extraction or writes.
4. THE Agentic_Verifier SHALL NOT expose any tool that writes files, executes shell commands, or performs network egress beyond the LLM provider and the graphify read commands.
5. IF the Verification_Agent requests a tool or arguments that are not permitted, THEN THE Agentic_Verifier SHALL return a tool error to the agent and continue, without performing the disallowed action.
6. WHEN a tool is invoked with untrusted arguments (paths, symbol names), THE Agentic_Verifier SHALL pass them without shell interpolation (no shell) so they cannot inject commands.

### Requirement 3: Bounded execution

**User Story:** As a pipeline operator, I want every agent run hard-bounded, so that agentic verification cannot blow the review's latency or token budget.

#### Acceptance Criteria

1. THE Agentic_Verifier SHALL enforce a Tool_Budget per Finding and SHALL stop making Tool_Calls for a Finding once the budget is reached.
2. THE Agentic_Verifier SHALL enforce a Step_Budget per Finding and SHALL force a Verdict once the budget is reached.
3. THE Agentic_Verifier SHALL enforce a Token_Budget for the whole stage and SHALL stop starting new agent runs once the budget is reached.
4. THE Agentic_Verifier SHALL enforce a Wall_Clock_Deadline for the whole stage and SHALL stop starting new agent runs once the deadline passes.
5. WHEN a per-Finding budget (Tool_Budget or Step_Budget) is reached before a Verdict is emitted, THE Agentic_Verifier SHALL resolve that Finding using a defined default disposition rather than looping indefinitely.
6. WHILE the agentic-verification stage is running, THE Agentic_Verifier SHALL allow the CheckRun heartbeat to continue reporting progress.
7. WHEN the review's abort signal fires, THE Agentic_Verifier SHALL stop the loop and resolve remaining Findings via Fallback_Verification or the default disposition.

### Requirement 4: Cost control

**User Story:** As a pipeline operator, I want agentic verification spend gated by the existing cost controls, so that a multi-step loop cannot cause runaway cost.

#### Acceptance Criteria

1. THE Agentic_Verifier SHALL route its LLM usage through the Cost_Circuit_Breaker used by the rest of the pipeline.
2. IF the Cost_Circuit_Breaker is open, THEN THE Agentic_Verifier SHALL NOT start new agent runs and SHALL resolve remaining Findings via Fallback_Verification.
3. THE Agentic_Verifier SHALL record token usage for every Agent_Step and include it in the stage `usage` total.

### Requirement 5: Graceful fallback

**User Story:** As a PR author, I want verification to always complete, so that an agentic failure never blocks or empties my review.

#### Acceptance Criteria

1. IF agentic verification is disabled by configuration, THEN THE Agentic_Verifier SHALL use Fallback_Verification.
2. IF the configured provider lacks Tool_Calling_Capability or an API key, THEN THE Agentic_Verifier SHALL use Fallback_Verification.
3. IF the Graph_Dir or `graph.json` is unavailable, THEN the graphify tools SHALL return a tool error and the agent SHALL continue using the remaining tools; the stage SHALL NOT fail.
4. IF an agent run raises an unexpected error, THEN THE Agentic_Verifier SHALL catch it, log a diagnostic, and resolve that Finding via Fallback_Verification or the default disposition.
5. THE Agentic_Verifier SHALL return a valid Stage-2-shaped result for every input, including empty Finding sets.

### Requirement 6: Preserve ground truth and additivity

**User Story:** As a maintainer, I want static-analysis findings to remain authoritative and the change to be additive, so that agentic verification improves precision without regressing existing guarantees.

#### Acceptance Criteria

1. THE Agentic_Verifier SHALL NOT reject Ground_Truth (static-analysis) findings; it SHALL pass them through as verified.
2. THE Agentic_Verifier SHALL evaluate only LLM-produced Findings.
3. THE Agentic_Verifier SHALL NOT alter the Stage 1, static-analysis, graphify, chunking, or smart-dedup stages.
4. WHEN agentic verification is disabled, THE pipeline SHALL behave identically to its pre-feature behavior.

### Requirement 7: Provider tool-calling capability

**User Story:** As a developer, I want the LLM adapter layer to support a tool-calling loop, so that the verifier can drive multi-step tool use through the existing provider abstraction.

#### Acceptance Criteria

1. THE provider adapter layer SHALL expose a capability that runs a tool-calling loop: send messages plus tool definitions, receive either tool-call requests or a final message.
2. WHERE a provider supports tool calling (e.g. Claude, Gemini), THE adapter SHALL implement the capability for that provider.
3. WHERE a provider does not support tool calling, THE adapter SHALL report the capability as unavailable so the Agentic_Verifier can fall back (Requirement 5.2).
4. THE tool-calling capability SHALL surface token usage for each completion so budgets and cost control can be enforced.

### Requirement 8: Configuration and rollout

**User Story:** As an operator, I want to enable, tune, and disable agentic verification without code changes, so that I can roll it out safely.

#### Acceptance Criteria

1. THE Agentic_Verifier SHALL be gated by an explicit configuration flag that defaults to disabled.
2. THE Tool_Budget, Step_Budget, Token_Budget, and Wall_Clock_Deadline SHALL be configurable with documented default values.
3. WHEN the feature flag is unset or false, THE pipeline SHALL use Fallback_Verification with no behavioral change.

### Requirement 9: Observability

**User Story:** As a maintainer, I want to see what the agent did per finding, so that I can measure precision impact and diagnose loops.

#### Acceptance Criteria

1. WHEN a Finding is evaluated, THE Agentic_Verifier SHALL log the Finding identity, the number of Agent_Steps, the number and types of Tool_Calls, and the final Verdict.
2. WHEN the stage completes, THE Agentic_Verifier SHALL log aggregate stats: findings evaluated, verified, rejected, total steps, total tool calls, total tokens, and elapsed time.
3. IF a fallback path or default disposition is taken, THEN THE Agentic_Verifier SHALL log the specific reason (disabled, no capability, budget exhausted, deadline, circuit open, error).
4. THE Agentic_Verifier SHALL emit a tracer span for the stage with the aggregate attributes.

## Correctness Properties (candidates for property-based testing)

1. **Loop termination:** For all inputs and any positive Tool_Budget/Step_Budget, the Verification_Agent loop terminates (emits a Verdict or hits a budget and resolves via default disposition) and never loops unbounded. (Requirement 1, 3)
2. **Total verdict coverage:** For every evaluated Finding, exactly one Verdict (`verified` or `rejected`) is produced; the union of verified + rejected equals the evaluated set. (Requirement 1.4, 1.5)
3. **Read-only / sandbox safety:** For arbitrary tool arguments, `read_file` never resolves outside the Workspace and no tool performs a write, shell exec, or disallowed egress. (Requirement 2)
4. **Budget invariants:** For any run, Tool_Calls per Finding ≤ Tool_Budget, Agent_Steps per Finding ≤ Step_Budget, and the stage stops starting runs once Token_Budget or Wall_Clock_Deadline is exceeded. (Requirement 3)
5. **Fallback totality:** For every degradation path (disabled, no capability, no key, missing graph, circuit open, error, abort), the stage still returns a valid Stage-2-shaped result. (Requirement 5)
6. **Ground-truth preservation:** No static-analysis Finding is ever rejected by the Agentic_Verifier. (Requirement 6.1)
7. **Disabled-equivalence (metamorphic):** With the feature flag off, the stage output equals Fallback_Verification output for the same input. (Requirement 6.4, 8.3)
