/**
 * OUTPUT FORMAT MODULE — Always included last in every review prompt.
 *
 * Defines the exact JSON schema the LLM must output.
 * Separated from base.ts to keep concerns clean.
 *
 * Token budget: ~300 tokens
 */

export const OUTPUT_FORMAT_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED OUTPUT FORMAT — JSON ONLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST output a single JSON object matching this exact schema. No markdown. No explanation. No wrapping.

{
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "file": "path/to/file.ext",
      "line": 42,
      "title": "Short descriptive title",
      "issue": "One sentence describing the problem.",
      "currentCode": "the problematic code snippet",
      "suggestedCode": "the corrected code snippet",
      "category": "bug" | "security" | "performance" | "error-handling" | "type-safety" | "dead-code" | "naming" | "accessibility" | "architecture" | "clean-code" | "testing" | "documentation" | "react" | "fsd" | "zustand" | "tanstack-query" | "tailwind" | "forms" | "typescript"
    }
  ]
}

Rules:
- "findings" MUST be an array, even if empty: { "findings": [] }
- "severity", "file", "title", "issue", and "category" are REQUIRED for every finding.
- "line", "currentCode", and "suggestedCode" are optional but strongly preferred.
- Keep code snippets SHORT (max 10 lines each). Do NOT paste entire files.
- Maximum 50 findings per chunk. Prioritize critical/high issues if you would exceed this.
- Use stack-specific categories (react, fsd, zustand, etc.) ONLY when the issue is specifically about that technology. Use universal categories (bug, security, performance, etc.) for general issues.
`.trim();
