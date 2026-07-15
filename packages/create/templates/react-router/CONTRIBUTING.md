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

Subjects must not contain an **em/en dash** (`—` `–`) — commitlint rejects them
(`subject-no-em-dash`); use a plain hyphen `-` or rephrase.

**`Retro:` trailer — track improvement signals.** When something was harder than it
should be, or you did by hand what a hook/skill/agent could automate, add a trailer to
that commit. It's the granular capture the PR Retrospective block absorbs (the
`retrospective` skill harvests it):

```
fix: work around missing db:seed script

Retro: no db:seed script — had to seed by hand; candidate for automation
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

Violations are caught twice: **Biome `noRestrictedImports`** (pre-commit + CI) and per-app **architecture tests** (`app/arch.spec.ts`, built on `@starter/test-utils`). See [ADR-0002 (import boundaries)](./docs/adr/0002-architecture-and-boundaries.md#import-boundaries).

## Error Handling

- Use `errore` `createTaggedError` for domain errors
- Use `tryAsync()` at repository layer to wrap Drizzle calls
- Use `matchError()` in route actions for exhaustive handling
- Never `throw` below the use-case layer

## Loader / action returns (no over-serialization)

React Router 7 serializes a loader/action return **whole** (turbo-stream) and
ships it to the browser — inline in the SSR HTML and in every `.data` request. A
returned field is on the wire even if no component reads it, so a leaked column
(`passwordHash`, tokens, internal flags, another user's data from a join) is
exposed regardless of client code. TypeScript does not strip excess keys at
runtime — only a runtime projection does.

- Return an **explicit, flat read-view/DTO object literal** — the exact fields the
  UI needs, spelled out.
- **Never** `return { ...entity }`, `return entity`, or a nested entity
  (`return { user }`). No spreads of domain/db values into the returned object.
- Never return a domain/db type directly; project it first (an explicit literal,
  or a `zod` read-view whose `.parse()` drops undeclared keys — see the templates
  in `packages/test-utils/templates/serialization/`).
- Actions serialize exactly like loaders — the same rule applies to their return.

Enforced twice, like import boundaries: an **arch test**
(`assertNoEntitySpreadInReturn`, in the per-app `arch.spec.ts`) fails on any
spread into a loader/action return, and a per-route **golden test** pins the
exact key set of the serialized payload. See [ADR-0002 (loader/action serialization boundary)](./docs/adr/0002-architecture-and-boundaries.md#loaderaction-serialization-boundary).

## Testing

Strategy and tiers are defined in [ADR-0004 (Testing)](./docs/adr/0004-testing.md)
([strategy](./docs/adr/0004-testing.md#testing-strategy) and
[test database isolation](./docs/adr/0004-testing.md#test-database-isolation)). The working rules:

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
- **Never `vi.mock` the database.** Use `withTestDb` ([ADR-0004 — test database isolation](./docs/adr/0004-testing.md#test-database-isolation)). Mocking the DB
  hides schema/migration/query bugs, which is exactly what integration tests exist
  to catch.

## Merge Strategy

| Story Type | Merge | UAT |
|---|---|---|
| Tech Story | Merge freely to main — no user surface | None |
| User Story | Merge behind feature flag | Flag on staging → PO sign off → flag on prod |

Trunk-based development: all branches max **1-2 days**.

## Planning & Self-Improvement

Planning and the issue board are driven by four Claude Code skills (in `.claude/skills/`):

- **`roadmap`** — decomposes a broad objective into Features (epics) and schedules them
  across iterations by measured velocity (the long horizon).
- **`plan-round`** — breaks the Features due now into a sub-issue tree for one iteration
  (explore → decide → triage backlog → materialize).
- **`github-board`** — owns the issues + Project (v2) mechanics; its
  [board reference](./.claude/skills/github-board/references/github-project.md) is the
  source of truth for the board structure and the `gh`/GraphQL recipes.
- **`retrospective`** — a continuous self-improvement loop: `Retro:` commit trailers →
  PR Retrospective block → periodic harvest that proposes concrete tooling (a skill, a
  Lefthook hook, a CI check, an ADR, a `CLAUDE.md` rule). See the PR template.

An agent opening a PR always fills the Retrospective block (from
`.github/pull_request_template.md`) — see `CLAUDE.md`.

## Further Reading

Architectural decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/README.md); recommended patterns for the app you build (not shipped by the template) live in [`docs/guidances/`](./docs/guidances/README.md). A significant architectural change should land with a new or updated ADR (see [ADR-0001](./docs/adr/0001-recording-decisions.md)).
