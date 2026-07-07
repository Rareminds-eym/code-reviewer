/**
 * Unit tests for validation utilities
 */

import { describe, it, expect } from 'vitest';
import {
    validateRepoIdentifier,
    validatePRNumber,
    validateCommitSha,
    validateLimit,
    validateTokenUsage,
} from '../src/lib/validation';
import { ValidationError } from '../src/lib/errors';

describe('validateRepoIdentifier', () => {
    it('should accept valid repo identifiers', () => {
        expect(validateRepoIdentifier('myorg', 'owner')).toBe('myorg');
        expect(validateRepoIdentifier('my-org', 'owner')).toBe('my-org');
        expect(validateRepoIdentifier('my_org', 'owner')).toBe('my_org');
        expect(validateRepoIdentifier('my.org', 'owner')).toBe('my.org');
        expect(validateRepoIdentifier('org123', 'owner')).toBe('org123');
    });

    it('should trim whitespace', () => {
        expect(validateRepoIdentifier('  myorg  ', 'owner')).toBe('myorg');
    });

    it('should reject empty strings', () => {
        expect(() => validateRepoIdentifier('', 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier('   ', 'owner')).toThrow(ValidationError);
    });

    it('should reject invalid characters', () => {
        expect(() => validateRepoIdentifier('my org', 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier('my/org', 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier('my@org', 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier('my<org>', 'owner')).toThrow(ValidationError);
    });

    it('should reject path traversal attempts', () => {
        expect(() => validateRepoIdentifier('../etc', 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier('org//repo', 'owner')).toThrow(ValidationError);
    });

    it('should reject strings that are too long', () => {
        const longString = 'a'.repeat(101);
        expect(() => validateRepoIdentifier(longString, 'owner')).toThrow(ValidationError);
    });

    it('should reject non-string values', () => {
        expect(() => validateRepoIdentifier(null as any, 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier(undefined as any, 'owner')).toThrow(ValidationError);
        expect(() => validateRepoIdentifier(123 as any, 'owner')).toThrow(ValidationError);
    });
});

describe('validatePRNumber', () => {
    it('should accept valid PR numbers', () => {
        expect(validatePRNumber(1)).toBe(1);
        expect(validatePRNumber(123)).toBe(123);
        expect(validatePRNumber(999999)).toBe(999999);
    });

    it('should parse string numbers', () => {
        expect(validatePRNumber('123')).toBe(123);
        expect(validatePRNumber('1')).toBe(1);
    });

    it('should reject invalid numbers', () => {
        expect(() => validatePRNumber(0)).toThrow(ValidationError);
        expect(() => validatePRNumber(-1)).toThrow(ValidationError);
        expect(() => validatePRNumber(1000000000)).toThrow(ValidationError);
    });

    it('should reject non-integers', () => {
        expect(() => validatePRNumber(123.45)).toThrow(ValidationError);
    });

    it('should reject non-numeric values', () => {
        expect(() => validatePRNumber('abc')).toThrow(ValidationError);
        expect(() => validatePRNumber(NaN)).toThrow(ValidationError);
        expect(() => validatePRNumber(null as any)).toThrow(ValidationError);
    });
});

describe('validateCommitSha', () => {
    it('should accept valid commit SHAs', () => {
        expect(validateCommitSha('abc123f')).toBe('abc123f');
        expect(validateCommitSha('1234567890abcdef1234567890abcdef12345678')).toBe('1234567890abcdef1234567890abcdef12345678');
    });

    it('should convert to lowercase', () => {
        expect(validateCommitSha('ABC123F')).toBe('abc123f');
    });

    it('should reject invalid SHAs', () => {
        expect(() => validateCommitSha('abc')).toThrow(ValidationError); // Too short
        expect(() => validateCommitSha('xyz123')).toThrow(ValidationError); // Invalid chars
        expect(() => validateCommitSha('abc123f' + 'x'.repeat(40))).toThrow(ValidationError); // Too long
    });

    it('should reject non-string values', () => {
        expect(() => validateCommitSha(null as any)).toThrow(ValidationError);
        expect(() => validateCommitSha(123 as any)).toThrow(ValidationError);
    });
});

describe('validateLimit', () => {
    it('should accept valid limits', () => {
        expect(validateLimit(1, 1000)).toBe(1);
        expect(validateLimit(50, 1000)).toBe(50);
        expect(validateLimit(1000, 1000)).toBe(1000);
    });

    it('should parse string numbers', () => {
        expect(validateLimit('50', 1000)).toBe(50);
    });

    it('should return default for undefined', () => {
        expect(validateLimit(undefined, 1000)).toBe(100);
        expect(validateLimit(null, 1000)).toBe(100);
    });

    it('should reject invalid limits', () => {
        expect(() => validateLimit(0, 1000)).toThrow(ValidationError);
        expect(() => validateLimit(-1, 1000)).toThrow(ValidationError);
        expect(() => validateLimit(1001, 1000)).toThrow(ValidationError);
    });

    it('should reject non-integers', () => {
        expect(() => validateLimit(50.5, 1000)).toThrow(ValidationError);
    });
});

describe('validateTokenUsage', () => {
    it('should accept valid token usage', () => {
        const usage = {
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 1500,
        };
        expect(validateTokenUsage(usage)).toEqual(usage);
    });

    it('should reject negative token counts', () => {
        expect(() => validateTokenUsage({
            inputTokens: -1,
            outputTokens: 500,
            totalTokens: 499,
        })).toThrow(ValidationError);
    });

    it('should reject token counts that are too large', () => {
        expect(() => validateTokenUsage({
            inputTokens: 20000000,
            outputTokens: 500,
            totalTokens: 20000500,
        })).toThrow(ValidationError);
    });

    it('should reject mismatched totals', () => {
        expect(() => validateTokenUsage({
            inputTokens: 1000,
            outputTokens: 500,
            totalTokens: 2000, // Should be 1500
        })).toThrow(ValidationError);
    });

    it('should reject non-numeric values', () => {
        expect(() => validateTokenUsage({
            inputTokens: 'abc' as any,
            outputTokens: 500,
            totalTokens: 500,
        })).toThrow(ValidationError);
    });

    it('should reject non-object values', () => {
        expect(() => validateTokenUsage(null)).toThrow(ValidationError);
        expect(() => validateTokenUsage('string' as any)).toThrow(ValidationError);
    });
});
