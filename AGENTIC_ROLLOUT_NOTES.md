# Agentic Review Pipeline — Staged Rollout Notes

The hybrid two-tier review pipeline (triage → scheduler → dependency audit →
provenance → consensus router → bounded agentic verifier) ships **inert**. Every
new stage is behind an independent feature flag that defaults to `false`, so with
no flags set the pipeline behaves exactly as it did before the feature
(disabled-equivalence, R9.2 / R11.1). This document describes how to turn the
capabilities on safely, what to tune, and what was intentionally left out.

## Feature flags

All four flags are environment variables / Worker secrets (not new Cloudflare
bindings). They are read as the string `"true"` to enable; anything else
(including unset) means disabled.

| Flag | Default | What it enables |
|---|---|---|
| `ENABLE_TRIAGE` | `false` | Rule-based PR triage. The edge worker assigns a provisional `fast`/`full`/`deep` track from labels/title/target branch; the container finalizes it once the changed-file list is known. When off, every PR is treated as `full` (pre-feature behavior). |
| `ENABLE_DEPENDENCY_AUDIT` | `false` | Standalone supply-chain scan over **all** changed files (lockfiles, package manifests, Dockerfiles, CI workflows). Emits ground-truth findings; zero findings and negligible cost when no dependency files changed. |
| `ENABLE_CONSENSUS` | `false` | The consensus router. Scores each LLM finding from its provenance (source-agreement weights + verification floor) and routes it to KEEP / DOWNGRADE / SUPPRESS / VERIFY. When the verifier is off, VERIFY findings resolve via their confidence band (Fallback_Decision). |
| `ENABLE_AGENTIC_VERIFIER` | `false` | The bounded agentic verifier. Runs a read-only tool-use loop (`read_file` + graphify) over the VERIFY-band findings and returns Stage-2-shaped verified/rejected verdicts. Requires `ENABLE_CONSENSUS` to have anything to verify. |

Notes:
- `ENABLE_DUAL_AGENT` is the pre-existing Stage-1/Stage-2 persona flag. On the
  `full` track, personas run only when it is set; `deep` forces personas on;
  `fast` never runs personas.
- The **schedule wins over the flag** (R2.8): the `fast` track disables
  graphify / personas / consensus / verify regardless of the flags, and an open
  provider circuit breaker disables the phases that depend on it.

## Recommended staged rollout

Enable one capability at a time and observe before advancing. Each step is
independently reversible (flip the flag back to `false`).

1. **Triage first — `ENABLE_TRIAGE=true`.**
   Zero LLM cost. Watch the `Review track finalized: …` logs / `triage.finalize`
   spans to confirm track assignment matches expectations (docs-only → `fast`,
   dependency/code → `full`, security paths/labels → `deep`). No finding
   disposition changes yet.

2. **Dependency audit — `ENABLE_DEPENDENCY_AUDIT=true`.**
   Ground-truth, low risk: it only *adds* supply-chain findings and never
   rejects anything. Confirm findings appear on PRs that touch lockfiles /
   Dockerfiles / CI workflows, and that PRs with no dependency changes are
   unaffected.

3. **Consensus router with the verifier OFF — `ENABLE_CONSENSUS=true`,
   `ENABLE_AGENTIC_VERIFIER=false`.**
   The router now decides dispositions for free; VERIFY-band findings fall back
   to their confidence-band decision (Fallback_Decision, R5.6). Watch the route
   counts (`KEEP / DOWNGRADE / SUPPRESS / VERIFY`, R10.2) to understand how many
   findings the router would forward to the verifier before you pay for it.

4. **Agentic verifier last — `ENABLE_AGENTIC_VERIFIER=true`.**
   This is the only stage with material LLM cost and latency. Prefer enabling it
   **per track, deep first** (deep PRs are the highest-value, lowest-volume, and
   get the largest budgets), then widen to `full` once cost/latency look
   acceptable. Monitor the **flip-rate metric** (R10.7 — the fraction of
   ambiguous findings whose verdict differed from the router's provisional
   disposition) to measure whether the verifier is actually adding value; a
   near-zero flip rate means you are paying for verification that rarely changes
   the outcome.

Per-repo rollout is also possible via `.codereview.yml` (see below) — you can
enable stages for a pilot repository before flipping the global Worker vars.

## Tunable configuration

**`container/src/config/constants.ts`** (documented defaults, R11.2):
- **Consensus router:** `CONSENSUS_SOURCE_WEIGHTS` (per-source authority),
  `CONSENSUS_KEEP_THRESHOLD` (0.70), `CONSENSUS_DOWNGRADE_THRESHOLD` (0.40),
  `CONSENSUS_VERIFY_BAND` (`[0.50, 0.70)`), `CONSENSUS_VERIFIED_FLOOR` (0.60).
- **Per-track verifier budgets:** `VERIFIER_BUDGETS_BY_TRACK` — tool/step budget
  per finding, stage token budget, wall-clock fraction of remaining review time,
  and max concurrent findings, all larger for `deep`.
- **Verification tools:** `READ_FILE_*` line/byte bounds and the
  `VERIFIER_GRAPHIFY_*` timeout/budget/depth caps.

**Per-repo `.codereview.yml` overrides (R11.3):** a repository may raise its
track or toggle the pipeline stages under a `pipeline:` block
(`track`, `enableTriage`, `enableDependencyAudit`, `enableConsensus`,
`enableAgenticVerifier`). **Security floor:** repo config can only *raise*
strictness — it can never lower a security-driven `deep` escalation. When a repo
requests a track below the security `deep` floor, the pipeline enforces `deep`
and logs the clamp (R11.3, security-floor monotonicity).

## VERIFY band reachability under default weights

The VERIFY band is `[0.50, 0.70)`. With the default weights, single-source
findings route as follows:

- Persona findings (`security` 0.90, `architect` 0.80, `sre` 0.70) score at or
  above the KEEP threshold (0.70) → **KEEP** on their own authority.
- `map-chunk` findings score 0.50, which is now the inclusive lower bound of the
  VERIFY band → **VERIFY** (forwarded to the agentic verifier) when consensus +
  verifier are enabled.

So the lowest-authority single-LLM-source findings (`map-chunk`, 0.50) are the
"uncertain" ones the verifier is reached on via the MAP path; personas remain
KEEP because of their high authority. When the verifier is **off**, the router's
Fallback_Decision ignores the VERIFY band entirely and resolves by the
KEEP/DOWNGRADE thresholds, so a `map-chunk` 0.50 finding still **DOWNGRADES** —
identical to the pre-feature disposition (disabled-equivalence preserved).

Richer per-finding provenance is already wired for the persona path: Stage-1
findings carry their real per-persona attribution (architect/sre/security),
unioned across merged duplicates, so multi-persona agreement raises confidence
via `mergeByIdentity`.

## Deferred (out of scope, tracked separately)

The following `AGENTIC_REVIEW_ENHANCEMENT_PLAN.md` §12 items are explicitly **out
of scope** for this spec (R11.4) and are not implemented here:

- **Dismissed-finding feedback loop** — learning from findings a maintainer
  dismisses.
- **Inline `// codereview-ignore` pragmas** — source-level suppression
  directives.
- **AI-vs-human differentiation** — distinguishing AI-authored from
  human-authored changes.
- **Checkpoint / restart** — resuming a partially completed review after an
  interruption.

## Build & test commands

- **Edge (repo root):** `npx tsc --noEmit`, `npm test` (`vitest`) — scoped to
  `test/**` only.
- **Container:** `npm run build --prefix container` (`tsc --noEmit` + esbuild
  bundle), `npm test --prefix container` (`vitest run`, Node environment,
  `container/test/**`).
- Feature flags are Worker vars/secrets, not bindings, so `wrangler types` is not
  required for this feature (no `wrangler.jsonc` binding changes).
