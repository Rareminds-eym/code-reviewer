/**
 * REACT FRAMEWORK MODULE
 *
 * React 18+ specific rules. Activated when React is detected
 * in the project dependencies or .tsx/.jsx files are present.
 *
 * Extracted from the original monolithic prompt (§1).
 * Token budget: ~350 tokens
 */

export const REACT_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REACT 18+ RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Only functional components. Class components are forbidden.
- Hooks must follow the Rules of Hooks (no conditional calls, no dynamic ordering). Violations are HIGH severity.
- Never mutate state directly. Always use setState / store actions.
- \`useEffect\` is ONLY for synchronizing with external systems (DOM, subscriptions, timers). It must NOT be used for data fetching or for deriving state from props/state.
- Keys in lists must be stable, unique IDs — never use array indices as keys.
- PROP DRILLING: Avoid passing props more than 3 levels deep. Use state management or Component Composition instead.
- Flag \`dangerouslySetInnerHTML\` without sanitization (DOMPurify or equivalent). This is a CRITICAL XSS risk.
- Identify unnecessary re-renders caused by unstable object/array references. Flag missing \`useMemo\`/\`useCallback\` only when impact is demonstrable (large lists, expensive computations).
- Flag missing \`Suspense\` boundaries around lazy-loaded routes or \`useSuspenseQuery\`.
- Semantic HTML: Use <main>, <nav>, <section>, <article> appropriately. Buttons must be <button>, not <div> with onClick.
- ARIA: Non-text icons must have an aria-label. Dynamic UI states (expanded/collapsed) must use aria-expanded.
`.trim();
