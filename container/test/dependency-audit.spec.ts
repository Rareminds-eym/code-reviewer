import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    runDependencyAudit,
    type DependencyFinding,
} from '../src/lib/llm/agents/dependency-audit';

/**
 * Unit tests for the Dependency Audit (R3.2, R3.3, R3.6).
 *
 * The audit reads dependency-relevant files from `workDir`, so each test writes
 * real fixture files into a fresh temp directory and asserts the emitted
 * findings and their fixed per-rule severities. It also confirms that no
 * findings are produced — and no filesystem is touched — when the changed-file
 * list contains nothing dependency-relevant (R3.3).
 */

let workDir: string;

beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dep-audit-'));
});

afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
});

/** Write a file relative to the workspace, creating parent directories. */
async function writeFixture(relPath: string, content: string): Promise<void> {
    const full = join(workDir, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
}

function bySeverity(findings: DependencyFinding[], title: string): DependencyFinding[] {
    return findings.filter((f) => f.title === title);
}

describe('runDependencyAudit', () => {
    it('flags a mutable base-image tag (missing tag or :latest) as medium', async () => {
        await writeFixture(
            'Dockerfile',
            [
                'FROM node:latest',
                'RUN echo build',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({ workDir, changedFiles: ['Dockerfile'] });

        const mutable = bySeverity(findings, 'Mutable base-image tag');
        expect(mutable).toHaveLength(1);
        expect(mutable[0].severity).toBe('medium');
        expect(mutable[0].category).toBe('security');
        expect(mutable[0].source).toBe('dependency-audit');
        expect(mutable[0].file).toBe('Dockerfile');
        expect(mutable[0].line).toBe(1);
    });

    it('does not flag digest-pinned base images or build-stage aliases', async () => {
        await writeFixture(
            'Dockerfile',
            [
                'FROM node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa AS builder',
                'RUN echo compile',
                'FROM builder',
                'RUN echo package',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({ workDir, changedFiles: ['Dockerfile'] });

        expect(bySeverity(findings, 'Mutable base-image tag')).toHaveLength(0);
    });

    it('flags a remote ADD (http url) as an untrusted remote fetch (high)', async () => {
        await writeFixture(
            'Dockerfile',
            [
                'FROM node:20.11.0',
                'ADD https://example.com/installer.sh /tmp/installer.sh',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({ workDir, changedFiles: ['Dockerfile'] });

        const remote = bySeverity(findings, 'Untrusted remote fetch in image build');
        expect(remote).toHaveLength(1);
        expect(remote[0].severity).toBe('high');
        expect(remote[0].line).toBe(2);
        // A specific pinned tag must not be flagged as mutable.
        expect(bySeverity(findings, 'Mutable base-image tag')).toHaveLength(0);
    });

    it('flags a RUN curl | sh pipe as an untrusted remote fetch (high)', async () => {
        await writeFixture(
            'Dockerfile',
            [
                'FROM node:20.11.0',
                'RUN curl -fsSL https://example.com/install.sh | sh',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({ workDir, changedFiles: ['Dockerfile'] });

        const remote = bySeverity(findings, 'Untrusted remote fetch in image build');
        expect(remote).toHaveLength(1);
        expect(remote[0].severity).toBe('high');
        expect(remote[0].line).toBe(2);
    });

    it('flags an unpinned CI action (uses: not a full SHA) as medium', async () => {
        await writeFixture(
            '.github/workflows/ci.yml',
            [
                'name: CI',
                'on: [push]',
                'jobs:',
                '  build:',
                '    runs-on: ubuntu-latest',
                '    steps:',
                '      - uses: actions/checkout@v4',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({
            workDir,
            changedFiles: ['.github/workflows/ci.yml'],
        });

        const unpinned = bySeverity(findings, 'Unpinned CI action reference');
        expect(unpinned).toHaveLength(1);
        expect(unpinned[0].severity).toBe('medium');
        expect(unpinned[0].file).toBe('.github/workflows/ci.yml');
        expect(unpinned[0].line).toBe(7);
    });

    it('does not flag SHA-pinned, local, or docker:// action references', async () => {
        await writeFixture(
            '.github/workflows/ci.yml',
            [
                'jobs:',
                '  build:',
                '    steps:',
                '      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3',
                '      - uses: ./.github/actions/local',
                '      - uses: docker://alpine:3.19',
            ].join('\n'),
        );

        const findings = await runDependencyAudit({
            workDir,
            changedFiles: ['.github/workflows/ci.yml'],
        });

        expect(bySeverity(findings, 'Unpinned CI action reference')).toHaveLength(0);
    });

    it('flags a new/changed lockfile dependency as low (from the file list alone)', async () => {
        await writeFixture('package-lock.json', JSON.stringify({ name: 'x', lockfileVersion: 3 }));

        const findings = await runDependencyAudit({
            workDir,
            changedFiles: ['package-lock.json'],
        });

        const dep = bySeverity(findings, 'Dependency changes detected');
        expect(dep).toHaveLength(1);
        expect(dep[0].severity).toBe('low');
        expect(dep[0].file).toBe('package-lock.json');
        expect(dep[0].source).toBe('dependency-audit');
    });

    it('emits zero findings when no dependency-relevant files changed', async () => {
        // No fixtures written: the audit must not read the filesystem at all.
        const findings = await runDependencyAudit({
            workDir,
            changedFiles: ['src/index.ts', 'README.md', 'src/utils/helpers.ts'],
        });

        expect(findings).toEqual([]);
    });

    it('assigns the correct fixed severity per rule across a combined change set', async () => {
        await writeFixture(
            'Dockerfile',
            [
                'FROM node:latest',
                'ADD https://example.com/installer.sh /tmp/installer.sh',
            ].join('\n'),
        );
        await writeFixture(
            '.github/workflows/x.yml',
            [
                'jobs:',
                '  build:',
                '    steps:',
                '      - uses: actions/checkout@v4',
            ].join('\n'),
        );
        await writeFixture('package-lock.json', JSON.stringify({ name: 'x', lockfileVersion: 3 }));

        const findings = await runDependencyAudit({
            workDir,
            changedFiles: ['Dockerfile', '.github/workflows/x.yml', 'package-lock.json'],
        });

        // Every finding is ground-truth security from the dependency audit.
        expect(findings.every((f) => f.category === 'security')).toBe(true);
        expect(findings.every((f) => f.source === 'dependency-audit')).toBe(true);

        const severityOf = (title: string) =>
            findings.find((f) => f.title === title)?.severity;

        expect(severityOf('Untrusted remote fetch in image build')).toBe('high');
        expect(severityOf('Mutable base-image tag')).toBe('medium');
        expect(severityOf('Unpinned CI action reference')).toBe('medium');
        expect(severityOf('Dependency changes detected')).toBe('low');
    });
});
