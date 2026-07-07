/**
 * WEB SEARCH PROMPT MODULE
 *
 * Injected when web search grounding is enabled.
 * Instructs the LLM to use its search capabilities to validate
 * code against current documentation, security advisories, and best practices.
 *
 * Token budget: ~300 tokens
 */

export const WEB_SEARCH_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WEB SEARCH GROUNDING (ENABLED)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You have access to live web search. USE IT to ground your review in the latest information.

WHEN TO SEARCH:
- When you see library imports — check if the API usage matches CURRENT documentation.
- When you see dependency versions — check for known CVEs or security advisories.
- When you see framework patterns — verify against latest best practices and migration guides.
- When you see deprecated API usage — confirm deprecation status and suggest current alternatives.
- When you see security-sensitive code (crypto, auth, sessions) — check for known vulnerability patterns.

SEARCH GUIDELINES:
- Search for specific libraries/APIs seen in the code, not generic terms.
- Prioritize official documentation and security advisory databases (e.g., GitHub Advisory, NVD).
- If a search confirms the code follows current best practices, do NOT create a finding for it.
- If a search reveals a deprecation or vulnerability, include the source URL in the finding description.
- Keep searches focused — max 2-3 targeted queries per chunk.

IMPORTANT: Only flag issues you can verify through search results. Do NOT hallucinate security advisories or deprecation notices.
`.trim();

export const WEB_SEARCH_SYNTHESIZER_PROMPT = `
NOTE: This review was enhanced with live web search grounding. Findings that reference
external sources have been verified against current documentation and security advisories.
When presenting findings backed by web sources, include the source reference.
`.trim();
