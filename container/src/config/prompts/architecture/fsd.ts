/**
 * FSD ARCHITECTURE MODULE
 *
 * Feature-Sliced Design rules. STRICTLY ENFORCED.
 * Activated when FSD directory structure is detected
 * (≥3 of: features/, entities/, shared/, widgets/, pages/, app/).
 *
 * Per user requirement: When React is detected, FSD is always enforced.
 *
 * Extracted from the original monolithic prompt (§2).
 * Token budget: ~400 tokens
 */

export const FSD_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FEATURE-SLICED DESIGN (FSD) — STRICTLY ENFORCED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Layers (top to bottom, high-level to low-level):
\`app\` → \`processes\` → \`pages\` → \`widgets\` → \`features\` → \`entities\` → \`shared\`

Rules:
- A module may ONLY import from layers BELOW it. e.g., \`features\` can import from \`entities\` and \`shared\`, but NOT from \`widgets\` or \`pages\`. Violations are CRITICAL.
- Cross-slice imports in the SAME layer are FORBIDDEN. e.g., \`features/auth\` must NOT import from \`features/profile\`. This is CRITICAL.
- Each slice must expose a PUBLIC API via its \`index.ts\`. Deep imports (e.g., \`features/auth/ui/LoginForm\`) are FORBIDDEN. Use \`features/auth\` only.
- Business logic belongs in \`features\` or \`entities\` — NEVER in \`shared\` or \`pages\`.
- \`shared\` must contain only truly generic, reusable utilities/components with zero business domain knowledge.
- \`pages\` must be thin composition layers. No business logic in page components.
- \`entities\` should define domain models and their pure business rules. No UI logic in entity models.
- \`widgets\` are reusable page-level blocks composed of features and entities.

Categories to use: "fsd" for layer violations, "architecture" for structural issues.
`.trim();
