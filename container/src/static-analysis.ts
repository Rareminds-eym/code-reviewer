import { execa } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { StaticFinding } from './types.js';

/**
 * Run all static analyzers against the changed files.
 * Each tool runs as a child process and its output is parsed into structured findings.
 */
export async function runStaticAnalysis(workDir: string, changedFiles: string[], signal?: AbortSignal): Promise<StaticFinding[]> {
	const findings: StaticFinding[] = [];
	const existingFiles = changedFiles.filter((f) => existsSync(join(workDir, f)));

	if (existingFiles.length === 0) return [];

	// Run all analyzers in parallel for speed
	const [oxlintResults, biomeResults, semgrepResults] = await Promise.allSettled([
		runOxlint(workDir, existingFiles, signal),
		runBiome(workDir, existingFiles, signal),
		runSemgrep(workDir, existingFiles, signal),
	]);

	if (oxlintResults.status === 'fulfilled') findings.push(...oxlintResults.value);
	else console.warn('[static-analysis] oxlint failed:', oxlintResults.reason);

	if (biomeResults.status === 'fulfilled') findings.push(...biomeResults.value);
	else console.warn('[static-analysis] biome failed:', biomeResults.reason);

	if (semgrepResults.status === 'fulfilled') findings.push(...semgrepResults.value);
	else console.warn('[static-analysis] semgrep failed:', semgrepResults.reason);

	return findings;
}

/**
 * Run oxlint (ESLint-compatible, 100x faster, no node_modules needed).
 */
async function runOxlint(workDir: string, changedFiles: string[], signal?: AbortSignal): Promise<StaticFinding[]> {
	const tsFiles = changedFiles.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
	if (tsFiles.length === 0) return [];

	try {
		const result = await execa('oxlint', ['--format=json', ...tsFiles.map((f) => join(workDir, f))], {
			timeout: 30_000,
			cancelSignal: signal,
			reject: false, // Don't throw on non-zero exit (lint errors cause exit 1)
		});

		return parseOxlintOutput(result.stdout, workDir);
	} catch (err) {
		console.warn('[oxlint] Execution failed:', err);
		return [];
	}
}

function parseOxlintOutput(stdout: string, workDir: string): StaticFinding[] {
	if (!stdout.trim()) return [];

	try {
		const parsed = JSON.parse(stdout);
		if (!Array.isArray(parsed)) return [];

		return parsed.map((item: any) => ({
			tool: 'oxlint' as const,
			rule: item.ruleId || item.rule || 'unknown',
			message: item.message || '',
			file: (item.filePath || item.file || '').replace(workDir + '/', ''),
			line: item.line || item.startLine || 0,
			column: item.column || item.startColumn || undefined,
			severity: mapSeverity(item.severity),
		}));
	} catch {
		// If JSON parsing fails, try line-by-line parsing
		return parseOxlintTextOutput(stdout, workDir);
	}
}

function parseOxlintTextOutput(stdout: string, workDir: string): StaticFinding[] {
	const findings: StaticFinding[] = [];
	const lineRegex = /^(.+):(\d+):(\d+):\s*(error|warning|info)\s*(.+?)(?:\s*\[(.+)\])?$/;

	for (const line of stdout.split('\n')) {
		const match = line.match(lineRegex);
		if (match) {
			findings.push({
				tool: 'oxlint',
				rule: match[6] || 'unknown',
				message: match[5].trim(),
				file: match[1].replace(workDir + '/', ''),
				line: parseInt(match[2], 10),
				column: parseInt(match[3], 10),
				severity: match[4] as 'error' | 'warning' | 'info',
			});
		}
	}

	return findings;
}

/**
 * Run Biome check for lint + format violations.
 */
async function runBiome(workDir: string, changedFiles: string[], signal?: AbortSignal): Promise<StaticFinding[]> {
	const tsFiles = changedFiles.filter((f) => /\.(ts|tsx|js|jsx|json)$/.test(f));
	if (tsFiles.length === 0) return [];

	try {
		const result = await execa('biome', ['check', '--reporter=json', ...tsFiles.map((f) => join(workDir, f))], {
			timeout: 30_000,
			cancelSignal: signal,
			reject: false,
		});

		return parseBiomeOutput(result.stdout, workDir);
	} catch (err) {
		console.warn('[biome] Execution failed:', err);
		return [];
	}
}

function parseBiomeOutput(stdout: string, workDir: string): StaticFinding[] {
	if (!stdout.trim()) return [];

	try {
		const parsed = JSON.parse(stdout);
		const diagnostics = parsed.diagnostics || parsed;
		if (!Array.isArray(diagnostics)) return [];

		return diagnostics.map((d: any) => ({
			tool: 'biome' as const,
			rule: d.category || d.rule?.name || 'unknown',
			message: d.message || d.description || '',
			file: (d.file?.path || d.location?.file || '').replace(workDir + '/', ''),
			line: d.location?.start?.line || d.span?.start?.line || 0,
			column: d.location?.start?.column || undefined,
			severity: mapSeverity(d.severity),
		}));
	} catch {
		return [];
	}
}

/**
 * Run Semgrep for SAST security scanning.
 */
async function runSemgrep(workDir: string, changedFiles: string[], signal?: AbortSignal): Promise<StaticFinding[]> {
	const tsFiles = changedFiles.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
	if (tsFiles.length === 0) return [];

	try {
		const result = await execa(
			'semgrep',
			['scan', '--json', '--config=auto', '--severity=WARNING', '--severity=ERROR', ...tsFiles.map((f) => join(workDir, f))],
			{
				timeout: 60_000, // Semgrep can be slow on first run
				cancelSignal: signal,
				reject: false,
				env: {
					...process.env,
					SEMGREP_SEND_METRICS: 'off', // Don't phone home
				},
			}
		);

		return parseSemgrepOutput(result.stdout, workDir);
	} catch (err) {
		console.warn('[semgrep] Execution failed:', err);
		return [];
	}
}

function parseSemgrepOutput(stdout: string, workDir: string): StaticFinding[] {
	if (!stdout.trim()) return [];

	try {
		const parsed = JSON.parse(stdout);
		const results = parsed.results || [];

		return results.map((r: any) => ({
			tool: 'semgrep' as const,
			rule: r.check_id || 'unknown',
			message: r.extra?.message || r.extra?.metadata?.message || '',
			file: (r.path || '').replace(workDir + '/', ''),
			line: r.start?.line || 0,
			column: r.start?.col || undefined,
			severity: mapSemgrepSeverity(r.extra?.severity || r.severity),
		}));
	} catch {
		return [];
	}
}

function mapSeverity(severity: string | number): 'error' | 'warning' | 'info' {
	if (typeof severity === 'number') {
		return severity <= 1 ? 'error' : severity === 2 ? 'warning' : 'info';
	}
	const s = String(severity).toLowerCase();
	if (s === 'error' || s === 'critical' || s === 'high') return 'error';
	if (s === 'warning' || s === 'medium' || s === 'warn') return 'warning';
	return 'info';
}

function mapSemgrepSeverity(severity: string): 'error' | 'warning' | 'info' {
	const s = String(severity).toUpperCase();
	if (s === 'ERROR') return 'error';
	if (s === 'WARNING') return 'warning';
	return 'info';
}
