# Contributing to Starter

## Getting Started

```bash
pnpm setup          # first time — install + infra + migrate + seed
pnpm dev            # daily — infra up + all apps in watch mode
```

## Branch Naming

```
{type}/{story-id}/{short-slug}
```

| Segment | Values | Example |
|---|---|---|
| `type` | `feat`, `fix`, `chore`, `refactor`, `docs` | `feat` |
| `story-id` | Epic + story number from epics list | `E1-S01` |
| `short-slug` | 2-4 word kebab-case description | `project-scaffolding` |

Examples:

- `feat/E1-S01/project-scaffolding`
- `fix/E2-S03/auth-token-refresh`
- `chore/E1-S02/ci-pipeline-setup`
- `chore/no-story/update-deps` (for work without a story ID)

## Commits

Conventional commits enforced via **commitlint + Lefthook**. Keep commits small and descriptive.

```
feat: add OTP verification endpoint
fix: handle expired session gracefully
chore: bump drizzle-kit to 0.22
```

## File & Code Naming

| Context | Convention | Example |
|---|---|---|
| Files | `kebab-case` | `user-repository.ts` |
| React components | `PascalCase` | `UserCard.tsx` |
| Folders | `kebab-case` | `test-utils/` |
| Functions / variables | `camelCase` | `registerUser` |
| Types / interfaces | `PascalCase` | `UserRepository` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_OTP_ATTEMPTS` |
| DB tables | `snake_case` plural | `otp_codes` |
| DB columns | `snake_case` | `created_at` |

## Import Rules

- Never import `db` from frontend packages
- Never import `process.env` outside `config/env.ts`
- Never import framework (RR7) in domain packages
- Use `context.app` in routes — never import use cases directly

Violations are caught by **Biome `noRestrictedImports`** in CI.

## Error Handling

- Use `errore` `createTaggedError` for domain errors
- Use `tryAsync()` at repository layer to wrap Drizzle calls
- Use `matchError()` in route actions for exhaustive handling
- Never `throw` below the use-case layer

## Merge Strategy

| Story Type | Merge | UAT |
|---|---|---|
| Tech Story | Merge freely to main — no user surface | None |
| User Story | Merge behind feature flag | Flag on staging → PO sign off → flag on prod |

Trunk-based development: all branches max **1-2 days**.

## Further Reading

Full architecture decisions and patterns are documented in [`_bmad-output/planning-artifacts/architecture.md`](./_bmad-output/planning-artifacts/architecture.md).
