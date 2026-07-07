import type { ReviewFinding } from '../../types/review';
import { MAX_FINDINGS_PER_CHUNK } from '../../config/constants';
import { logger } from '../logger';

/**
 * Defensive JSON parser for chunk reviewer LLM output.
 *
 * LLMs are unreliable about output format. This parser handles:
 * 1. Clean JSON: { "findings": [...] }
 * 2. JSON wrapped in markdown code fences: ```json\n{...}\n```
 * 3. JSON with leading/trailing prose the LLM shouldn't have added
 * 4. Malformed JSON that can't be parsed at all (graceful fallback)
 *
 * A 30-year rule: never trust external input. The LLM is external input.
 */
/**
 * @param rawOutput  — raw LLM text (may contain code fences, prose, etc.)
 * @param changedFiles — optional list of filenames in the PR. If provided,
 *   findings referencing files NOT in this list are dropped as hallucinations.
 */
export function parseFindings(rawOutput: string, changedFiles?: string[]): ReviewFinding[] {
    const cleaned = extractJSON(rawOutput);

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        // Attempt to salvage truncated array (max_tokens hit mid-generation)
        const salvaged = salvageTruncatedArray(cleaned);
        try {
            parsed = JSON.parse(salvaged);
            logger.info('Successfully salvaged truncated JSON array');
        } catch {
            logger.error('Failed to parse LLM JSON output even after salvage attempt', undefined, {
                rawOutput: rawOutput.slice(0, 500),
            });
            return [];
        }
    }

    // Validate top-level structure
    if (!parsed || typeof parsed !== 'object') {
        logger.error('Parsed output is not an object');
        return [];
    }

    const obj = parsed as Record<string, unknown>;

    // Accept both { findings: [...] } and a raw array [...]
    let rawFindings: unknown[];
    if (Array.isArray(obj.findings)) {
        rawFindings = obj.findings;
    } else if (Array.isArray(parsed)) {
        rawFindings = parsed as unknown[];
    } else {
        logger.error('No "findings" array found in parsed output');
        return [];
    }

    // Build a set of changed filenames for O(1) lookup (hallucination filter)
    const changedFileSet = changedFiles ? new Set(changedFiles) : null;

    // Validate and sanitize each finding
    const validated: ReviewFinding[] = [];
    let hallucinated = 0;
    for (const item of rawFindings) {
        const finding = validateFinding(item);
        if (!finding) continue;

        // Hallucination filter: drop findings that reference files not in the PR
        if (changedFileSet && !changedFileSet.has(finding.file)) {
            hallucinated++;
            continue;
        }

        validated.push(finding);
        if (validated.length >= MAX_FINDINGS_PER_CHUNK) {
            logger.warn('Hit MAX_FINDINGS_PER_CHUNK, truncating', {
                max: MAX_FINDINGS_PER_CHUNK,
            });
            break;
        }
    }

    if (hallucinated > 0) {
        logger.warn('Dropped hallucinated findings referencing files not in PR', {
            hallucinated,
            validatedCount: validated.length,
        });
    }

    return validated;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const VALID_CATEGORIES = new Set([
    // Universal categories
    'bug', 'security', 'performance', 'error-handling', 'type-safety',
    'dead-code', 'naming', 'accessibility', 'architecture', 'clean-code',
    'testing', 'documentation',
    // Stack-specific categories (backward-compatible)
    'fsd', 'react', 'typescript', 'zustand', 'tanstack-query', 'tailwind', 'forms',
]);

/**
 * Extracts JSON from potentially wrapped LLM output.
 * Handles code fences, leading prose, and trailing garbage.
 */
function extractJSON(raw: string): string {
    let text = raw.trim();

    // Strategy 1: Strip markdown code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }

    // Strategy 2: Find the first { or [ and last } or ]
    // This handles cases where the LLM adds prose before/after the JSON
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;

    if (firstBrace === -1 && firstBracket === -1) {
        return text; // No JSON structure found, return as-is and let JSON.parse fail
    }

    if (firstBrace === -1) start = firstBracket;
    else if (firstBracket === -1) start = firstBrace;
    else start = Math.min(firstBrace, firstBracket);

    const isObject = text[start] === '{';
    const closer = isObject ? '}' : ']';
    const end = text.lastIndexOf(closer);

    if (end > start) {
        text = text.slice(start, end + 1);
    }

    return text;
}

/**
 * Validates a single finding object from the LLM output.
 * Returns a strongly-typed ReviewFinding or null if invalid.
 */
function validateFinding(item: unknown): ReviewFinding | null {
    if (!item || typeof item !== 'object') return null;

    const obj = item as Record<string, unknown>;

    // Required fields
    const severity = typeof obj.severity === 'string' ? obj.severity.toLowerCase() : null;
    const file = typeof obj.file === 'string' ? obj.file : null;
    const title = typeof obj.title === 'string' ? obj.title : null;
    const issue = typeof obj.issue === 'string' ? obj.issue : null;
    const category = typeof obj.category === 'string' ? obj.category.toLowerCase() : null;

    if (!severity || !file || !title || !issue || !category) return null;
    if (!VALID_SEVERITIES.has(severity)) return null;

    // Normalize category — accept close matches, default to 'clean-code'
    const normalizedCategory = VALID_CATEGORIES.has(category) ? category : 'clean-code';

    const finding: ReviewFinding = {
        severity: severity as ReviewFinding['severity'],
        file,
        title: title.slice(0, 200), // Guard against absurdly long titles
        issue: issue.slice(0, 1000), // Guard against absurdly long descriptions
        category: normalizedCategory as ReviewFinding['category'],
    };

    // Optional fields
    if (typeof obj.line === 'number' && obj.line > 0) {
        finding.line = Math.floor(obj.line);
    }
    if (typeof obj.currentCode === 'string' && obj.currentCode.length > 0) {
        finding.currentCode = obj.currentCode.slice(0, 2000);
    }
    if (typeof obj.suggestedCode === 'string' && obj.suggestedCode.length > 0) {
        finding.suggestedCode = obj.suggestedCode.slice(0, 2000);
    }

    return finding;
}

/**
 * Attempts to salvage a truncated JSON array by terminating at the last complete
 * object brace '}' and forcibly closing the array structure.
 */
function salvageTruncatedArray(text: string): string {
    const lastBraceIndex = text.lastIndexOf('}');
    if (lastBraceIndex === -1) return text;

    let salvaged = text.slice(0, lastBraceIndex + 1);

    // Strip any trailing comma after the last complete object
    // e.g. '{...}, {"sev' → after slice: '{...},' → must remove the comma
    salvaged = salvaged.replace(/,\s*$/, '');

    // If it was wrapped in a {"findings": [...]} structure
    if (salvaged.includes('"findings"')) {
        salvaged += ']}';
    } else {
        // Assume raw array [...]
        salvaged += ']';
    }

    return salvaged;
}

