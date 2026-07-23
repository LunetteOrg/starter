# CLAUDE.md — Starter Template

## Project Overview

TypeScript monorepo starter template. Architectural decisions live in `docs/adr/`: a thematic **seed** (numbered `000N-*`, one file per area) plus **dated** evolution files (`YYYY-MM-DD-*`, one decision each — new decisions are dated files, never appended into a seed file, so concurrent PRs never collide on an id). Recommended patterns for the app you build on the template, which it does not ship, live in `docs/guidances/`. Read the relevant ADR before changing anything it covers. See [ADR-0001](docs/adr/0001-recording-decisions.md).

The **`.lunette-template`** marker file at the repo root means you are working ON
the template (ADRs may be consolidated/renumbered). `create-lunette` deletes it on
scaffold, so in a derived project it is absent and ADRs are append-only.

**Record shared decisions in the repo.** Any team/project decision (config
choices, architectural trade-offs, conventions) must live in a shared, in-repo
form — an ADR under `docs/adr/` (or a `docs/guidances/` doc for app-level
recommendations) or a comment in the affected file — never only in a private or
agent-local note. If it matters to more than one person, it belongs where
everyone (and every machine) can see it.

## Conventions

Source of truth: `CONTRIBUTING.md`

### Branch Naming

```
{type}/{issue-id}/{short-slug}
```

Examples: `feat/42/otp-login`, `chore/no-issue/fix-typo`

### Commits

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`

No `Co-Authored-By:` trailers or "Generated with …" lines in commit messages —
keep them clean. The `commit-msg` hook strips them as a backstop (`lefthook.yml`).

### Workflow

- Trunk-based, one PR per story, branches max 1-2 days
- Tech stories merge freely; user stories merge behind feature flag (see the [feature-flags guidance](docs/guidances/app-infrastructure.md#feature-flags))

## Architecture Rules

- `process.env` banned outside `config/env.ts`
- `new Date()` banned — use `Temporal`
- `throw new Error()` banned — use `errore` typed errors (ADR-0002 — typed errors)
- Domain must not import framework (React Router) or `lib/`
- Routes consume `context.app` only — never import use-cases/domain/bootstrap directly
- Loaders/actions return an explicit, flat read-view/DTO literal — never a domain/db entity, never a nested entity, never `return { ...entity }` (RR7 serializes the return whole to the browser). Enforced by `assertNoEntitySpreadInReturn` + a per-route golden test (ADR-0002 — loader/action serialization boundary)
- Use-cases compose via injected deps in `bootstrap/` — never import each other (ADR-0002 — use-case composition)
- `tryAsync()` at repository boundary, `matchError()` at route layer
- `.spec.ts` = unit test, `.test.ts` = integration test, `*.stories.tsx` in `packages/ui` = component test (the story runs in a real browser; a11y violations fail the build — ADR-0004 — component tests)
- Never `vi.mock` the database — use `withTestDb` + transaction rollback
- Import boundaries are enforced twice: Biome overrides in `biome.json` + per-app `app/arch.spec.ts` (ADR-0002 — import boundaries). Keep both in sync when boundaries change.

## Reviews

Every code review and PR review MUST also run the `adr-check`, `story-check`,
`product-check` and `design-check` skills and fold their findings into the
review. All are report-only (they never edit files). Run them up front, before
the line-by-line pass:

- `adr-check` — code vs `docs/adr/` (and `docs/guidances/`): ADR violations + decisions that need a new/updated ADR.
- `story-check` — `packages/ui` components vs their Storybook stories/Foundations.
- `product-check` — `docs/product/` PDRs vs their Storybook `Product/` review pages: missing pages, broken `?raw` imports, stale `reference/` links.
- `design-check` — design/UX discipline: tokens vs raw values, light+dark theming, AA contrast, focus/keyboard, motion, tooltips (scope: `packages/ui` and `ui-tokens`).

To *record* a product/design decision (and its review page), use the
`product-decision` skill — it writes the PDR + the `Product/*.mdx` that renders it.
To *explore* 2–3 visual directions as Storybook prototypes before choosing, use
`design-explore`.

**Deliver feedback on the PR.** When the review targets a PR (it has a GitHub
PR), post findings as **inline PR comments** anchored to the relevant lines —
not only as a chat summary. Prefer `/code-review --comment`, and attach the
`adr-check`/`story-check` findings to the lines they reference. Reserve the chat
summary for an overview; the actionable items live as PR comments. When there is
no PR (local working diff), a chat report is fine.

## Key Paths

- ADRs: `docs/adr/` (index in `docs/adr/README.md`) · Guidances: `docs/guidances/` (app-level recommendations, not shipped)
- Product decisions: `docs/product/` (PDR log) · rendered for review in Storybook's `Product/` section · raw input in `reference/` (quarantined) — see ADR-0007
- Contributing: `CONTRIBUTING.md`
- Architecture test helpers: `packages/test-utils/src/arch.ts`
- Review skills: `.claude/skills/adr-check/`, `.claude/skills/story-check/`, `.claude/skills/product-check/`, `.claude/skills/design-check/` · Scaffolding skills: `.claude/skills/product-decision/`, `.claude/skills/design-explore/`
