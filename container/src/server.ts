import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { runReviewPipeline } from './pipeline.js';
import type { ReviewRequest, ReviewResponse } from './types.js';

const app = new Hono();

let isShuttingDown = false;
let activeRequests = 0;

// Graceful shutdown tracking middleware
app.use('*', async (c, next) => {
	if (isShuttingDown) {
		c.header('Connection', 'close');
		return c.json({ error: 'Server is shutting down' }, 503);
	}
	activeRequests++;
	try {
		await next();
	} finally {
		activeRequests--;
	}
});

// Middleware for Hono logging
app.use('*', honoLogger());

// ── Health check (required by Cloudflare Container readiness detection) ──
app.get('/ping', (c) => c.text('pong'));
app.get('/health', (c) => c.json({ status: isShuttingDown ? 'shutting_down' : 'healthy' }));

// ── Main review endpoint ──
app.post('/review', async (c) => {
	const startTime = Date.now();
	let request: ReviewRequest;

	try {
		request = await c.req.json<ReviewRequest>();
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	// Validate required fields (Removed installationToken as container generates it)
	if (!request.repoFullName || !request.prNumber || !request.headSha || !request.title || !request.prAuthor) {
		return c.json({ error: 'Missing required fields: repoFullName, prNumber, headSha, title, prAuthor' }, 400);
	}

	const requestId = request.requestId || `container-${Date.now()}`;
	console.log(`[${requestId}] Starting review for ${request.repoFullName}#${request.prNumber}`);

	try {
		const response: ReviewResponse = await runReviewPipeline(request, requestId);

		console.log(`[${requestId}] Review completed in ${Date.now() - startTime}ms`, {
			staticFindings: response.staticFindings.length,
		});

		return c.json(response);
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		console.error(`[${requestId}] Pipeline failed:`, errMsg);

		return c.json({
			error: 'Review pipeline failed',
			message: errMsg,
			requestId,
		}, 500);
	}
});


// ── Start server ──
import { serve } from '@hono/node-server';

const port = parseInt(process.env.PORT || '3000', 10);

console.log(`[ReviewContainer] Starting Node.js HTTP server on port ${port}`);

const server = serve({
	fetch: app.fetch,
	port,
});

// SIGTERM Graceful Shutdown Handler (Gap 52 / Task 3b)
process.on('SIGTERM', () => {
	console.log('[ReviewContainer] SIGTERM received. Starting graceful shutdown...');
	isShuttingDown = true;
	
	// Close Hono server to stop accepting new connection sockets
	server.close();

	// Wait up to 14 minutes (840s) for active requests to finish (Cloudflare limit: 15 mins)
	const shutdownTimeout = setTimeout(() => {
		console.error('[ReviewContainer] Graceful shutdown timed out. Force exiting.');
		process.exit(1);
	}, 14 * 60 * 1000);

	const checkActive = () => {
		if (activeRequests === 0) {
			clearTimeout(shutdownTimeout);
			console.log('[ReviewContainer] All active requests completed. Exiting clean.');
			process.exit(0);
		}
		setTimeout(checkActive, 1000);
	};
	checkActive();
});
