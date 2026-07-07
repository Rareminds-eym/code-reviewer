import type { GitHubPRFile } from '../../types/github';
import type { ReviewFinding } from '../../types/review';
import type { StaticPlugin } from './index';

interface Pattern {
    regex: RegExp;
    title: string;
    issue: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

const TS_STRICT_PATTERNS: Pattern[] = [
    {
        regex: /@ts-ignore/,
        title: 'Banned `@ts-ignore` directive',
        issue: 'Do not use `@ts-ignore`. If disabling type-checking is absolutely necessary, use `@ts-expect-error` with a comment explaining why.',
        severity: 'high',
    },
    {
        regex: /:\s*any\b/,
        title: 'Use of `any` type',
        issue: 'Avoid implicit or explicit `any`. Use `unknown` if the type is truly unknown, or define a proper interface/type.',
        severity: 'medium',
    },
    {
        regex: /as\s+any\b/,
        title: 'Type assertion to `any`',
        issue: 'Casting to `any` defeats TypeScript\'s strict mode guarantees. Use `unknown` or a specific type instead.',
        severity: 'medium',
    }
];

export class TsStrictPlugin implements StaticPlugin {
    name = 'ts-strict';

    run(files: GitHubPRFile[]): ReviewFinding[] {
        const findings: ReviewFinding[] = [];

        for (const file of files) {
            // Only scan TypeScript files
            if (!file.filename.endsWith('.ts') && !file.filename.endsWith('.tsx')) continue;
            if (!file.patch || file.status === 'removed') continue;

            const lines = file.patch.split('\n');
            let currentLineMatch = file.patch.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
            let currentLine = currentLineMatch ? parseInt(currentLineMatch[1], 10) : 1;

            for (const line of lines) {
                if (line.startsWith('@@ ')) {
                    const match = line.match(/@@ -\d+,\d+ \+(\d+),\d+ @@/);
                    if (match) currentLine = parseInt(match[1], 10);
                    continue;
                }

                if (line.startsWith('+') && !line.startsWith('+++')) {
                    const content = line.substring(1);

                    for (const pattern of TS_STRICT_PATTERNS) {
                        if (pattern.regex.test(content)) {
                            findings.push({
                                file: file.filename,
                                line: currentLine,
                                severity: pattern.severity,
                                title: pattern.title,
                                issue: pattern.issue,
                                category: 'type-safety',
                            });
                        }
                    }
                    currentLine++;
                } else if (!line.startsWith('-')) {
                    currentLine++;
                }
            }
        }

        return findings;
    }
}
