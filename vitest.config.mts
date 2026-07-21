import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// Edge (Cloudflare Worker) tests only. Container tests live in
		// `container/test/` and run under the Node environment via
		// `npm test --prefix container` — they must not run in the Workers pool.
		include: ['test/**/*.spec.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'container/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Provide dummy secrets for tests — no real API calls are made in unit tests
					bindings: {
						ANTHROPIC_API_KEY: 'test-anthropic-key',
						GEMINI_API_KEY: 'test-gemini-key',
						GITHUB_APP_ID: 'test-app-id',
						GITHUB_APP_PRIVATE_KEY: 'test-private-key',
						GITHUB_APP_INSTALLATION_ID: 'test-installation-id',
						GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
						AI_PROVIDER: 'claude',
						ALLOWED_TARGET_BRANCHES: 'dev',
						DASHBOARD_USERNAME: 'test-admin',
						DASHBOARD_PASSWORD: 'test-password',
					},
				},
			},
		},
	},
});
