/**
 * GO LANGUAGE MODULE
 *
 * Go-specific review rules. Activated when .go files
 * are detected in the PR.
 *
 * Token budget: ~250 tokens
 */

export const GO_PROMPT = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GO CODE QUALITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- ERROR HANDLING: Every function that returns an error MUST have its error checked. Flag \`_ = someFunc()\` that discards errors. Flag missing error returns in functions that can fail.
- GOROUTINE LEAKS: Flag goroutines launched without a cancellation mechanism (context.Context or done channel). Flag goroutines that block on channels indefinitely without select/timeout.
- DEFER: Flag \`defer\` inside loops — the deferred function won't run until the enclosing function returns, not at loop iteration end.
- RACE CONDITIONS: Flag shared state accessed from multiple goroutines without sync.Mutex, sync.RWMutex, or channels.
- NIL CHECKS: Flag nil pointer dereferences — check for nil before accessing struct fields or calling methods on interfaces.
- NAMING: Go uses camelCase for private, PascalCase for exported. Flag naming violations. Acronyms should be all caps (e.g., \`HTTPClient\`, not \`HttpClient\`).
- INTERFACE: Flag interfaces with too many methods (> 3-4). Prefer small, focused interfaces. Accept interfaces, return structs.
- CONTEXT PROPAGATION: Flag functions that accept a context.Context but don't pass it to downstream calls. Context should be the first parameter.
- FLAG \`fmt.Println\` in production code — use structured logging.
`.trim();
