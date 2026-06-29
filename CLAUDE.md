# CLAUDE.md — Starter Template

## Project Overview

TypeScript monorepo starter template. Architectural decisions are recorded as ADRs in `docs/adr/` — read the relevant ADR before changing anything it covers.

**Record shared decisions in the repo.** Any team/project decision (config
choices, architectural trade-offs, conventions) must live in a shared, in-repo
form — an ADR under `docs/adr/` or a comment in the affected file — never only
in a private or agent-local note. If it matters to more than one person, it
belongs where everyone (and every machine) can see it.

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

## Reviews

Every code review and PR review MUST also run the `adr-check` and `story-check`
skills and fold their findings into the review. Both are report-only (they never
edit files). Run them up front, before the line-by-line pass:

- `adr-check` — code vs `docs/adr/`: ADR violations + decisions that need a new ADR.
- `story-check` — `packages/ui` components vs their Storybook stories/Foundations.

**Deliver feedback on the PR.** When the review targets a PR (it has a GitHub
PR), post findings as **inline PR comments** anchored to the relevant lines —
not only as a chat summary. Prefer `/code-review --comment`, and attach the
`adr-check`/`story-check` findings to the lines they reference. Reserve the chat
summary for an overview; the actionable items live as PR comments. When there is
no PR (local working diff), a chat report is fine.

## Key Paths

- ADRs: `docs/adr/` (index in `docs/adr/README.md`)
- Contributing: `CONTRIBUTING.md`
- Architecture test helpers: `packages/test-utils/src/arch.ts`
- Review skills: `.claude/skills/adr-check/`, `.claude/skills/story-check/`
