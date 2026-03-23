# CLAUDE.md — Starter Template

## Project Overview

TypeScript monorepo starter template. See `_bmad-output/planning-artifacts/architecture.md` for full architectural decisions.

## Conventions

Source of truth: `CONTRIBUTING.md`

### Branch Naming

```
{type}/{story-id}/{short-slug}
```

Examples: `feat/E0-S02/biome-lefthook`, `chore/no-story/fix-typo`

### Commits

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

### Workflow

- Trunk-based, one PR per story, branches max 1-2 days
- Tech stories merge freely; user stories merge behind feature flag

## Architecture Rules

- `process.env` banned outside `config/env.ts`
- `new Date()` banned — use `Temporal`
- `throw new Error()` banned — use `errore` typed errors
- Domain must not import framework (React Router) or `lib/`
- Routes consume `context.app` only — never import use-cases/domain/bootstrap directly
- `tryAsync()` at repository boundary, `matchError()` at route layer
- `.spec.ts` = unit test, `.test.ts` = integration test
- Never `vi.mock` the database — use `withTestDb` + transaction rollback

## Key Paths

- Architecture: `_bmad-output/planning-artifacts/architecture.md`
- Epics & Stories: `_bmad-output/planning-artifacts/epics-and-stories.md`
- BMAD skills: `.claude/skills/`
- Contributing: `CONTRIBUTING.md`
