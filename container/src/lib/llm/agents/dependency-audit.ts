/**
 * Dependency Audit (R3) — standalone, rule-based supply-chain scanner.
 *
 * Scans dependency-relevant files that the code-only plugin runner never sees:
 * lockfiles, package manifests, Dockerfiles, and CI workflow files. Emits
 * ground-truth `DependencyFinding[]` with fixed per-rule severities and adds
 * negligible latency when no dependency files changed.
 *
 * Zero LLM cost. This step runs over ALL changed files (not only code files)
 * and does NOT require the plugin runner (R3.4). Every scanner catches
 * internally so a malformed file can never crash the pipeline (R9.4).
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { logger } from '../../logger';

/**
 * A supply-chain finding emitted by the Dependency Audit. Ground truth — never
 * scored or rejected by the Consensus_Router or Agentic_Verifier (R5.2, R6).
 */
export interface DependencyFinding {
    severity: 'critical' | 'high' | 'medium' | 'low';
    file: string;
    line?: number;
    title: string;
    issue: string;
    category: 'security';
    source: 'dependency-audit';
}

/**
 * Fixed per-rule severities with documented defaults (R3.2, R3.6):
 * - untrusted remote fetch in image build → high
 * - mutable base-image tag → medium
 * - unpinned CI action reference → medium
 * - newly added or changed dependency → low
 */
const RULE_SEVERITY = {
    remoteFetch: 'high',
    mutableBaseImage: 'medium',
    unpinnedAction: 'medium',
    dependencyChange: 'low',
} as const satisfies Record<string, DependencyFinding['severity']>;

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

/** Exact lockfile names across ecosystems. */
const LOCKFILE_NAMES = new Set([
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'bun.lock', 'composer.lock', 'Gemfile.lock', 'Cargo.lock',
    'poetry.lock', 'Pipfile.lock', 'go.sum',
]);

/** Exact package-manifest names across ecosystems. */
const MANIFEST_NAMES = new Set([
    'package.json', 'composer.json', 'Gemfile', 'Cargo.toml', 'go.mod',
    'pyproject.toml', 'Pipfile', 'requirements.txt', 'pom.xml',
    'build.gradle', 'build.gradle.kts', 'ivy.xml',
]);

function isLockfile(path: string): boolean {
    return LOCKFILE_NAMES.has(basename(path));
}

function isManifest(path: string): boolean {
    return MANIFEST_NAMES.has(basename(path));
}

function isDockerfile(path: string): boolean {
    const name = basename(path).toLowerCase();
    return name === 'dockerfile' || name === 'containerfile'
        || name.startsWith('dockerfile.') || name.endsWith('.dockerfile');
}

function isCiWorkflow(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    const name = basename(normalized);
    if (/\.github\/workflows\/.+\.ya?ml$/i.test(normalized)) return true;
    if (name === '.gitlab-ci.yml') return true;
    if (/\.circleci\/config\.ya?ml$/i.test(normalized)) return true;
    if (name === 'azure-pipelines.yml' || name === 'azure-pipelines.yaml') return true;
    return false;
}

/** True when a changed file is relevant to any dependency scanner. */
function isDependencyRelevant(path: string): boolean {
    return isLockfile(path) || isManifest(path) || isDockerfile(path) || isCiWorkflow(path);
}

// ---------------------------------------------------------------------------
// Safe workspace-bounded read
// ---------------------------------------------------------------------------

/** Read a repo-relative file, resolving inside workDir; null when missing/escaping. */
async function readWorkspaceFile(workDir: string, file: string): Promise<string | null> {
    const root = resolve(workDir);
    const target = resolve(join(root, file));
    // Reject any path that escapes the workspace (defensive; changedFiles are repo-relative).
    if (target !== root && !target.startsWith(root + sep)) {
        logger.warn('[dependency-audit] Skipping path outside workspace', { file });
        return null;
    }
    try {
        return await readFile(target, 'utf8');
    } catch {
        // Deleted/moved files or unreadable content — nothing to scan.
        return null;
    }
}

// ---------------------------------------------------------------------------
// Scanners
// ---------------------------------------------------------------------------

/** Full 40- or 64-hex commit SHA — the only immutable CI action pin. */
const FULL_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/**
 * Scan a Dockerfile for mutable base-image tags and untrusted remote fetches.
 */
function scanDockerfile(file: string, content: string): DependencyFinding[] {
    const findings: DependencyFinding[] = [];
    const lines = content.split('\n');
    const stageAliases = new Set<string>();

    lines.forEach((raw, idx) => {
        const line = raw.trim();
        const lineNo = idx + 1;

        // FROM <image>[:tag][@digest] [AS <stage>]
        const fromMatch = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
        if (fromMatch) {
            const imageRef = fromMatch[1];
            const alias = fromMatch[2];
            if (alias) stageAliases.add(alias.toLowerCase());

            if (!isMutableBaseImage(imageRef, stageAliases)) return;
            findings.push({
                severity: RULE_SEVERITY.mutableBaseImage,
                file,
                line: lineNo,
                title: 'Mutable base-image tag',
                issue: `Base image \`${imageRef}\` uses a mutable tag (missing tag or \`latest\`). Pin it to an immutable digest (\`image@sha256:...\`) so builds are reproducible and cannot be silently altered upstream.`,
                category: 'security',
                source: 'dependency-audit',
            });
            return;
        }

        // ADD <remote-url> — fetches an unverified remote resource into the image.
        if (/^ADD\s+.*\bhttps?:\/\//i.test(line)) {
            findings.push({
                severity: RULE_SEVERITY.remoteFetch,
                file,
                line: lineNo,
                title: 'Untrusted remote fetch in image build',
                issue: 'An `ADD` instruction fetches a remote URL directly into the image. Remote content can change or be compromised; download over a verified channel, check a checksum, and prefer `COPY` of vendored artifacts.',
                category: 'security',
                source: 'dependency-audit',
            });
            return;
        }

        // RUN curl|wget ... | sh|bash — pipes untrusted remote script straight to a shell.
        if (/^RUN\b/i.test(line) && /(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i.test(line)) {
            findings.push({
                severity: RULE_SEVERITY.remoteFetch,
                file,
                line: lineNo,
                title: 'Untrusted remote fetch in image build',
                issue: 'A `RUN` instruction pipes a remotely fetched script directly into a shell (`curl ... | sh`). This executes unverified remote code at build time; download, verify a checksum, then execute.',
                category: 'security',
                source: 'dependency-audit',
            });
        }
    });

    return findings;
}

/** Decide whether a Dockerfile `FROM` image reference uses a mutable tag. */
function isMutableBaseImage(imageRef: string, stageAliases: Set<string>): boolean {
    const ref = imageRef.toLowerCase();
    if (ref === 'scratch') return false;            // no image, nothing to pin
    if (stageAliases.has(ref)) return false;        // reference to an earlier build stage
    if (ref.includes('@sha256:')) return false;     // immutable digest pin

    // Isolate the tag: strip any registry host:port, then read the segment after ':'.
    const lastSlash = ref.lastIndexOf('/');
    const namePart = lastSlash >= 0 ? ref.slice(lastSlash + 1) : ref;
    const colon = namePart.indexOf(':');
    if (colon === -1) return true;                  // no tag → defaults to :latest (mutable)
    const tag = namePart.slice(colon + 1);
    return tag === 'latest';
}

/**
 * Scan a CI workflow file for unpinned action references (`uses:` not pinned to
 * a full commit SHA). Local (`./`) and Docker (`docker://`) actions are ignored.
 */
function scanCiWorkflow(file: string, content: string): DependencyFinding[] {
    const findings: DependencyFinding[] = [];
    const lines = content.split('\n');

    lines.forEach((raw, idx) => {
        const match = raw.match(/(?:^|\s)uses:\s*['"]?([^'"\s#]+)['"]?/);
        if (!match) return;

        const ref = match[1];
        if (ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('docker://')) return;

        const at = ref.lastIndexOf('@');
        const gitRef = at >= 0 ? ref.slice(at + 1) : '';
        if (at >= 0 && FULL_SHA.test(gitRef)) return; // pinned to an immutable SHA — safe

        findings.push({
            severity: RULE_SEVERITY.unpinnedAction,
            file,
            line: idx + 1,
            title: 'Unpinned CI action reference',
            issue: `Action \`${ref}\` is not pinned to a full commit SHA${at >= 0 ? ` (uses mutable ref \`${gitRef}\`)` : ' (no ref specified)'}. A tag or branch can be moved to malicious code; pin third-party actions to a full-length commit SHA.`,
            category: 'security',
            source: 'dependency-audit',
        });
    });

    return findings;
}

/**
 * Emit a low-severity finding when a dependency manifest or lockfile changed
 * (R3.2 "newly added or changed dependencies"). File-level granularity: the
 * audit has the changed file list but no base revision to diff against.
 */
function scanDependencyChange(file: string): DependencyFinding[] {
    const kind = isLockfile(file) ? 'lockfile' : 'manifest';
    return [{
        severity: RULE_SEVERITY.dependencyChange,
        file,
        title: 'Dependency changes detected',
        issue: `This ${kind} (\`${basename(file)}\`) changed, adding or updating dependencies. Review new and upgraded packages for supply-chain risk (unfamiliar maintainers, typosquats, unexpected transitive additions).`,
        category: 'security',
        source: 'dependency-audit',
    }];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the Dependency Audit over the changed files.
 *
 * @returns Ground-truth `DependencyFinding[]`. Empty (and near-instant) when no
 *   dependency-relevant file changed (R3.3).
 */
export async function runDependencyAudit(
    input: { workDir: string; changedFiles: string[] },
): Promise<DependencyFinding[]> {
    const { workDir, changedFiles } = input;

    // Negligible cost when nothing relevant changed: no FS access at all (R3.3).
    const relevant = changedFiles.filter(isDependencyRelevant);
    if (relevant.length === 0) return [];

    const findings: DependencyFinding[] = [];

    await Promise.all(relevant.map(async (file) => {
        try {
            // Manifest / lockfile changes are detectable from the file list alone.
            if (isManifest(file) || isLockfile(file)) {
                findings.push(...scanDependencyChange(file));
            }

            // Content-based scanners need to read the file from the workspace.
            if (isDockerfile(file) || isCiWorkflow(file)) {
                const content = await readWorkspaceFile(workDir, file);
                if (content === null) return;
                if (isDockerfile(file)) findings.push(...scanDockerfile(file, content));
                else if (isCiWorkflow(file)) findings.push(...scanCiWorkflow(file, content));
            }
        } catch (err) {
            // A single malformed file must never crash the audit (R9.4).
            logger.error(
                '[dependency-audit] Scanner failed for file',
                err instanceof Error ? err : undefined,
                { file },
            );
        }
    }));

    logger.info('[dependency-audit] Completed', {
        scannedFiles: relevant.length,
        findings: findings.length,
    });

    return findings;
}
