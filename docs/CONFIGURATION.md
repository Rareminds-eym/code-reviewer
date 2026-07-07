# Repository Configuration Guide

The Code Reviewer Agent natively supports a deep, zero-LLM architecture detection model. However, you can forcibly override its heuristics, append custom prompt validations, or ignore useless file paths by committing a `.codereview.yml` root file directly inside your repository.

When present, the container-side pipeline reads this manifest at the start of the Map-Reduce sequence and dynamically adjusts the LLM parameters before expending execution tokens.

## Implementing `.codereview.yml`

Create a file perfectly named `.codereview.yml` at the exact root of your repository (`/`).

### 1. Hardcoding Tech-Stack Overrides

By default, the Agent crawls `.json` and `.toml` dependencies natively to guess the execution architecture. If it's guessing incorrectly or missing nuanced ecosystem tools, declare the `stack` property manually:

```yaml
stack:
  languages: [typescript, golang]
  frameworks: [nextjs, gin]
  ecosystem: [zustand, tailwind, cobra]
  architecture: [fsd]
```

*When any property inside `stack` is provided, the auto-detector completely yields to your explicit definitions, passing the relevant prompt guidelines securely to the Container.*

### 2. Custom Rule Heuristics (`rules`)

Inject custom prompt strings heavily guarded by your senior software architectures. Every string inside this matrix will be securely merged with the chunk contexts, forcefully teaching the LLM your custom organizational coding conventions.

```yaml
rules:
  - "Violent Architectural Rule: All API calls MUST be dispatched through the `apps/api/` boundary, NO DIRECT DATA HOOKS allowed in UI components."
  - "State Management: Always execute `useQuery` via TanStack for server state. Ban the use of localized `useEffect` fetching patterns."
  - "Feature-Sliced Design: Absolutely no feature slice importing from another feature slice."
```

*Note: The Verification LLM agent explicitly checks LLM critiques against these rules. If an LLM critique complains about something that contradicts your custom rule, the Verification Agent will assassinate the critique.*

### 3. Path Ignorance (`ignore`)

Reduce your Token Budgeting Burn Rates by filtering out non-business-logic files manually. 
The Worker supports glob-pattern matching against incoming GitHub API patch URLs.

```yaml
ignore:
  - "*.generated.ts"
  - "legacy/*"
  - "scripts/*"
  - "data/**/*"
```
