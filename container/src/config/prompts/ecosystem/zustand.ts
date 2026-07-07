/**
 * ZUSTAND ECOSYSTEM MODULE
 *
 * Zustand state management rules. Activated when Zustand
 * is detected in the project dependencies.
 *
 * Extracted from the original monolithic prompt (§3).
 * Token budget: ~200 tokens
 */

export const ZUSTAND_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ZUSTAND — Global Client State Rules
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Use ATOMIC selectors: \`const count = useStore(state => state.count)\`. NEVER select the whole store: \`const store = useStore()\`. Whole-store selection causes every component to re-render on any state change.
- Business logic and side effects belong inside STORE ACTIONS, not in component bodies or useEffect hooks.
- Do NOT use Zustand for server/async state — that is the data-fetching library's responsibility.
- Avoid storing derived state — compute it with selectors instead.
- Store slices should be kept small and focused on a single domain.
- Flag direct store mutations outside of actions.
`.trim();
