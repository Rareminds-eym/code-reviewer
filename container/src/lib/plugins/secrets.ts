import type { GitHubPRFile } from '../../types/github';
import type { ReviewFinding } from '../../types/review';
import type { StaticPlugin } from './index';

interface SecretPattern {
    regex: RegExp;
    title: string;
    description: string;
    severity: 'critical' | 'high';
}

const SECRET_PATTERNS: SecretPattern[] = [
    {
        regex: /(?:api_key|apikey|secret|token|password|auth|credential)[^\w]{0,5}['"]?[:=]['"]?\s*['"]([A-Za-z0-9+/=_\-\.]{15,})['"]/i,
        title: 'Hardcoded Secret Detected',
        description: 'A hardcoded secret, API key, or credential was detected. Never commit secrets to version control. Pass them via environment variables or a secret vault.',
        severity: 'critical',
    },
    {
        regex: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/,
        title: 'GitHub Token Detected',
        description: 'A GitHub personal access token (PAT) was detected. Revoke this token immediately and use short-lived environment-injected tokens.',
        severity: 'critical',
    },
    {
        regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
        title: 'Hardcoded JWT Detected',
        description: 'A JSON Web Token (JWT) was detected. Hardcoded JWTs indicate severe architectural flaws or leaked credentials.',
        severity: 'critical',
    },
    {
        regex: /AIza[0-9A-Za-z\\-_]{35}/,
        title: 'Google API Key Detected',
        description: 'A Google API key was detected. Inject API keys at runtime via environment variables rather than embedding them in source code.',
        severity: 'critical',
    },
    {
        regex: /sk-[a-zA-Z0-9]{48}/,
        title: 'OpenAI API Key Detected',
        description: 'An OpenAI secret API key was detected. Revoke it immediately and inject via environment variables.',
        severity: 'critical',
    },
    {
        regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
        title: 'Private Key Detected',
        description: 'A cryptographic private key was detected. Never commit private keys to version control.',
        severity: 'critical',
    }
];

export class SecretsScannerPlugin implements StaticPlugin {
    name = 'secret-scanner';

    run(files: GitHubPRFile[]): ReviewFinding[] {
        const findings: ReviewFinding[] = [];

        for (const file of files) {
            // Do not scan deleted files
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

                    for (const pattern of SECRET_PATTERNS) {
                        if (pattern.regex.test(content)) {
                            findings.push({
                                file: file.filename,
                                line: currentLine,
                                severity: pattern.severity,
                                title: pattern.title,
                                issue: pattern.description, // using issue instead of description for ReviewFinding
                                category: 'security',
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
