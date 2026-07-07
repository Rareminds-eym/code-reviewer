/**
 * PYTHON LANGUAGE MODULE
 *
 * Python-specific review rules. Activated when .py files
 * are detected in the PR.
 *
 * Token budget: ~250 tokens
 */

export const PYTHON_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PYTHON CODE QUALITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- TYPE HINTS: All function signatures should have type annotations for parameters and return types. Flag missing type hints on public functions.
- EXCEPTION HANDLING: Never use bare \`except:\` — always catch specific exception types. Flag \`except Exception\` when a more specific type is appropriate.
- MUTABLE DEFAULTS: Flag mutable default arguments (lists, dicts) in function signatures — use \`None\` with a factory pattern instead.
- F-STRINGS: Prefer f-strings over \`.format()\` or \`%\` formatting for readability.
- CONTEXT MANAGERS: File handles, database connections, and locks must use \`with\` statements. Flag manual \`open()\` without context managers.
- ASYNC PATTERNS: Flag blocking I/O calls (\`requests.get\`, \`time.sleep\`) inside async functions — use \`aiohttp\`, \`asyncio.sleep\` instead.
- IMPORTS: Flag wildcard imports (\`from module import *\`). Flag circular imports.
- SECURITY: Flag \`eval()\`, \`exec()\`, \`pickle.loads()\` on untrusted input. Flag SQL string concatenation — use parameterized queries.
- Flag \`print()\` statements in production code — use the \`logging\` module.
`.trim();
