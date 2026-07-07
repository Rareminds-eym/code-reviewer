/**
 * REACT HOOK FORM + ZOD ECOSYSTEM MODULE
 *
 * Form handling rules. Activated when react-hook-form
 * is detected in the project dependencies.
 *
 * Extracted from the original monolithic prompt (§6).
 * Token budget: ~200 tokens
 */

export const REACT_HOOK_FORM_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FORMS & VALIDATION (React Hook Form + Zod) Rules
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- ALL forms MUST use \`react-hook-form\` paired with a \`zod\` schema resolver.
- Do NOT use standard controlled React state (\`useState\`) for form fields — it causes unnecessary re-renders.
- Zod schemas must have explicit, user-friendly error messages for every validation rule.
- Ensure \`isSubmitting\` / \`disabled\` states are handled on submit buttons to prevent double-submissions.
- Always render form error messages provided by the \`formState.errors\` object.
- Flag forms without client-side validation — every form needs a schema.
`.trim();
