import { describe, it, expect } from 'vitest';
import {
    buildStage1SystemPrompt,
    buildStage2SystemPrompt,
    YAGNI_VALIDATION_LADDER,
    ZERO_TRUST_POLICY,
} from '../src/config/prompts/dual-agent';

describe('Dual-Agent Prompts', () => {
    describe('buildStage1SystemPrompt', () => {
        it('includes YAGNI validation ladder for all personas', () => {
            for (const persona of ['architect', 'sre', 'security'] as const) {
                const prompt = buildStage1SystemPrompt(persona);
                expect(prompt).toContain('YAGNI Validation Ladder');
                expect(prompt).toContain('Rung 1');
                expect(prompt).toContain('Rung 2');
                expect(prompt).toContain('Rung 3');
                expect(prompt).toContain('Rung 4');
            }
        });

        it('includes zero-trust policy', () => {
            const prompt = buildStage1SystemPrompt('architect');
            expect(prompt).toContain('Zero-Trust');
            expect(prompt).toContain('Verify by Direct Code Sweep');
        });

        it('includes persona-specific content', () => {
            const archPrompt = buildStage1SystemPrompt('architect');
            expect(archPrompt).toContain('System Architect');
            expect(archPrompt).toContain('Component Boundaries');

            const srePrompt = buildStage1SystemPrompt('sre');
            expect(srePrompt).toContain('Reliability Engineer');
            expect(srePrompt).toContain('Async Race Conditions');

            const secPrompt = buildStage1SystemPrompt('security');
            expect(secPrompt).toContain('Security Engineer');
            expect(secPrompt).toContain('Input Validation');
        });

        it('includes optional static findings context', () => {
            const prompt = buildStage1SystemPrompt('architect', undefined, 'oxlint finding in src/main.ts');
            expect(prompt).toContain('Static Analysis Ground Truth');
            expect(prompt).toContain('oxlint finding');
        });

        it('includes optional graphify context', () => {
            const prompt = buildStage1SystemPrompt('architect', undefined, undefined, '\n\n## Graph Data\nNodes: 42');
            expect(prompt).toContain('Graph Data');
        });

        it('includes custom rules when provided', () => {
            const prompt = buildStage1SystemPrompt('architect', 'No console.log statements');
            expect(prompt).toContain('Repository-Specific Rules');
            expect(prompt).toContain('No console.log');
        });

        it('includes JSON output format instruction', () => {
            const prompt = buildStage1SystemPrompt('architect');
            expect(prompt).toContain('Output Format');
            expect(prompt).toContain('"findings"');
        });
    });

    describe('buildStage2SystemPrompt', () => {
        it('includes verifier role description', () => {
            const prompt = buildStage2SystemPrompt();
            expect(prompt).toContain('Verification Agent');
            expect(prompt).toContain('Context & Line Validation');
            expect(prompt).toContain('Policy Compliance');
            expect(prompt).toContain('Fix Correctness');
        });

        it('includes diff context when provided', () => {
            const diff = '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old code\n+new code';
            const prompt = buildStage2SystemPrompt(diff);
            expect(prompt).toContain(diff);
        });

        it('includes output format specification', () => {
            const prompt = buildStage2SystemPrompt();
            expect(prompt).toContain('verifiedFindings');
            expect(prompt).toContain('rejectedFindings');
        });
    });

    describe('YAGNI_VALIDATION_LADDER', () => {
        it('contains all 4 rungs', () => {
            expect(YAGNI_VALIDATION_LADDER).toContain('Rung 1');
            expect(YAGNI_VALIDATION_LADDER).toContain('Rung 2');
            expect(YAGNI_VALIDATION_LADDER).toContain('Rung 3');
            expect(YAGNI_VALIDATION_LADDER).toContain('Rung 4');
        });

        it('discourages stylistic nits', () => {
            expect(YAGNI_VALIDATION_LADDER).toContain('stylistic');
        });
    });

    describe('ZERO_TRUST_POLICY', () => {
        it('mandates direct code verification', () => {
            expect(ZERO_TRUST_POLICY).toContain('Code is the Sole Source of Truth');
        });

        it('treats comments as untrusted', () => {
            expect(ZERO_TRUST_POLICY).toContain('untrusted historical assertions');
        });
    });
});
