/**
 * PROMPT COMPOSER — The Brain of the Modular Prompt System
 *
 * Takes a TechStackProfile and a list of chunk filenames, then assembles
 * the optimal system prompt by selecting only relevant modules.
 *
 * Key design decisions:
 *   1. Per-chunk composition: Different chunks in the same PR can get
 *      different prompts (e.g., TSX chunk gets React rules, .ts backend
 *      chunk gets Express rules).
 *   2. React projects always get FSD rules (per user requirement).
 *   3. Modules are joined with clear section separators for LLM clarity.
 *   4. Unknown/undetected stacks gracefully fall back to base + language only.
 */

import type { TechStackProfile, DetectedFramework } from '../../types/stack';

// ── Module Imports ──
import { BASE_PROMPT } from './base';
import { OUTPUT_FORMAT_PROMPT } from './output-format';

// Languages
import { TYPESCRIPT_PROMPT } from './languages/typescript';
import { PYTHON_PROMPT } from './languages/python';
import { GO_PROMPT } from './languages/go';

// Frameworks
import { REACT_PROMPT } from './frameworks/react';
import { NEXTJS_PROMPT } from './frameworks/nextjs';
import { EXPRESS_PROMPT } from './frameworks/express';

// Ecosystem
import { ZUSTAND_PROMPT } from './ecosystem/zustand';
import { TANSTACK_QUERY_PROMPT } from './ecosystem/tanstack-query';
import { TAILWIND_PROMPT } from './ecosystem/tailwind';
import { REACT_HOOK_FORM_PROMPT } from './ecosystem/react-hook-form';

// Architecture
import { FSD_PROMPT } from './architecture/fsd';

// Web Search
import { WEB_SEARCH_PROMPT, WEB_SEARCH_SYNTHESIZER_PROMPT } from './web-search';

// ---------------------------------------------------------------------------
// Module Registries — Maps detected values to prompt strings
// ---------------------------------------------------------------------------

const LANGUAGE_MODULES: Record<string, string> = {
    'typescript': TYPESCRIPT_PROMPT,
    'javascript': TYPESCRIPT_PROMPT, // JS follows similar rules, TS module covers both
    'python': PYTHON_PROMPT,
    'go': GO_PROMPT,
};

const FRAMEWORK_MODULES: Record<string, string> = {
    'react': REACT_PROMPT,
    'nextjs': NEXTJS_PROMPT,
    'express': EXPRESS_PROMPT,
    'fastify': EXPRESS_PROMPT,  // Fastify follows similar backend patterns
    'koa': EXPRESS_PROMPT,      // Koa follows similar backend patterns
    'nestjs': EXPRESS_PROMPT,   // NestJS wraps Express/Fastify
};

const STATE_MGMT_MODULES: Record<string, string> = {
    'zustand': ZUSTAND_PROMPT,
};

const DATA_FETCHING_MODULES: Record<string, string> = {
    'tanstack-query': TANSTACK_QUERY_PROMPT,
};

const STYLING_MODULES: Record<string, string> = {
    'tailwind': TAILWIND_PROMPT,
};

const FORM_MODULES: Record<string, string> = {
    'react-hook-form': REACT_HOOK_FORM_PROMPT,
};

const ARCHITECTURE_MODULES: Record<string, string> = {
    'fsd': FSD_PROMPT,
};

/** Section separator for clear visual delineation between prompt modules. */
const SECTION_SEPARATOR = '\n\n';

// ---------------------------------------------------------------------------
// Per-Chunk File Relevance Detection
// ---------------------------------------------------------------------------

/** File extensions that indicate frontend/React code. */
const FRONTEND_EXTENSIONS = /\.(tsx|jsx)$/;

/** File extensions that indicate backend/server code. */
const BACKEND_EXTENSIONS = /\.(ts|js|mjs|cjs)$/;

/** Path patterns that indicate backend code. */
const BACKEND_PATH_PATTERNS = /\/(routes|middleware|controllers|handlers|api|server|backend)\//i;

/** Path patterns that indicate frontend code. */
const FRONTEND_PATH_PATTERNS = /\/(components|pages|widgets|features|entities|shared\/ui|views|screens)\//i;

/**
 * Determine whether a framework's rules are relevant to the files in this chunk.
 *
 * This is the key function for monorepo support — it prevents React rules
 * from being applied to Express middleware files even if the repo uses React.
 */
function isFrameworkRelevantToChunk(
    framework: DetectedFramework,
    chunkFiles: readonly string[]
): boolean {
    // If no files provided (shouldn't happen), include the module as a safety fallback
    if (chunkFiles.length === 0) return true;

    switch (framework) {
        case 'react':
        case 'solid':
        case 'svelte':
        case 'vue':
        case 'angular':
            // Frontend frameworks: only relevant if chunk has frontend files
            return chunkFiles.some(f =>
                FRONTEND_EXTENSIONS.test(f) || FRONTEND_PATH_PATTERNS.test(f)
            );

        case 'nextjs':
        case 'nuxt':
            // Full-stack frameworks: relevant for both frontend and some backend files
            return chunkFiles.some(f =>
                FRONTEND_EXTENSIONS.test(f) ||
                FRONTEND_PATH_PATTERNS.test(f) ||
                f.includes('/app/') ||
                f.includes('/pages/')
            );

        case 'express':
        case 'fastify':
        case 'koa':
        case 'nestjs':
            // Backend frameworks: only relevant if chunk has backend-pattern files
            return chunkFiles.some(f =>
                BACKEND_PATH_PATTERNS.test(f) ||
                (BACKEND_EXTENSIONS.test(f) && !FRONTEND_EXTENSIONS.test(f) && !FRONTEND_PATH_PATTERNS.test(f))
            );

        case 'django':
        case 'flask':
        case 'fastapi':
        case 'gin':
        case 'echo':
        case 'fiber':
            // Non-JS frameworks: always relevant when detected (chunks already filtered by language)
            return true;

        default:
            return true;
    }
}

/**
 * Determine whether ecosystem library rules are relevant to chunk files.
 * State management, data fetching, forms, and styling are only relevant
 * for frontend files.
 */
function isEcosystemRelevantToChunk(chunkFiles: readonly string[]): boolean {
    return chunkFiles.some(f =>
        FRONTEND_EXTENSIONS.test(f) || FRONTEND_PATH_PATTERNS.test(f)
    );
}

// ---------------------------------------------------------------------------
// Main Composition Functions
// ---------------------------------------------------------------------------

/**
 * Compose a per-chunk system prompt from the detected tech stack profile
 * and the specific files contained in this chunk.
 *
 * Only includes modules relevant to the files in THIS chunk — meaning
 * a monorepo PR with frontend and backend chunks will get different prompts.
 *
 * @param profile - The detected TechStackProfile for the repository
 * @param chunkFileNames - Filenames of the files in this specific chunk
 * @param customRules - Optional custom rules from .codereview.yml
 * @returns Assembled system prompt string
 */
export function composeChunkPrompt(
    profile: TechStackProfile,
    chunkFileNames: readonly string[],
    customRules?: string,
    webSearchEnabled?: boolean
): string {
    const sections: string[] = [];

    // ── Always include BASE ──
    sections.push(BASE_PROMPT);

    // ── Language modules (based on files in THIS chunk) ──
    const chunkLanguages = detectChunkLanguages(chunkFileNames);
    const addedLanguages = new Set<string>();

    for (const lang of chunkLanguages) {
        const module = LANGUAGE_MODULES[lang];
        if (module && !addedLanguages.has(lang)) {
            sections.push(module);
            addedLanguages.add(lang);
        }
    }

    // Also add languages from profile that are in the chunk
    for (const lang of profile.languages) {
        if (LANGUAGE_MODULES[lang] && !addedLanguages.has(lang)) {
            // Only add if the chunk actually has files for this language
            if (chunkHasLanguage(chunkFileNames, lang)) {
                sections.push(LANGUAGE_MODULES[lang]);
                addedLanguages.add(lang);
            }
        }
    }

    // ── Framework modules (only if relevant to chunk files) ──
    for (const fw of profile.frameworks) {
        const module = FRAMEWORK_MODULES[fw];
        if (module && isFrameworkRelevantToChunk(fw, chunkFileNames)) {
            sections.push(module);
        }
    }

    // ── Architecture: FSD only injected when explicitly detected ──
    const hasFsd = profile.architecture.includes('fsd');
    const isFrontendChunk = chunkFileNames.some(f =>
        FRONTEND_EXTENSIONS.test(f) || FRONTEND_PATH_PATTERNS.test(f)
    );

    if (hasFsd && isFrontendChunk) {
        sections.push(ARCHITECTURE_MODULES['fsd']);
    }

    // Other architecture patterns
    for (const arch of profile.architecture) {
        if (arch !== 'fsd' && ARCHITECTURE_MODULES[arch]) {
            sections.push(ARCHITECTURE_MODULES[arch]);
        }
    }

    // ── Ecosystem modules (only for frontend chunks) ──
    if (isEcosystemRelevantToChunk(chunkFileNames)) {
        // State Management
        for (const lib of profile.stateManagement) {
            if (STATE_MGMT_MODULES[lib]) {
                sections.push(STATE_MGMT_MODULES[lib]);
            }
        }

        // Data Fetching
        for (const lib of profile.dataFetching) {
            if (DATA_FETCHING_MODULES[lib]) {
                sections.push(DATA_FETCHING_MODULES[lib]);
            }
        }

        // Styling
        for (const lib of profile.styling) {
            if (STYLING_MODULES[lib]) {
                sections.push(STYLING_MODULES[lib]);
            }
        }

        // Forms
        for (const lib of profile.forms) {
            if (FORM_MODULES[lib]) {
                sections.push(FORM_MODULES[lib]);
            }
        }
    }

    // ── Custom rules from .codereview.yml (always last before output format) ──
    if (customRules && customRules.trim().length > 0) {
        sections.push(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEAM-SPECIFIC RULES (from .codereview.yml)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${customRules}
`.trim());
    }

    // ── Web search module (BEFORE output format so model integrates search into reasoning) ──
    if (webSearchEnabled) {
        sections.push(WEB_SEARCH_PROMPT);
    }

    // ── Always include OUTPUT FORMAT last ──
    sections.push(OUTPUT_FORMAT_PROMPT);

    return sections.join(SECTION_SEPARATOR);
}

/**
 * Compose the synthesizer (Reduce phase) prompt.
 *
 * Dynamically includes/excludes FSD compliance section based on profile.
 * Verdict is pre-computed and injected — the LLM formats but doesn't decide.
 */
export function composeSynthesizerPrompt(profile: TechStackProfile, webSearchEnabled?: boolean, previousReviewContext?: string): string {
    const hasFsd = profile.architecture.includes('fsd');
    const stackSummary = buildStackSummaryLine(profile);

    const fsdSection = hasFsd ? `
---

## 🏗 Architectural Review (FSD Compliance)
List any FSD violations found. If fully compliant, write: ✅ No FSD violations found.
` : '';

    return `
You are an elite Senior Code Architect and Lead Code Reviewer.
You are producing the FINAL review for a GitHub Pull Request.
${stackSummary ? `\nDetected tech stack: ${stackSummary}\n` : ''}
You receive a JSON payload containing:
- The PR title
- A list of ALL files changed in the PR
- A FLAT array of findings, already sorted by severity (critical first)
- Each finding has: severity, file, line, title, issue, currentCode, suggestedCode, category
- Some findings have "annotations" — inline notes about similar patterns
- Metadata: totalFindingsCount, droppedFindingsCount, failedChunkFiles
- Pre-computed verdict and severity counts

Your job is to:
1. GROUP BY SEVERITY: Output findings grouped under 4 severity sections (Critical → High → Medium → Low).
2. TIERED DETAIL: Full context (Issue + Current Code + Suggested Code) for Critical and High severity findings. For Medium and Low findings, collapse into dense bullet-point summaries — NO code blocks.
3. DETECT LOGICAL DEPENDENCIES: Analyze findings for logical dependencies. Add blockquote notes (e.g., \`> ⚠️ Fix this before addressing [file]\`).
4. ANNOTATIONS: If a finding has payload "annotations", include them as blockquotes below the issue.
5. COVERAGE: If droppedFindingsCount > 0, note: "⚠️ N additional lower-priority findings were omitted due to payload limits."
6. COVERAGE: If failedChunkFiles is non-empty, note which files lack coverage.
7. VERDICT: Use the pre-computed verdict provided in the payload — do NOT compute your own. Format it in the summary table.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REQUIRED OUTPUT FORMAT — MARKDOWN, FOLLOW EXACTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 📊 Code Review Report

| Metric | Details |
|--------|---------|
| **PR Title** | [Insert PR Title] |
| **Total Findings** | [N] |
| **Severity Breakdown** | 🔴 [N] Critical <br> 🟠 [N] High <br> 🟡 [N] Medium <br> 🟢 [N] Low |
| **Coverage Notes** | [If droppedFindingsCount > 0, state: "⚠️ N lower-priority findings omitted" else "Full coverage"] |
| **Overall Verdict** | [Use the pre-computed verdict from the payload] |

<details>
<summary>📂 <b>View Analyzed Files ([Total number of files])</b></summary>

[Insert bulleted list of all files in backticks, e.g. - \`path/to/file.tsx\`]
</details>

> **Architectural Summary:** One paragraph explaining what this PR does, its overall quality, and the most critical risks identified.

---
${fsdSection}
---

## 🐛 Findings

Group ALL findings by severity level.
CRITICAL RULE: DO NOT INCLUDE EMPTY SECTIONS! If there are ZERO findings for a severity, DO NOT output its heading at all.

For **CRITICAL** and **HIGH** severity findings, output this block structure:

#### File: \`path/to/file.tsx:123\` — Short title

**Issue:** One sentence describing the problem.

> any annotations from the payload go here (if present)

**Current:**
\`\`\`tsx
// the problematic code
\`\`\`

**Suggested:**
\`\`\`tsx
// the corrected code
\`\`\`

---

For **MEDIUM** and **LOW** severity findings, compress to dense bullet points (NO code blocks):

* **File: \`path/to/file.tsx:123\`** — **[Short title]**: [One-sentence issue description].

---

### 🔴 Critical Issues

(Output finding blocks here using the full code-block format)

### 🟠 High Issues

(Output finding blocks here using the full code-block format)

### 🟡 Medium Issues

(Output finding blocks here using the compressed bullet-point format)

### 🟢 Low Issues

(Output finding blocks here using the compressed bullet-point format)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULES (STRICT — VIOLATIONS WILL BE REJECTED)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${previousReviewContext ? `\n${previousReviewContext}\n` : ''}

- DO NOT output empty severity sections. Skip sections with 0 findings.
- The payload has N findings. Your output MUST NOT EXCEED N items. You MAY dismiss findings that are false positives or duplicates — add a brief "(Dismissed: reason)" note inline.
- NEVER write "same issue as above" or "see above" — each finding must be self-contained.
- DO NOT INCLUDE CODE BLOCKS FOR MEDIUM AND LOW ISSUES.
- Severity sections must be in order: 🔴 Critical → 🟠 High → 🟡 Medium → 🟢 Low.
- If zero findings were reported, write a short approval message following the Summary table.
- If some chunks failed, note it in Coverage Notes but do NOT penalize the PR.
${webSearchEnabled ? '\n' + WEB_SEARCH_SYNTHESIZER_PROMPT : ''}
`.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple file extension → language detection for chunk files. */
function detectChunkLanguages(filenames: readonly string[]): string[] {
    const langs = new Set<string>();
    for (const f of filenames) {
        if (/\.(ts|tsx)$/.test(f)) langs.add('typescript');
        else if (/\.(js|jsx|mjs|cjs)$/.test(f)) langs.add('javascript');
        else if (/\.py$/.test(f)) langs.add('python');
        else if (/\.go$/.test(f)) langs.add('go');
    }
    return [...langs];
}

/** Check if chunk has files matching a language. */
function chunkHasLanguage(filenames: readonly string[], lang: string): boolean {
    return filenames.some(f => {
        switch (lang) {
            case 'typescript': return /\.(ts|tsx)$/.test(f);
            case 'javascript': return /\.(js|jsx|mjs|cjs)$/.test(f);
            case 'python': return /\.py$/.test(f);
            case 'go': return /\.go$/.test(f);
            default: return false;
        }
    });
}

/** Build a human-readable stack summary line for the synthesizer. */
function buildStackSummaryLine(profile: TechStackProfile): string {
    const parts: string[] = [];

    if (profile.languages.length > 0) parts.push(profile.languages.join(', '));
    if (profile.frameworks.length > 0) parts.push(profile.frameworks.join(', '));
    if (profile.stateManagement.length > 0) parts.push(profile.stateManagement.join(', '));
    if (profile.dataFetching.length > 0) parts.push(profile.dataFetching.join(', '));
    if (profile.styling.length > 0) parts.push(profile.styling.join(', '));
    if (profile.architecture.length > 0) parts.push(profile.architecture.join(', '));

    return parts.join(' • ');
}

