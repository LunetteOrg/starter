# CLAUDE.md — Starter Template

## Project Overview

TypeScript monorepo starter template. Architectural decisions are recorded as ADRs in `docs/adr/` — read the relevant ADR before changing anything it covers.

## Conventions

Source of truth: `CONTRIBUTING.md`

### Branch Naming

```
{type}/{issue-id}/{short-slug}
```

Examples: `feat/42/otp-login`, `chore/no-issue/fix-typo`

### Commits

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

### Workflow

- Trunk-based, one PR per story, branches max 1-2 days
- Tech stories merge freely; user stories merge behind feature flag (ADR-0008)

## Architecture Rules

- `process.env` banned outside `config/env.ts`
- `new Date()` banned — use `Temporal`
- `throw new Error()` banned — use `errore` typed errors (ADR-0005)
- Domain must not import framework (React Router) or `lib/`
- Routes consume `context.app` only — never import use-cases/domain/bootstrap directly
- Use-cases compose via injected deps in `bootstrap/` — never import each other (ADR-0013)
- `tryAsync()` at repository boundary, `matchError()` at route layer
- `.spec.ts` = unit test, `.test.ts` = integration test
- Never `vi.mock` the database — use `withTestDb` + transaction rollback
- Import boundaries are enforced twice: Biome overrides in `biome.json` + per-app `app/arch.spec.ts` (ADR-0004). Keep both in sync when boundaries change.

## Key Paths

- ADRs: `docs/adr/` (index in `docs/adr/README.md`)
- Contributing: `CONTRIBUTING.md`
- Architecture test helpers: `packages/test-utils/src/arch.ts`
