import { execa } from 'execa';
import { rm, access } from 'node:fs/promises';
import { join } from 'node:path';

const GIT_CACHE_BASE = '/mnt/git-cache';

/**
 * Concurrency-safe repository checkout using a reference-cache mirror.
 *
 * Flow:
 * 1. Maintain a bare mirror at /mnt/git-cache/{repo}.git
 * 2. Mirror bootstrap: clone --bare if missing, git fetch if present
 * 3. Reference clone into private workDir (--reference links objects locally)
 * 4. Fetch the exact head SHA + checkout
 *
 * This design prevents network-heavy clones while avoiding concurrent write
 * corruption: the mirror is updated via bare git fetch (append-only), and the
 * active checkout/index/HEAD are local to the ephemeral workDir.
 */
export async function cloneRepository(
	repoFullName: string,
	headSha: string,
	installationToken: string,
	workDir: string,
	signal?: AbortSignal
): Promise<void> {
	const referenceMirror = `${GIT_CACHE_BASE}/${repoFullName}.git`;
	const repoUrl = `https://github.com/${repoFullName}.git`;

	const gitEnv = {
		GITHUB_TOKEN: installationToken,
		GIT_TERMINAL_PROMPT: '0',
		HOME: '/tmp',
	};

	// ── Step 1: Bootstrap or update reference mirror ──
	const mirrorExists = await access(referenceMirror).then(() => true).catch(() => false);

	if (!mirrorExists) {
		// Create parent cache directory
		await execa('mkdir', ['-p', GIT_CACHE_BASE], { timeout: 5_000 });

		console.log(`[git-ops] Creating bare mirror: ${referenceMirror}`);
		await execa('git', ['clone', '--bare', repoUrl, referenceMirror], {
			timeout: 180_000,
			cancelSignal: signal,
			env: gitEnv,
		});
	} else {
		console.log(`[git-ops] Updating existing mirror: ${referenceMirror}`);
		await execa('git', ['--git-dir', referenceMirror, 'fetch', 'origin'], {
			timeout: 120_000,
			cancelSignal: signal,
			env: gitEnv,
		});
	}

	// ── Step 2: Reference clone into workspace ──
	console.log(`[git-ops] Reference-cloning into ${workDir}`);
	await execa('git', [
		'clone',
		'--reference', referenceMirror,
		'--depth=50',
		'--filter=blob:none',
		'--single-branch',
		repoUrl,
		workDir,
	], {
		timeout: 120_000,
		cancelSignal: signal,
		env: gitEnv,
	});

	// ── Step 3: Fetch the exact commit and check it out ──
	console.log(`[git-ops] Fetching and checking out ${headSha}`);
	await execa('git', ['fetch', 'origin', headSha, '--depth=50'], {
		cwd: workDir,
		timeout: 60_000,
		cancelSignal: signal,
		env: { GITHUB_TOKEN: installationToken },
	});

	await execa('git', ['checkout', headSha], {
		cwd: workDir,
		timeout: 15_000,
		cancelSignal: signal,
	});
}

/**
 * List files changed between HEAD and the merge-base with origin/HEAD.
 */
export async function getChangedFiles(workDir: string, signal?: AbortSignal): Promise<string[]> {
	let mergeBase: string;
	try {
		const result = await execa('git', ['merge-base', 'HEAD', 'origin/HEAD'], {
			cwd: workDir,
			timeout: 10_000,
			cancelSignal: signal,
		});
		mergeBase = result.stdout.trim();
	} catch {
		mergeBase = 'HEAD~1';
	}

	const result = await execa('git', ['diff', '--name-only', '--diff-filter=ACMRT', mergeBase, 'HEAD'], {
		cwd: workDir,
		timeout: 10_000,
		cancelSignal: signal,
	});

	return result.stdout
		.split('\n')
		.map((f) => f.trim())
		.filter((f) => f.length > 0)
		.filter((f) => isReviewableFile(f));
}

/**
 * Get the full diff for a specific file.
 */
export async function getFileDiff(workDir: string, filePath: string, signal?: AbortSignal): Promise<string> {
	let mergeBase: string;
	try {
		const result = await execa('git', ['merge-base', 'HEAD', 'origin/HEAD'], {
			cwd: workDir,
			timeout: 10_000,
			cancelSignal: signal,
		});
		mergeBase = result.stdout.trim();
	} catch {
		mergeBase = 'HEAD~1';
	}

	const result = await execa('git', ['diff', mergeBase, 'HEAD', '--', filePath], {
		cwd: workDir,
		timeout: 10_000,
		cancelSignal: signal,
	});
	return result.stdout;
}

function isReviewableFile(filename: string): boolean {
	const skipPatterns = [
		/^node_modules\//,
		/^vendor\//,
		/^dist\//,
		/^build\//,
		/^\.next\//,
		/^coverage\//,
		/\.min\.(js|css)$/,
		/\.map$/,
		/\.lock$/,
		/package-lock\.json$/,
		/yarn\.lock$/,
		/pnpm-lock\.yaml$/,
		/\.generated\./,
		/\.snap$/,
		/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i,
		/\.(mp4|webm|mp3|wav)$/i,
		/\.(zip|tar|gz|bz2)$/i,
		/\.(pdf|doc|docx|xls|xlsx)$/i,
	];
	return !skipPatterns.some((pattern) => pattern.test(filename));
}

/**
 * Clean up the temporary working directory.
 */
export async function cleanup(workDir: string): Promise<void> {
	try {
		await rm(workDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the container is ephemeral anyway
	}
}
