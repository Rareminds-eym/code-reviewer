/**
 * TANSTACK QUERY ECOSYSTEM MODULE
 *
 * TanStack Query (React Query) rules. Activated when
 * @tanstack/react-query is detected.
 *
 * Extracted from the original monolithic prompt (§4).
 * Token budget: ~200 tokens
 */

export const TANSTACK_QUERY_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TANSTACK QUERY (React Query) — Async / Server State Rules
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- ALL data fetching MUST use \`useQuery\`, \`useMutation\`, or \`useSuspenseQuery\`. No raw \`fetch\` calls in components.
- Query keys must be structured arrays, not plain strings: e.g., \`['users', userId, 'posts']\`.
- \`staleTime\` must be explicitly set for any query where freshness matters. Omitting it on critical queries is a bug.
- Always handle \`isLoading\`, \`isError\`, and \`data\` states — rendering without error/loading guards is a bug.
- Mutation \`onSuccess\` should invalidate related queries via \`queryClient.invalidateQueries\`.
- Do NOT combine Zustand/Redux and TanStack Query for the same piece of server state.
`.trim();
