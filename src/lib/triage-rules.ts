/**
 * Triage_Gatekeeper rules (R1).
 *
 * Rule-based PR classification with NO LLM call (R1.1). Assigns a Review_Track
 * from files, labels, title, and target branch using this precedence:
 *
 *   1. security-sensitive path OR label     → `deep`  (floor, R1.2 / R11.3)
 *   2. any dependency-relevant file          → `full` (never `fast`, R1.6)
 *   3. any non-documentation/config file     → `full` (R1.7)
 *   4. all-doc/config AND small              → `fast` (R1.3)
 *   5. all-doc/config but large              → `full`
 *
 * When the changed-file list is unavailable (R1.8), a provisional decision is
 * produced from the remaining signals (labels, title, target branch); the
 * container finalizes the track once files are known.
 *
 * This file is a duplicated-in-sync copy — `container/src/lib/triage-rules.ts`
 * MUST remain byte-for-byte identical (R1.9).
 */

import type { TriageConfig, TriageDecision, TriageInput } from './triage-types';

export type { TriageConfig, TriageDecision, TriageInput } from './triage-types';
export { DEFAULT_TRIAGE_CONFIG } from './triage-types';

/** Phases skipped for a `fast` track (R2.2); the Scheduler is the final authority. */
const FAST_SKIP_AGENTS: readonly string[] = ['graphify', 'stage1', 'consensus', 'verify'];

/**
 * Compile a simple glob into an anchored RegExp.
 *
 * Supported syntax (matched against a POSIX-style path):
 * - `**` / `**​/` — any run of characters, including `/` (zero or more segments)
 * - `*`          — any run of non-`/` characters
 * - `?`          — a single non-`/` character
 * All other characters are matched literally.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // `**/` matches zero or more leading path segments.
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

/** Normalize a path for matching: strip a leading `./` and backslashes → `/`. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True if `path` matches any of the provided glob patterns. */
function matchesAny(path: string, globs: string[]): boolean {
  const norm = normalizePath(path);
  for (const g of globs) {
    if (globToRegExp(g).test(norm)) return true;
  }
  return false;
}

/** True if any label (case-insensitively) is in the configured security label set. */
function hasSecurityLabel(labels: string[], securityLabels: string[]): boolean {
  const wanted = new Set(securityLabels.map((l) => l.toLowerCase()));
  return labels.some((l) => wanted.has(l.toLowerCase()));
}

/**
 * Classify a PR into a Review_Track (R1.1–R1.3, R1.6–R1.8).
 *
 * @param input Available triage signals; `input.files` may be absent (R1.8).
 * @param cfg   Tunable configuration (defaults in `DEFAULT_TRIAGE_CONFIG`).
 * @returns A {@link TriageDecision}. `provisional` is `true` when `input.files`
 *          was absent, indicating the container must finalize the track.
 */
export function triagePR(input: TriageInput, cfg: TriageConfig): TriageDecision {
  const labelSecurity = hasSecurityLabel(input.labels, cfg.securityLabels);

  // R1.8: no file list → provisional decision from labels/title/target branch.
  if (!input.files) {
    if (labelSecurity) {
      return { track: 'deep', reason: 'security-sensitive', provisional: true, skipAgents: [] };
    }
    // Safe default: `full` until the container finalizes with the file list.
    return { track: 'full', reason: 'provisional', provisional: true, skipAgents: [] };
  }

  const files = input.files;

  // 1. Security floor (R1.2 / R11.3): a security label or any security-sensitive
  //    path forces `deep` regardless of size — highest precedence.
  const pathSecurity = files.some((f) => matchesAny(f.filename, cfg.securityGlobs));
  if (labelSecurity || pathSecurity) {
    return { track: 'deep', reason: 'security-sensitive', provisional: false, skipAgents: [] };
  }

  // 2. Dependency-relevant files (R1.6): never `fast`, at least `full`.
  //    Takes precedence over documentation/config patterns.
  if (files.some((f) => matchesAny(f.filename, cfg.dependencyGlobs))) {
    return { track: 'full', reason: 'dependency-change', provisional: false, skipAgents: [] };
  }

  // 3. Any non-documentation/config file (R1.7): at least `full`.
  const allDoc = files.length > 0 && files.every((f) => matchesAny(f.filename, cfg.docGlobs));
  if (!allDoc) {
    return { track: 'full', reason: 'default', provisional: false, skipAgents: [] };
  }

  // 4. All-doc/config AND small (R1.3): `fast`.
  const additions = input.totalAdditions ?? files.reduce((sum, f) => sum + f.additions, 0);
  const small = additions <= cfg.fastMaxAdditions && files.length <= cfg.fastMaxFiles;
  if (small) {
    return {
      track: 'fast',
      reason: 'docs-only',
      provisional: false,
      skipAgents: [...FAST_SKIP_AGENTS],
    };
  }

  // 5. All-doc/config but large → `full`.
  return { track: 'full', reason: 'large', provisional: false, skipAgents: [] };
}
