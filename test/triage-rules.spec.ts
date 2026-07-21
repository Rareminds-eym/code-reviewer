/**
 * Tests for the Triage_Gatekeeper rules (R1).
 *
 * Covers the deterministic track classification of `triagePR` and two
 * property-based invariants:
 *   - Security-floor monotonicity (Property 10): a security path or label
 *     always forces `deep`.
 *   - Router-ish totality: `triagePR` always returns a valid track.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.7, 1.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { triagePR, DEFAULT_TRIAGE_CONFIG } from '../src/lib/triage-rules';
import type { TriageInput } from '../src/lib/triage-types';

const CFG = DEFAULT_TRIAGE_CONFIG;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type File = NonNullable<TriageInput['files']>[number];

function file(filename: string, additions = 1, deletions = 0, status = 'modified'): File {
	return { filename, status, additions, deletions };
}

function input(partial: Partial<TriageInput>): TriageInput {
	return {
		labels: [],
		title: 'chore: update',
		targetBranch: 'main',
		...partial,
	};
}

const VALID_TRACKS = new Set(['fast', 'full', 'deep']);

// ---------------------------------------------------------------------------
// Unit tests: documented precedence (R1.1-R1.3, R1.6-R1.8)
// ---------------------------------------------------------------------------

describe('triagePR — unit', () => {
	it('docs-only small change → fast (R1.3)', () => {
		const d = triagePR(
			input({ files: [file('README.md', 5), file('docs/guide.md', 10)] }),
			CFG,
		);
		expect(d.track).toBe('fast');
		expect(d.reason).toBe('docs-only');
		expect(d.provisional).toBe(false);
		expect(d.skipAgents.length).toBeGreaterThan(0);
	});

	it('all-doc but large change → full, never fast (R1.3)', () => {
		const d = triagePR(
			input({ files: [file('README.md', 5000)] }),
			CFG,
		);
		expect(d.track).toBe('full');
		expect(d.reason).toBe('large');
	});

	it('lockfile present → not fast, at least full (R1.6)', () => {
		const d = triagePR(
			input({ files: [file('README.md', 3), file('package-lock.json', 4)] }),
			CFG,
		);
		expect(d.track).not.toBe('fast');
		expect(d.track).toBe('full');
		expect(d.reason).toBe('dependency-change');
	});

	it('security-sensitive path → deep regardless of size (R1.2)', () => {
		const d = triagePR(
			input({ files: [file('src/auth/login.ts', 2)] }),
			CFG,
		);
		expect(d.track).toBe('deep');
		expect(d.reason).toBe('security-sensitive');
	});

	it('security label → deep regardless of files (R1.2)', () => {
		const d = triagePR(
			input({ files: [file('README.md', 1)], labels: ['security'] }),
			CFG,
		);
		expect(d.track).toBe('deep');
		expect(d.reason).toBe('security-sensitive');
	});

	it('mixed doc + code file → full (R1.7)', () => {
		const d = triagePR(
			input({ files: [file('README.md', 3), file('src/index.ts', 4)] }),
			CFG,
		);
		expect(d.track).toBe('full');
		expect(d.reason).toBe('default');
	});

	it('changed-file list absent → provisional full (R1.8)', () => {
		const d = triagePR(input({ files: undefined }), CFG);
		expect(d.track).toBe('full');
		expect(d.provisional).toBe(true);
		expect(d.reason).toBe('provisional');
	});

	it('changed-file list absent but security label → provisional deep (R1.2/R1.8)', () => {
		const d = triagePR(input({ files: undefined, labels: ['CVE'] }), CFG);
		expect(d.track).toBe('deep');
		expect(d.provisional).toBe(true);
		expect(d.reason).toBe('security-sensitive');
	});
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

// Arbitrary file paths drawn from a mix of realistic and random segments.
const arbSegment = fc.oneof(
	fc.constantFrom('src', 'lib', 'test', 'docs', 'components', 'utils', 'a', 'b'),
	fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
);
const arbExt = fc.constantFrom('ts', 'js', 'md', 'json', 'yml', 'txt', 'go', 'rs', 'py');
const arbFilename = fc
	.tuple(fc.array(arbSegment, { minLength: 0, maxLength: 3 }), arbSegment, arbExt)
	.map(([dirs, name, ext]) => [...dirs, `${name}.${ext}`].join('/'));

const arbFile = fc.record({
	filename: arbFilename,
	status: fc.constantFrom('added', 'modified', 'removed'),
	additions: fc.nat({ max: 2000 }),
	deletions: fc.nat({ max: 2000 }),
});

const arbInput = fc.record({
	files: fc.option(fc.array(arbFile, { maxLength: 8 }), { nil: undefined }),
	labels: fc.array(fc.string(), { maxLength: 4 }),
	title: fc.string(),
	targetBranch: fc.constantFrom('main', 'develop', 'release'),
});

describe('triagePR — properties', () => {
	// Property 10: Security-floor monotonicity (R1.2, R11.3).
	// Injecting a security-sensitive path forces `deep` regardless of other files.
	it('Property 10: any security path forces deep', () => {
		fc.assert(
			fc.property(arbInput, (base) => {
				const files = [...(base.files ?? []), file('src/auth/session.ts', 3)];
				const d = triagePR({ ...base, files }, CFG);
				expect(d.track).toBe('deep');
			}),
		);
	});

	// Property 10 (label form): a security label forces `deep` even when the
	// file list is absent (provisional path).
	it('Property 10: any security label forces deep', () => {
		fc.assert(
			fc.property(arbInput, (base) => {
				const d = triagePR({ ...base, labels: [...base.labels, 'security'] }, CFG);
				expect(d.track).toBe('deep');
			}),
		);
	});

	// Property 10 (implication): for ANY generated input, if a security signal
	// is present the resulting track MUST be `deep`. A security label (matched
	// case-insensitively) or a security-sensitive path segment (e.g. `/auth/`)
	// both qualify.
	it('Property 10: security signal present ⇒ track is deep', () => {
		const secLabels = new Set(CFG.securityLabels.map((l) => l.toLowerCase()));
		fc.assert(
			fc.property(arbInput, (inp) => {
				const hasSecurityLabel = inp.labels.some((l) => secLabels.has(l.toLowerCase()));
				const hasSecurityPath =
					!!inp.files && inp.files.some((f) => f.filename.includes('/auth/'));
				if (hasSecurityLabel || hasSecurityPath) {
					expect(triagePR(inp, CFG).track).toBe('deep');
				}
			}),
		);
	});

	// Router-ish totality: triagePR always returns exactly one valid track and a
	// well-formed decision for any input.
	it('totality: always returns a valid track and decision shape', () => {
		fc.assert(
			fc.property(arbInput, (inp) => {
				const d = triagePR(inp, CFG);
				expect(VALID_TRACKS.has(d.track)).toBe(true);
				expect(typeof d.reason).toBe('string');
				expect(typeof d.provisional).toBe('boolean');
				expect(Array.isArray(d.skipAgents)).toBe(true);
				// Provisional iff the file list was absent (R1.8).
				expect(d.provisional).toBe(inp.files === undefined);
			}),
		);
	});
});
