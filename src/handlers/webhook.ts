import type { Env, ReviewTrack } from '../types/env';
import type { PullRequestWebhookPayload } from '../types/github';
import { REVIEWABLE_ACTIONS, BUILD_CHECK_NAME } from '../config/constants';
import { triagePR, DEFAULT_TRIAGE_CONFIG } from '../lib/triage-rules';
import { verifyWebhookSignature } from '../lib/security';
import { getInstallationToken } from '../lib/github-auth';
import { createCheckRun, updateCheckRun, updateCheckRunProgress, getCommitCheckRuns } from '../lib/github';
import { checkPayloadSize } from '../lib/payload-limit';
import { isDuplicateWebhook } from '../lib/webhook-dedup';
import { createSecureJsonResponse } from '../lib/security-headers';
import { logger } from '../lib/logger';
import { getRequestId } from '../lib/request-context';

/**
 * Compute the provisional Triage_Gatekeeper fields to attach to a ReviewMessage (R1.4, R1.5, R1.8).
 *
 * Gated by the `ENABLE_TRIAGE` flag (R1.5, R11.1): when the flag is not exactly
 * `"true"`, this returns an empty object so NO `track` is attached and the
 * container defaults to `full` (preserving disabled-equivalence, R9.2).
 *
 * At webhook time the changed-file list is generally unavailable, so `files` is
 * omitted and `triagePR` yields a PROVISIONAL decision from labels/title/target
 * branch (R1.8). The container finalizes the track once files are known.
 */
function buildTriageFields(
    env: Env,
    input: { labels: string[]; title: string; targetBranch: string },
): { track?: ReviewTrack; skipAgents?: string[] } {
    if (env.ENABLE_TRIAGE !== 'true') {
        return {};
    }

    const decision = triagePR(
        {
            labels: input.labels,
            title: input.title,
            targetBranch: input.targetBranch,
        },
        DEFAULT_TRIAGE_CONFIG,
    );

    // R10.1: log the assigned track and reason.
    logger.info('Triage assigned provisional review track', {
        track: decision.track,
        reason: decision.reason,
        provisional: decision.provisional,
    });

    return {
        track: decision.track,
        ...(decision.skipAgents.length > 0 ? { skipAgents: decision.skipAgents } : {}),
    };
}

/**
 * Core webhook handler — called for every POST / request.
 *
 * Flow:
 * 1. Read body once (needed for both signature check and parsing)
 * 2. Verify HMAC-SHA256 signature
 * 3. Check X-GitHub-Event header and payload action
 * 4. Get a GitHub App installation token
 * 5. Create a Check Run (skipped for ignored branches, in_progress for allowed)
 * 6. Push to Cloudflare Queues for background LLM processing
 * 7. Return 202 immediately so GitHub doesn't time out
 */
export async function handlePRWebhook(
    request: Request,
    env: Env
): Promise<Response> {
    // — 0. Check payload size limit (before reading body) —
    const sizeCheck = checkPayloadSize(request, { maxBytes: 5 * 1024 * 1024 }); // 5MB
    if (sizeCheck) {
        logger.warn('Webhook rejected: payload too large', {
            size: request.headers.get('Content-Length'),
            path: new URL(request.url).pathname,
        });
        return sizeCheck;
    }

    // — Read body once (needed for signature verification) —
    const rawBody = await request.text();

    // 1. Verify webhook signature FIRST (security: prevent cache pollution)
    const isValid = await verifyWebhookSignature(request, rawBody, env.GITHUB_WEBHOOK_SECRET);
    if (!isValid) {
        logger.error('Invalid webhook signature — request rejected');
        return createSecureJsonResponse(
            { error: 'Invalid signature' },
            401
        );
    }

    // 2. Check for duplicate webhook delivery (after signature verification)
    const isDuplicate = await isDuplicateWebhook(request, env);
    if (isDuplicate) {
        logger.info('Duplicate webhook detected, returning 200 to acknowledge');
        return createSecureJsonResponse(
            { message: 'Duplicate delivery ID - already processed' },
            200
        );
    }

    // 3. Check this is a pull_request, check_run, or issue_comment event
    const githubEvent = request.headers.get('X-GitHub-Event');
    if (githubEvent !== 'pull_request' && githubEvent !== 'check_run' && githubEvent !== 'issue_comment') {
        return createSecureJsonResponse(
            { message: `Ignored event: ${githubEvent}` },
            200
        );
    }

    // 4. Parse payload
    let payload: any;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        logger.error('Failed to parse webhook JSON payload');
        return createSecureJsonResponse(
            { error: 'Invalid JSON payload' },
            400
        );
    }

    // 4a. Handle check_run events
    if (githubEvent === 'check_run') {
        const checkRun = payload.check_run;
        const repository = payload.repository;

		// ── check_run.completed — deferred review trigger ──
		if (payload.action === 'completed' && checkRun?.name === (env.BUILD_CHECK_NAME !== undefined ? env.BUILD_CHECK_NAME : BUILD_CHECK_NAME)) {
            logger.info(`Build check "${checkRun.name}" completed (${checkRun.conclusion}) — checking for deferred reviews`, {
                repo: repository.full_name,
                headSha: checkRun.head_sha,
            });

            // If build check didn't succeed, skip (KV entry remains, will expire via TTL)
            if (checkRun.conclusion !== 'success') {
                logger.info(`Build check failed (${checkRun.conclusion}) — skipping deferred review`, {
                    headSha: checkRun.head_sha,
                    conclusion: checkRun.conclusion,
                });

                // Cache build outcome in KV so reopened PRs can look it up (24h TTL)
                const buildKey = `build_outcome:${repository.full_name}:${checkRun.head_sha}`;
                await env.DEDUP_KV.put(buildKey, checkRun.conclusion, { expirationTtl: 86400 }).catch(() => {});

                return createSecureJsonResponse({ message: 'check_run.completed — build not successful, skipping' }, 200);
            }

            // Look for any deferred review for this headSha
            try {
                const token = await getInstallationToken(env);
                const headSha = checkRun.head_sha;

                async function dispatchDeferredReview(prNumber: number, deferred: any) {
                    logger.info('Found deferred review — starting review now', {
                        prNumber,
                        headSha,
                    });

                    const checkRunId = await createCheckRun(
                        repository.full_name,
                        headSha,
                        token,
                        { status: 'in_progress', summary: 'Spinning up Cloudflare Container sandbox...' }
                    );

                    await env.REVIEW_QUEUE.send({
                        prNumber,
                        title: deferred.title,
                        repoFullName: repository.full_name,
                        headSha,
                        checkRunId,
                        prAuthor: deferred.prAuthor,
                        requestId: getRequestId(),
                        prDescription: deferred.prDescription,
                        // Re-attach the provisional triage decision persisted at
                        // defer time (R1.4). Absent when triage was disabled.
                        ...(deferred.track ? { track: deferred.track } : {}),
                        ...(deferred.skipAgents ? { skipAgents: deferred.skipAgents } : {}),
                    });
                }

                const pr = checkRun.pull_requests?.[0];
                if (pr) {
                    // Direct lookup by PR number — fastest path
                    const pendingKey = `pending_review:${repository.full_name}:${pr.number}:${headSha}`;
                    const deferredRaw = await env.DEDUP_KV.get(pendingKey);
                    if (deferredRaw) {
                        const deferred = JSON.parse(deferredRaw);
                        await env.DEDUP_KV.delete(pendingKey);
                        await dispatchDeferredReview(pr.number, deferred);
                    } else {
                        logger.info('check_run.completed — no deferred review found for PR', {
                            prNumber: pr.number,
                            headSha,
                        });
                    }
                } else {
                    // Forked PR / direct push: pull_requests is empty — scan KV for matching headSha
                    logger.info('check_run.completed has no PR — scanning KV for deferred reviews by headSha', {
                        headSha,
                        repo: repository.full_name,
                    });
                    let cursor: string | undefined;
                    let found = false;
                    while (!found) {
                        const kvList = await env.DEDUP_KV.list({ prefix: `pending_review:${repository.full_name}:`, cursor });
                        for (const key of kvList.keys) {
                            const raw = await env.DEDUP_KV.get(key.name);
                            if (raw) {
                                const pending = JSON.parse(raw);
                                if (pending.headSha === headSha) {
                                    await env.DEDUP_KV.delete(key.name);
                                    await dispatchDeferredReview(pending.prNumber, pending);
                                    found = true;
                                    break;
                                }
                            }
                        }
                        if (found) break;
                        if (kvList.list_complete) break;
                        cursor = kvList.cursor;
                    }
                }
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error('Failed to process deferred review on check_run.completed', error instanceof Error ? error : undefined, {
                    checkRunName: checkRun.name,
                    headSha: checkRun.head_sha,
                });
            }

            return createSecureJsonResponse({ message: 'check_run.completed processed' }, 200);
        }

        // ── check_run.rerequested — manual re-run of AI Code Reviewer ──
	if (payload.action !== 'rerequested') {
            return createSecureJsonResponse(
                { message: `Ignored check_run action: ${payload.action}` },
                200
            );
        }

        if (checkRun?.name !== 'AI Code Reviewer') {
            return createSecureJsonResponse(
                { message: `Ignored check_run name: ${checkRun.name}` },
                200
            );
        }

        const pr = checkRun.pull_requests?.[0];
        if (!pr) {
            return createSecureJsonResponse(
                { message: 'Ignored check_run: no pull request associated' },
                200
            );
        }

        const headSha = checkRun.head_sha;
        const prNumber = pr.number;

        logger.info('Check run re-run requested — clearing dedup and starting re-review', {
            prNumber,
            headSha,
            checkRunId: checkRun.id,
        });

        // 1. Clear dedup key to allow re-review
        const dedupKey = `review_completed:${repository.full_name}:${prNumber}:${headSha}`;
        await env.DEDUP_KV.delete(dedupKey).catch(() => {});

        // 2. Obtain token
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('GitHub App auth failed during re-review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'GitHub App authentication failed', detail: errMsg },
                500
            );
        }

        // 3. Fetch PR details to get latest title, author, description
        let prDetails: any;
        try {
            const prRes = await fetch(`https://api.github.com/repos/${repository.full_name}/pulls/${prNumber}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'code-reviewer-agent/1.0',
                }
            });
            if (!prRes.ok) {
                throw new Error(`GitHub API returned ${prRes.status}: ${await prRes.text()}`);
            }
            prDetails = await prRes.json();
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to fetch PR details for re-review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'Failed to fetch PR details', detail: errMsg },
                500
            );
        }

        // 4. Update the existing check run status to "in_progress"
        try {
            await updateCheckRunProgress(repository.full_name, checkRun.id, token, 'Spinning up Cloudflare Container sandbox for re-review...');
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn('Failed to update check run status', { error: errMsg });
        }

        // 5. Send ReviewMessage to the Queue
        try {
            await env.REVIEW_QUEUE.send({
                prNumber,
                title: prDetails.title || `PR #${prNumber}`,
                repoFullName: repository.full_name,
                headSha,
                checkRunId: checkRun.id,
                prAuthor: prDetails.user?.login || 'unknown',
                requestId: getRequestId(),
                prDescription: prDetails.body ? prDetails.body.slice(0, 2000) : undefined,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to enqueue re-review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'Failed to enqueue re-review job', detail: errMsg },
                500
            );
        }

        return createSecureJsonResponse(
            {
                message: 'Re-review queued in the background worker',
                pr: prNumber,
                repo: repository.full_name,
                sha: headSha,
                checkRunId: checkRun.id,
            },
            202
        );
    }

    // 4c. Handle issue_comment.created — /deep-review command trigger
    if (githubEvent === 'issue_comment') {
        if (payload.action !== 'created') {
            return createSecureJsonResponse(
                { message: `Ignored issue_comment action: ${payload.action}` },
                200
            );
        }

        const commentBody = payload.comment?.body || '';
        if (!commentBody.trim().toLowerCase().startsWith('/deep-review')) {
            return createSecureJsonResponse(
                { message: 'Ignored: not a /deep-review command' },
                200
            );
        }

        const issue = payload.issue;
        if (!issue?.pull_request) {
            return createSecureJsonResponse(
                { message: 'Ignored: comment is not on a pull request' },
                200
            );
        }

        const repository = payload.repository;
        const prNumber = issue.number;

        logger.info('Deep review requested via /deep-review comment', {
            prNumber,
            repo: repository.full_name,
            user: payload.comment?.user?.login,
        });

        // 1. Obtain token
        let token: string;
        try {
            token = await getInstallationToken(env);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('GitHub App auth failed during deep review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'GitHub App authentication failed', detail: errMsg },
                500
            );
        }

        // 2. Fetch PR details to get headSha, title, author
        let prDetails: any;
        try {
            const prRes = await fetch(`https://api.github.com/repos/${repository.full_name}/pulls/${prNumber}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': 'code-reviewer-agent/1.0',
                }
            });
            if (!prRes.ok) {
                throw new Error(`GitHub API returned ${prRes.status}: ${await prRes.text()}`);
            }
            prDetails = await prRes.json();
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to fetch PR details for deep review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'Failed to fetch PR details', detail: errMsg },
                500
            );
        }

        const headSha = prDetails.head.sha;

        // 3. Clear dedup key so the container processes it fresh
        const dedupKey = `review_completed:${repository.full_name}:${prNumber}:${headSha}`;
        await env.DEDUP_KV.delete(dedupKey).catch(() => {});

        // 4. Create a check run
        let checkRunId: number | null = null;
        try {
            checkRunId = await createCheckRun(repository.full_name, headSha, token, {
                status: 'in_progress',
                summary: '🔍 Deep review triggered by /deep-review command...',
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.warn('Failed to create in_progress Check Run for deep review', { error: errMsg });
        }

        // 5. Send ReviewMessage with deepReview: true
        try {
            await env.REVIEW_QUEUE.send({
                prNumber,
                title: prDetails.title || `PR #${prNumber}`,
                repoFullName: repository.full_name,
                headSha,
                ...(checkRunId ? { checkRunId } : {}),
                prAuthor: prDetails.user?.login || 'unknown',
                requestId: getRequestId(),
                prDescription: prDetails.body ? prDetails.body.slice(0, 2000) : undefined,
                deepReview: true,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error('Failed to enqueue deep review', error instanceof Error ? error : undefined);
            return createSecureJsonResponse(
                { error: 'Failed to enqueue deep review', detail: errMsg },
                500
            );
        }

        return createSecureJsonResponse(
            {
                message: 'Deep review queued in the background worker',
                pr: prNumber,
                repo: repository.full_name,
                sha: headSha,
                checkRunId,
            },
            202
        );
    }

    // 4d. Handle pull_request event logic
    const prPayload = payload as PullRequestWebhookPayload;

    // Skip draft PRs — they aren't ready for review
    if (prPayload.pull_request?.draft === true) {
        logger.info('Skipping draft PR', {
            prNumber: prPayload.pull_request.number,
            action: prPayload.action,
        });
        return createSecureJsonResponse(
            { message: `Ignored: PR #${prPayload.pull_request.number} is a draft` },
            200
        );
    }

    // Only process reviewable actions
    if (!REVIEWABLE_ACTIONS.has(prPayload.action)) {
        return createSecureJsonResponse(
            { message: `Ignored PR action: ${prPayload.action}` },
            200
        );
    }

    const pr = prPayload.pull_request;
    const repository = prPayload.repository;
    const headSha = pr.head.sha;

    // Idempotency/Dedup Guard: Check DEDUP_KV before token or check run setup
    const dedupKey = `review_completed:${repository.full_name}:${pr.number}:${headSha}`;
    let alreadyCompleted = false;
    let existingConclusion = 'success';
    try {
        const cached = await env.DEDUP_KV.get(dedupKey).catch(() => null);
        if (cached) {
            if (cached === 'true') {
                alreadyCompleted = true;
            } else {
                const parsed = JSON.parse(cached);
                if (parsed !== null && typeof parsed === 'object' && parsed.completed) {
                    alreadyCompleted = true;
                    existingConclusion = parsed.conclusion || 'success';
                }
            }
        }
    } catch {
        // Safe fallback: allow processing if JSON parsing fails
    }

    if (alreadyCompleted) {
        logger.info('Dedup hit in webhook — review already completed for this headSha, auto-resolving any stuck check runs', {
            prNumber: pr.number,
            headSha,
        });

        // Auto-resolve any dangling in_progress check runs for this headSha
        try {
            const token = await getInstallationToken(env);
            const crRes = await fetch(
                `https://api.github.com/repos/${repository.full_name}/commits/${headSha}/check-runs`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                        'User-Agent': 'code-reviewer-agent/1.0',
                    },
                }
            );
            if (crRes.ok) {
                const crData = await crRes.json() as { check_runs: Array<{ id: number; name: string; status: string }> };
                for (const run of crData.check_runs || []) {
                    if (run.name === 'AI Code Reviewer' && run.status === 'in_progress') {
                        await fetch(
                            `https://api.github.com/repos/${repository.full_name}/check-runs/${run.id}`,
                            {
                                method: 'PATCH',
                                headers: {
                                    Authorization: `Bearer ${token}`,
                                    Accept: 'application/vnd.github+json',
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'code-reviewer-agent/1.0',
                                },
                                body: JSON.stringify({
                                    name: 'AI Code Reviewer',
                                    status: 'completed',
                                    conclusion: existingConclusion,
                                    completed_at: new Date().toISOString(),
                                    output: {
                                        title: 'AI Code Review',
                                        summary: `✅ Review already completed for this commit (conclusion: ${existingConclusion}). Orphan check run resolved.`,
                                    },
                                }),
                            }
                        );
                        logger.info('Auto-resolved stuck check run', { checkRunId: run.id, conclusion: existingConclusion });
                    }
                }
            }
        } catch (resolveError) {
            logger.warn('Failed to auto-resolve stuck check runs (best-effort)', { error: String(resolveError) });
        }

        return createSecureJsonResponse(
            { message: 'Review already completed for this commit' },
            200
        );
    }

    // 5. Get GitHub App installation token
    let token: string;
    try {
        token = await getInstallationToken(env);
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('GitHub App auth failed', error instanceof Error ? error : undefined);
        return createSecureJsonResponse(
            { error: 'GitHub App authentication failed', detail: errMsg },
            500
        );
    }

    // 6. Filter by allowed target branches (if configured)
    if (env.ALLOWED_TARGET_BRANCHES) {
        const allowedBranches = env.ALLOWED_TARGET_BRANCHES.split(',').map(b => b.trim());
        if (!allowedBranches.includes(pr.base.ref)) {
            logger.info(`Ignored PR #${pr.number} — target branch not in ALLOWED_TARGET_BRANCHES`, {
                prNumber: pr.number,
                targetBranch: pr.base.ref,
            });

            // Create a completed Check Run with "skipped" conclusion (grey badge!)
            try {
                await createCheckRun(repository.full_name, headSha, token, {
                    status: 'completed',
                    conclusion: 'skipped',
                    summary: `Review skipped — target branch \`${pr.base.ref}\` is not in the allowed list (\`${env.ALLOWED_TARGET_BRANCHES}\`).`,
                });
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.warn('Failed to create skipped Check Run', { error: errMsg });
                // Non-fatal: we still return the ignore response
            }

            return createSecureJsonResponse(
                { message: `Ignored: PR target branch "${pr.base.ref}" not allowed` },
                200
            );
        }
    }

    logger.info('Webhook received for PR — sending to queue', {
        prNumber: pr.number,
        title: pr.title,
        repo: repository.full_name,
    });

    // ── Triage (R1): assign a provisional Review_Track before enqueueing. ──
    // Gated by ENABLE_TRIAGE; when off, no track is attached (container → full).
    // File list is unavailable at webhook time, so the decision is provisional
    // from labels/title/target branch (R1.8); the container finalizes it.
    const triageFields = buildTriageFields(env, {
        labels: (pr.labels ?? []).map(l => l.name),
        title: pr.title,
        targetBranch: pr.base.ref,
    });

	// ── Deferral check: wait for another CI check to complete first ──
	const buildCheckName = env.BUILD_CHECK_NAME !== undefined ? env.BUILD_CHECK_NAME : BUILD_CHECK_NAME;
	if (buildCheckName) {
		try {
			const checkRuns = await getCommitCheckRuns(repository.full_name, headSha, token);
			const buildCheck = checkRuns.find(cr => cr.name === buildCheckName);

			if (buildCheck) {
				if (buildCheck.status !== 'completed') {
					const status = buildCheck.status || 'not_found';
					logger.info(`Deferring review — waiting for "${buildCheckName}" (status: ${status})`, {
						prNumber: pr.number,
						headSha,
					});

					// Store deferred review in KV (30 min TTL)
					const pendingKey = `pending_review:${repository.full_name}:${pr.number}:${headSha}`;
					try {
						await env.DEDUP_KV.put(pendingKey, JSON.stringify({
							prNumber: pr.number,
							title: pr.title,
							repoFullName: repository.full_name,
							headSha,
							prAuthor: pr.user.login,
							prDescription: pr.body ? pr.body.slice(0, 2000) : undefined,
							timestamp: Date.now(),
							// Persist the provisional triage decision so the deferred
							// dispatch (after the build gate) can re-attach it (R1.4).
							...triageFields,
						}), { expirationTtl: 1800 });
					} catch (kvErr) {
						logger.warn('Failed to store deferred review in KV', { error: String(kvErr) });
					}

					return createSecureJsonResponse(
						{ message: `Review deferred — waiting for "${buildCheckName}"` },
						202
					);
				}

				if (buildCheck.conclusion !== 'success') {
					logger.info(`Build check "${buildCheckName}" ${buildCheck.conclusion} — skipping review`, {
						prNumber: pr.number,
						headSha,
						conclusion: buildCheck.conclusion,
					});
					try {
						await createCheckRun(repository.full_name, headSha, token, {
							status: 'completed',
							conclusion: 'skipped',
							summary: `Build "${buildCheckName}" ${buildCheck.conclusion} — review skipped`,
						});
					} catch (crErr) {
						const crMsg = crErr instanceof Error ? crErr.message : String(crErr);
						logger.warn('Failed to create skipped Check Run', { error: crMsg });
					}
					return createSecureJsonResponse(
						{ message: `Review skipped — "${buildCheckName}" ${buildCheck.conclusion}` },
						200
					);
				}

				logger.info(`Build check "${buildCheckName}" passed — proceeding with review`, {
					prNumber: pr.number,
					headSha,
				});
			} else {
				// Check cached build outcome (survives PR close/reopen cycles)
				const buildKey = `build_outcome:${repository.full_name}:${headSha}`;
				const cachedOutcome = await env.DEDUP_KV.get(buildKey);
				if (cachedOutcome && cachedOutcome !== 'success') {
					logger.info(`Cached build "${buildCheckName}" ${cachedOutcome} — skipping review`, {
						prNumber: pr.number,
						headSha,
						conclusion: cachedOutcome,
					});
					try {
						await createCheckRun(repository.full_name, headSha, token, {
							status: 'completed',
							conclusion: 'skipped',
							summary: `Build "${buildCheckName}" previously ${cachedOutcome} — review skipped`,
						});
					} catch (crErr) {
						const crMsg = crErr instanceof Error ? crErr.message : String(crErr);
						logger.warn('Failed to create skipped Check Run', { error: crMsg });
					}
					return createSecureJsonResponse(
						{ message: `Review skipped — "${buildCheckName}" previously ${cachedOutcome}` },
						200
					);
				}

				logger.info(`No "${buildCheckName}" check run or cached outcome for commit ${headSha} — proceeding with review immediately`, {
					prNumber: pr.number,
					headSha,
				});
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.warn('Failed to check build status — proceeding with review anyway', { error: errMsg });
			// Non-fatal: proceed with review if check fails
		}
	}

    // 7. Create a Check Run with status "in_progress" (blocks merge)
    let checkRunId: number | null = null;
    try {
        checkRunId = await createCheckRun(repository.full_name, headSha, token, {
            status: 'in_progress',
            summary: 'Spinning up Cloudflare Container sandbox...',
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to create in_progress Check Run', { error: errMsg });
        // Non-fatal: the queue consumer will still process the review
    }

    // 8. Send ReviewMessage to the Queue (include checkRunId for the consumer to update)
    // Pass the requestId for distributed tracing
    try {
        await env.REVIEW_QUEUE.send({
            prNumber: pr.number,
            title: pr.title,
            repoFullName: repository.full_name,
            headSha,
            ...(checkRunId ? { checkRunId } : {}),
            prAuthor: pr.user.login,
            requestId: getRequestId(),
            prDescription: pr.body ? pr.body.slice(0, 2000) : undefined,
            // Provisional Review_Track from triage (R1.4); absent when disabled.
            ...triageFields,
        });
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error('Failed to enqueue review', error instanceof Error ? error : undefined);
        return createSecureJsonResponse(
            { error: 'Failed to enqueue review job', detail: errMsg },
            500
        );
    }

    // 9. Respond immediately with 202 Accepted
    return createSecureJsonResponse(
        {
            message: 'Review queued in the background worker',
            pr: pr.number,
            repo: repository.full_name,
            sha: headSha,
            checkRunId,
        },
        202
    );
}
