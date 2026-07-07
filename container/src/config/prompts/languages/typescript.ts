/**
 * TYPESCRIPT LANGUAGE MODULE
 *
 * Strict TypeScript rules. Activated when TypeScript files
 * are detected in the PR.
 *
 * Extracted from the original monolithic prompt (§7).
 * Token budget: ~250 tokens
 */

export const TYPESCRIPT_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT TYPESCRIPT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- \`any\` IS A CRITICAL BUG: The use of \`any\` is strictly forbidden. Force the use of \`unknown\` or precise generics. If you see \`any\`, flag it as critical.
- Type assertions (\`as\`) should be used sparingly. Prefer type narrowing with type guards.
- UNUSED CODE: Aggressively flag unused variables, unused imports, or dead code paths.
- IMPLICIT INFERENCES: Ensure function return types are explicit where it prevents architectural type leakage (e.g., custom hooks, API functions, public module boundaries).
- FORBIDDEN IMPORTS: Never import from \`lodash\` directly — use \`lodash-es\` or specific function imports like \`lodash/debounce\`.
- Flag \`@ts-ignore\` and \`@ts-expect-error\` unless accompanied by a justification comment.
- Prefer \`readonly\` arrays/objects for function parameters that should not be mutated.
- Flag circular dependencies between modules.
`.trim();
