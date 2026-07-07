import type { Env, ReviewMessage } from '../types/env';
import { getContainer } from '@cloudflare/containers';
import { logger } from '../lib/logger';
import { runWithContextAsync } from '../lib/request-context';
import { getInstallationToken } from '../lib/github-auth';
import { updateCheckRun, postPRComment } from '../lib/github';
import { postToCliq } from '../lib/cliq';

const CONTAINER_TIMEOUT_MS = 240_000; // 4 minutes

/**
 * Wraps an async function with a timeout guard.
 */
async function withTimeout<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await Promise.race([
			fn(controller.signal),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () =>
					reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`))
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Queue handler that dispatches PR reviews to the isolated Docker container.
 * Symmetrically handles retry and acknowledgement semantics.
 */
export async function queueHandler(
	batch: MessageBatch<ReviewMessage>,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	// Safety guard: reject batches > 1 to prevent subrequest budget issues.
	if (batch.messages.length > 1) {
		logger.error('Queue batch size > 1 is not supported', undefined, {
			batchSize: batch.messages.length,
		});
		for (const msg of batch.messages) msg.ack();
		return;
	}

	const processingPromises = batch.messages.map(async (message) => {
		const { prNumber, title, repoFullName, headSha, requestId, checkRunId } = message.body;

		const context = {
			requestId: requestId || `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
			startTime: Date.now(),
			prNumber,
			repoFullName,
		};

		// ── Safety Timeout Net ──
		let timerId: ReturnType<typeof setTimeout> | undefined;
		let timeoutResolver: (() => void) | undefined;
		
		const safetyNet = new Promise<void>((resolve) => {
			timeoutResolver = resolve;
		});

		if (checkRunId) {
			const SAFETY_TIMEOUT_MS = 14 * 60 * 1000; // 14 minutes
			timerId = setTimeout(async () => {
				try {
					const token = await getInstallationToken(env);
					await updateCheckRun(
						repoFullName,
						checkRunId,
						token,
						'timed_out',
						'⏰ The code review container did not complete within 14 minutes. Retrying...'
					);
					logger.warn('Safety net timeout fired — marked Check Run as timed out', { prNumber, checkRunId });
				} catch {
					// Best-effort
				} finally {
					if (timeoutResolver) timeoutResolver();
				}
			}, SAFETY_TIMEOUT_MS);
			
			ctx.waitUntil(safetyNet);
		}

		return runWithContextAsync(context, async () => {
			try {
				await processMessage(message, env);
			} finally {
				if (timerId) clearTimeout(timerId);
				if (timeoutResolver) timeoutResolver();
			}
		});
	});

	await Promise.all(processingPromises);
}

/**
 * Dispatches the PR details to the container.
 * No secrets or tokens are passed in the POST body.
 */
async function processMessage(
	message: Message<ReviewMessage>,
	env: Env
): Promise<void> {
	const { prNumber, title, repoFullName, headSha, checkRunId, prAuthor, prDescription } = message.body;

	logger.info('Processing PR via Container', {
		prNumber,
		title,
		repoFullName,
		headSha,
	});

	if (!env.REVIEW_CONTAINER) {
		throw new Error('REVIEW_CONTAINER binding is missing. Cannot review PR.');
	}

	// ── Dispatch to Container ──
	let token: string;
	try {
		token = await getInstallationToken(env);
	} catch (authErr) {
		logger.error('Failed to obtain token for Check Run setup', authErr instanceof Error ? authErr : undefined);
		message.retry();
		return;
	}

	try {
		const container = getContainer(env.REVIEW_CONTAINER, `pr-${repoFullName.replace('/', '-')}-${prNumber}`);

		const response = await withTimeout(
			async () => {
				return container.fetch(
					new Request('http://container/review', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							repoFullName,
							prNumber,
							headSha,
							title,
							prAuthor,
							prDescription,
							checkRunId,
						}),
					})
				);
			},
			CONTAINER_TIMEOUT_MS,
			'ContainerReview'
		);

		if (!response.ok) {
			const errorBody = await response.text().catch(() => 'unknown');
			const status = response.status;
			throw new Error(`Container review failed with status ${status}: ${errorBody.slice(0, 500)}`);
		}

		logger.info('Container review completed successfully', { prNumber });
		message.ack();

	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		logger.error('Container dispatch failed, raising failure alerts', error instanceof Error ? error : undefined, {
			prNumber,
		});

		// ── Step 12: Notification on Pipeline Crash ──
		if (env.CLIQ_CLIENT_ID && env.CLIQ_CLIENT_SECRET && env.CLIQ_REFRESH_TOKEN && env.CLIQ_BOT_NAME && env.CLIQ_CHANNEL_ID) {
			try {
				await postToCliq(
					env.CLIQ_CLIENT_ID,
					env.CLIQ_CLIENT_SECRET,
					env.CLIQ_REFRESH_TOKEN,
					env.CLIQ_BOT_NAME,
					env.CLIQ_CHANNEL_ID,
					repoFullName,
					prNumber,
					title,
					prAuthor ?? 'unknown',
					'failure',
					{ critical: 0, high: 0, medium: 0, low: 0 },
					env.CLIQ_DB_NAME,
					[errMsg]
				);
			} catch {
				logger.error('Could not post outer error to Cliq', undefined, { prNumber });
			}
		}

		try {
			await postPRComment(
				repoFullName,
				prNumber,
				`> ⚠️ **Code Reviewer Agent Error**\n` +
				`> The automated review container failed unexpectedly. Retrying...\n\n` +
				`**Error:** \`${errMsg}\``,
				token
			);
		} catch {
			logger.error('Could not post error comment to PR', undefined, { prNumber });
		}

		if (checkRunId) {
			try {
				await updateCheckRun(
					repoFullName,
					checkRunId,
					token,
					'failure',
					`## ❌ Review Container Error\n\n**Error:** \`${errMsg}\`\n\n` +
					`The container failed to execute. Retrying review...`
				);
			} catch {
				logger.error('Could not update Check Run with error status', undefined, {
					prNumber,
					checkRunId,
				});
			}
		}

		message.retry();
	}
}
