/**
 * TAILWIND CSS ECOSYSTEM MODULE
 *
 * Tailwind CSS rules. Activated when tailwindcss
 * is detected in the project dependencies.
 *
 * Extracted from the original monolithic prompt (§5).
 * Token budget: ~200 tokens
 */

export const TAILWIND_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TAILWIND CSS — Styling Rules
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- All styling must be done via Tailwind utility classes. No inline \`style\` props for layout or visuals.
- Avoid arbitrary values (e.g., \`w-[347px]\`, \`text-[#a1b2c3]\`) when a standard Tailwind class or theme token exists.
- Do NOT use \`@apply\` in component files — it defeats the purpose of utility CSS and hurts performance.
- Responsive design is required: check for \`sm:\`, \`md:\`, \`lg:\` prefixes where UI could break on smaller screens.
- Dark mode support: if the project uses \`dark:\` classes, ensure new components follow the same pattern.
- Flag overly long class strings (>15 utilities) — consider extracting to a component or using \`cn()\`/\`clsx()\`.
`.trim();
