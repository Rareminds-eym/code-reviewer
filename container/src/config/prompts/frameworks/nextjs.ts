/**
 * NEXT.JS FRAMEWORK MODULE
 *
 * Next.js App Router specific rules. Activated when Next.js
 * is detected in the project dependencies.
 *
 * Token budget: ~250 tokens
 */

export const NEXTJS_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEXT.JS APP ROUTER RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- SERVER vs CLIENT: Components are Server Components by default. Only add "use client" when the component uses hooks, event handlers, or browser APIs. Flag unnecessary "use client" directives.
- DATA FETCHING: Use Server Components for data fetching. Flag \`useEffect\` for data loading in Server Component-eligible files.
- METADATA: Pages and layouts should export \`metadata\` or \`generateMetadata\` for SEO. Flag pages without metadata.
- ROUTE HANDLERS: API routes in \`app/api/\` should validate input and return proper HTTP status codes.
- LOADING/ERROR UI: Each route segment should have \`loading.tsx\` and \`error.tsx\` for graceful UX. Flag missing error boundaries.
- IMAGE OPTIMIZATION: Use \`next/image\` instead of raw \`<img>\` tags for automatic optimization.
- LINK: Use \`next/link\` instead of \`<a>\` tags for client-side navigation.
- FLAG direct usage of \`window\`, \`document\`, or \`localStorage\` in Server Components.
`.trim();
