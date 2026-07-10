import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// ---------------------------------------------------------------------------
// Helper: create a signed webhook request
// ---------------------------------------------------------------------------

async function createSignedWebhookRequest(
	body: object,
	secret: string,
	event = 'pull_request'
): Promise<Request> {
	const rawBody = JSON.stringify(body);
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signatureBuffer = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(rawBody)
	);
	const hex = Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	return new IncomingRequest('http://localhost/', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-GitHub-Event': event,
			'X-Hub-Signature-256': `sha256=${hex}`,
		},
		body: rawBody,
	});
}

const mockPRPayload = {
	action: 'opened',
	number: 42,
	pull_request: {
		number: 42,
		title: 'feat: add user profile page',
		body: 'Adds a new user profile page.',
		html_url: 'https://github.com/org/repo/pull/42',
		diff_url: 'https://github.com/org/repo/pull/42.diff',
		patch_url: 'https://github.com/org/repo/pull/42.patch',
		commits: 1,
		additions: 50,
		deletions: 5,
		changed_files: 3,
		head: { ref: 'feat/user-profile', sha: 'abc123' },
		base: { ref: 'dev', sha: 'def456' },
		user: { login: 'dev', id: 1 },
	},
	repository: {
		id: 1,
		full_name: 'org/repo',
		html_url: 'https://github.com/org/repo',
		default_branch: 'main',
	},
	sender: { login: 'dev', id: 1 },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Code Reviewer Worker', () => {
	// — Health Check —
	it('GET / returns health status', async () => {
		const request = new IncomingRequest('http://localhost/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ status: string; service: string }>();
		expect(['ok', 'degraded']).toContain(body.status);
		expect(body.service).toBe('code-reviewer-agent');
	});

	// — Method Not Allowed —
	it('PUT / returns 405', async () => {
		const request = new IncomingRequest('http://localhost/', { method: 'PUT' });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(405);
	});

	// — Signature Rejection —
	it('POST / with missing signature returns 401', async () => {
		const request = new IncomingRequest('http://localhost/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'pull_request',
				// No X-Hub-Signature-256
			},
			body: JSON.stringify(mockPRPayload),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it('POST / with wrong signature returns 401', async () => {
		const request = new IncomingRequest('http://localhost/', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-GitHub-Event': 'pull_request',
				'X-Hub-Signature-256': 'sha256=deadbeefdeadbeef',
			},
			body: JSON.stringify(mockPRPayload),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	// — Non-PR Event Ignored —
	it('POST / with non-pull_request event returns 200 Ignored', async () => {
		const request = await createSignedWebhookRequest(
			{ action: 'created' },
			env.GITHUB_WEBHOOK_SECRET,
			'push' // push event, not pull_request
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const body = await response.json<{ message: string }>();
		expect(body.message).toContain('Ignored');
	});

	// — Irrelevant PR Action Ignored —
	it('POST / with PR action "closed" returns 200 Ignored', async () => {
		const closedPayload = { ...mockPRPayload, action: 'closed' };
		const request = await createSignedWebhookRequest(
			closedPayload,
			env.GITHUB_WEBHOOK_SECRET,
			'pull_request'
		);
		const response = await worker.fetch(request, env);

		expect(response.status).toBe(200);
		const body = await response.json<{ message: string }>();
		expect(body.message).toContain('closed');
	});

	// — Queue Handler Accessibility —
	it('exports a queue() handler', () => {
		expect(typeof worker.queue).toBe('function');
	});

	// — Idempotency / Duplicate Webhook check —
	it('POST / with PR already completed in DEDUP_KV returns 200 and skips', async () => {
		const prPayload = { ...mockPRPayload, action: 'opened' };
		const dedupKey = `review_completed:org/repo:42:abc123`;
		await env.DEDUP_KV.put(dedupKey, 'true');

		const request = await createSignedWebhookRequest(
			prPayload,
			env.GITHUB_WEBHOOK_SECRET,
			'pull_request'
		);
		const response = await worker.fetch(request, env);

		expect(response.status).toBe(200);
		const body = await response.json<{ message: string }>();
		expect(body.message).toContain('completed');

		// Cleanup
		await env.DEDUP_KV.delete(dedupKey);
	});
});
