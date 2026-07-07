import type { GitHubPRFile } from '../../types/github';
import type { ReviewFinding } from '../../types/review';
import type { StaticPlugin } from './index';

interface Pattern {
    regex: RegExp;
    title: string;
    issue: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

const SUSPICIOUS_PATTERNS: Pattern[] = [
    {
        regex: /console\.(log|debug|trace|dir)\(/,
        title: 'Leftover debugging code',
        issue: 'Remove `console.log` and similar debugging statements before merging.',
        severity: 'low',
    },
    {
        regex: /TODO\s*\(?(?!.*?https?:\/\/|.*?#\d+)/, // TODO without URL or issue #
        title: 'Untracked TODO comment',
        issue: 'Add an issue link or tracking number to this TODO comment so it is not forgotten.',
        severity: 'low',
    },
    {
        regex: /debugger;/,
        title: 'Leftover debugger statement',
        issue: 'Remove `debugger;` statements before merging, as they will halt execution in environments with devtools open.',
        severity: 'medium',
    },
    {
        regex: /password\s*=\s*(['"][^'"]+['"])/i,
        title: 'Potential Hardcoded Password',
        issue: 'Detected a string assignment to a variable named "password". Secrets must be loaded via environment variables or secret managers.',
        severity: 'high',
    }
];

export class SuspiciousPatternsPlugin implements StaticPlugin {
    name = 'suspicious-patterns';

    run(files: GitHubPRFile[]): ReviewFinding[] {
        const findings: ReviewFinding[] = [];

        for (const file of files) {
            if (!file.patch || file.status === 'removed') continue;

            // Only scan added lines in the patch (lines starting with '+', but not '+++')
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

                    for (const pattern of SUSPICIOUS_PATTERNS) {
                        if (pattern.regex.test(content)) {
                            findings.push({
                                file: file.filename,
                                line: currentLine,
                                severity: pattern.severity,
                                title: pattern.title,
                                issue: pattern.issue,
                                category: 'clean-code',
                            });
                        }
                    }
                    currentLine++;
                } else if (!line.startsWith('-')) {
                    // Context line
                    currentLine++;
                }
            }
        }

        return findings;
    }
}
