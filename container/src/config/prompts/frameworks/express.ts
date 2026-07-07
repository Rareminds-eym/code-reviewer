/**
 * EXPRESS/NODE.JS FRAMEWORK MODULE
 *
 * Express.js and general Node.js backend rules.
 * Activated when Express, Fastify, or Koa is detected.
 *
 * Token budget: ~250 tokens
 */

export const EXPRESS_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPRESS / NODE.JS BACKEND RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- ERROR MIDDLEWARE: Express apps MUST have a centralized error-handling middleware (\`(err, req, res, next)\`). Flag route handlers that catch errors but don't call \`next(err)\`.
- ASYNC HANDLERS: All async route handlers MUST have try/catch or use an async wrapper. Unhandled rejections will crash the process.
- INPUT VALIDATION: Never trust request input (\`req.body\`, \`req.params\`, \`req.query\`). Flag handlers that use input without validation/sanitization.
- SQL INJECTION: Flag string concatenation or template literals in SQL queries. Always use parameterized queries or an ORM.
- RESPONSE CODES: Flag handlers that always return 200. Use appropriate HTTP status codes (201 for create, 404 for not found, 422 for validation errors).
- RATE LIMITING: Public-facing endpoints should have rate limiting middleware. Flag open endpoints handling auth or file uploads without rate limits.
- SECRETS: Flag hardcoded database URLs, API keys, or JWT secrets. Use environment variables.
- HEADERS: Flag missing security headers (CORS, Content-Security-Policy, X-Content-Type-Options).
- FLAG synchronous file system operations (\`fs.readFileSync\`) in request handlers.
`.trim();
