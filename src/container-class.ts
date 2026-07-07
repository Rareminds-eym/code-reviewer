import { Container, ContainerProxy } from '@cloudflare/containers';
import type { Env } from './types/env';

/**
 * Worker-side Container class definition.
 *
 * This does NOT run inside the Docker container. It runs inside the V8 Worker isolate
 * and tells Cloudflare how to manage the associated Docker container:
 * - Which port to proxy to
 * - When to sleep the container
 * - Whether to allow outbound internet
 *
 * The actual review logic lives in the `container/` directory as a separate Node.js app.
 */
export class ReviewContainer extends Container {
	/** The HTTP port the container's Hono server listens on. */
	defaultPort = 3000;

	/**
	 * Sleep the container after 5 minutes of inactivity.
	 * This saves cost while keeping the container warm for burst PR activity.
	 * On next request, the container wakes in ~1-3 seconds.
	 */
	sleepAfter = '5m';

	/**
	 * MUST be true. The container needs outbound internet for:
	 * 1. `git clone` from GitHub
	 * 2. Anthropic/Google LLM API calls
	 */
	enableInternet = true;

	/** Map secrets to container envVars in constructor */
	envVars: Record<string, string>;

	constructor(ctx: any, env: any) {
		super(ctx, env);
		this.envVars = {
			ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY || '',
			GEMINI_API_KEY: env.GEMINI_API_KEY || '',
			GITHUB_APP_ID: env.GITHUB_APP_ID || '',
			GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY || '',
			GITHUB_APP_INSTALLATION_ID: env.GITHUB_APP_INSTALLATION_ID || '',
			GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET || '',
			DASHBOARD_SESSION_SECRET: env.DASHBOARD_SESSION_SECRET || env.GITHUB_WEBHOOK_SECRET || '',
			AI_PROVIDER: env.AI_PROVIDER || 'claude',
			ALLOWED_TARGET_BRANCHES: env.ALLOWED_TARGET_BRANCHES || '',
			USAGE_API_KEY: env.USAGE_API_KEY || '',
			DASHBOARD_USERNAME: env.DASHBOARD_USERNAME || '',
			DASHBOARD_PASSWORD: env.DASHBOARD_PASSWORD || '',
			CLIQ_CLIENT_ID: env.CLIQ_CLIENT_ID || '',
			CLIQ_CLIENT_SECRET: env.CLIQ_CLIENT_SECRET || '',
			CLIQ_REFRESH_TOKEN: env.CLIQ_REFRESH_TOKEN || '',
			CLIQ_BOT_NAME: env.CLIQ_BOT_NAME || '',
			CLIQ_CHANNEL_ID: env.CLIQ_CHANNEL_ID || '',
			CLIQ_DB_NAME: env.CLIQ_DB_NAME || '',
			BUDGET_ALERT_WEBHOOK: env.BUDGET_ALERT_WEBHOOK || '',
			HONEYCOMB_API_KEY: env.HONEYCOMB_API_KEY || '',
			OTEL_EXPORTER_URL: env.OTEL_EXPORTER_URL || '',
			ENABLE_WEB_SEARCH: env.ENABLE_WEB_SEARCH || 'false',
		};
	}

	override onStart(): void {
		console.log('[ReviewContainer] Container instance started');
	}

	override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
		console.log('[ReviewContainer] Container instance stopped', { exitCode, reason });
	}

	override onError(error: unknown): void {
		console.error('[ReviewContainer] Container instance error', error);
		throw error; // Re-throw so the caller sees the failure
	}
}

// Static outbound handlers — intercept container's HTTP calls to virtual hostnames (Gap 1a)
ReviewContainer.outboundByHost = {
	'kv.internal': async (request: Request, env: any) => {
		const url = new URL(request.url);
		const pathnameParts = url.pathname.split('/');
		const namespace = pathnameParts[1];
		const action = pathnameParts[2];
		const key = url.searchParams.get('key') ?? '';

		const kvMap: Record<string, KVNamespace> = {
			USAGE_METRICS: env.USAGE_METRICS,
			AUTH_KV: env.AUTH_KV,
			CACHE_KV: env.CACHE_KV,
			DEDUP_KV: env.DEDUP_KV,
		};
		const kv = kvMap[namespace];
		if (!kv) return new Response('Unknown namespace', { status: 400 });

		if (action === 'get') {
			const val = await kv.get(key);
			return new Response(val ?? '', { status: val ? 200 : 404 });
		}
		if (action === 'put') {
			const body = await request.text();
			const ttl = parseInt(url.searchParams.get('ttl') ?? '0');
			await kv.put(key, body, ttl ? { expirationTtl: ttl } : undefined);
			return new Response('ok');
		}
		if (action === 'delete') {
			await kv.delete(key);
			return new Response('ok');
		}
		if (action === 'list') {
			const prefix = url.searchParams.get('prefix') ?? '';
			const keys = await kv.list({ prefix });
			return new Response(JSON.stringify(keys));
		}
		return new Response('Unknown action', { status: 400 });
	},
};

// Export ContainerProxy for outbound interception to work (Gap 1c)
export { ContainerProxy };
