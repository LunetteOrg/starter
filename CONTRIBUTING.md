# Contributing to Starter

## Getting Started

```bash
pnpm setup          # first time — install + infra + migrate + seed
pnpm dev            # daily — infra up + all apps in watch mode
```

## Branch Naming

```
{type}/{issue-id}/{short-slug}
```

| Segment | Values | Example |
|---|---|---|
| `type` | `feat`, `fix`, `chore`, `refactor`, `docs` | `feat` |
| `issue-id` | Tracker issue number, or `no-issue` | `42` |
| `short-slug` | 2-4 word kebab-case description | `project-scaffolding` |

Examples:

- `feat/42/project-scaffolding`
- `fix/57/auth-token-refresh`
- `chore/no-issue/update-deps` (for work without an issue)

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

Violations are caught twice: **Biome `noRestrictedImports`** (pre-commit + CI) and per-app **architecture tests** (`app/arch.spec.ts`, built on `@starter/test-utils`). See [ADR-0004](./docs/adr/0004-import-boundaries-enforcement.md).

## Error Handling

- Use `errore` `createTaggedError` for domain errors
- Use `tryAsync()` at repository layer to wrap Drizzle calls
- Use `matchError()` in route actions for exhaustive handling
- Never `throw` below the use-case layer

## Testing

Strategy and tiers are defined in [ADR-0006](./docs/adr/0006-testing-strategy.md)
and [ADR-0020](./docs/adr/0020-testcontainer-reuse-and-db-isolation.md). The working rules:

- **Bug → red test first.** Before fixing a bug, write a test that fails *for the
  right reason* (reproduces the actual defect), then make it pass. The failing
  run is the proof the test bites.
- **Pick the tier by what you're proving**, not by habit:
  - `*.spec.ts` — **unit**: pure logic (domain, use-case wiring, helpers). No I/O.
  - `*.test.ts` — **integration**: real Postgres via `withTestDb` + transaction
    rollback. Repositories, migrations, anything that touches the DB.
  - **e2e** (Playwright) — full HTTP + DB path; add once there's a target app.
- **Smell test:** if a test would still pass with the database and collaborators
  fully mocked, it isn't proving the thing that breaks in production — push it
  down a tier or assert on real effects.
- **Never `vi.mock` the database.** Use `withTestDb` (ADR-0020). Mocking the DB
  hides schema/migration/query bugs, which is exactly what integration tests exist
  to catch.

## Merge Strategy

| Story Type | Merge | UAT |
|---|---|---|
| Tech Story | Merge freely to main — no user surface | None |
| User Story | Merge behind feature flag | Flag on staging → PO sign off → flag on prod |

Trunk-based development: all branches max **1-2 days**.

## Further Reading

Architectural decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/README.md). Significant architectural changes should land together with a new ADR.
