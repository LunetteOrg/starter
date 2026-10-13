---
status: accepted
date: 2026-07-02
tags: [testing, vitest, playwright, storybook, a11y]
---

# ADR-0004: Testing

How this template tests its code — the unit/integration/e2e strategy and the conventions that keep the suite fast and trustworthy — and how integration tests share a real Postgres testcontainer while staying isolated from one another.

## Testing strategy

### Context

Tests must be fast enough to run on every PR, trustworthy enough to gate deploys, and must not depend on mocking the database (mocks drift from real SQL behaviour).

### Decision

| Layer | Tool | Convention |
|---|---|---|
| Unit | Vitest | `.spec.ts`, co-located with the source — TDD red-green |
| Integration | Vitest + Testcontainers | `.test.ts`, co-located — real Postgres, transaction rollback |
| Component | Vitest browser mode + Storybook | `*.stories.tsx` in `packages/ui` — **the story is the test** |
| E2E | Playwright | `*.e2e.ts` — critical flows only: revenue, onboarding, data loss |

Rules:

- Never `vi.mock` the database or a repository in `.test.ts` — use `withTestDb` from `@starter/test-utils`: each test runs inside a transaction that is rolled back, so no state leaks between tests.
- External services get stub implementations in `@starter/test-utils` (e.g. stub `EmailService`, noop analytics) injected through the composition root — full flows are testable offline.
- `test` does not depend on `build` in the Turbo pipeline — Vitest runs on TypeScript sources (fast PR feedback). `test:e2e` depends on `build` and runs only on main push: Playwright gates the deploy, not the PR.
- A shared UI component is covered by its story, not by a separate spec file ([component tests](#component-tests)). Playwright is the browser *engine* there, never the runner: `@playwright/test` stays reserved for e2e.
- Playwright starts from clean cookie state (`storageState: { cookies: [], origins: [] }`); tests that need cookies set them explicitly.
- E2E hygiene is linted ([import boundaries](./0002-architecture-and-boundaries.md#import-boundaries)): no `waitForTimeout()`, no reaching into React internals.
- Every route that returns data ships a **golden serialization test** (`.test.ts`) pinning the exact key set of the loader/action payload, so a leaked field fails the build ([loader/action serialization boundary](./0002-architecture-and-boundaries.md#loaderaction-serialization-boundary)). Copy-paste template: `packages/test-utils/templates/serialization/`.

### Consequences

- \+ Integration tests exercise real SQL; schema/query bugs surface before deploy.
- \+ PR feedback stays fast; the expensive suite runs once, where it gates production.
- − Testcontainers requires a working Docker socket (Docker-in-Docker in devcontainers/Codespaces).
- − Critical-flow discipline for e2e requires judgement; the categories (revenue/onboarding/data loss) are the tie-breaker.

## Component tests

### Context

Shared components in `packages/ui` shipped with a Storybook story (showcase +
autodocs) and an a11y addon, but **nothing asserted anything**: the a11y check
was advisory (`test: 'todo'`) and no test rendered a component. The template
already declared the bar — "a component is not done without its story and an
a11y pass" — with no mechanism to hold anyone to it.

The gap sits between the existing layers. Unit specs run in Node and never touch
the DOM; e2e boots the whole app and is reserved for critical flows. Neither
answers "does this button expose the right role, fire its handler, and pass axe?".

### Decision

Run the **existing stories as browser tests** via `@storybook/addon-vitest`
(Vitest browser mode, Playwright as the engine), configured in
`apps/design-system/vitest.config.ts` as a Vitest project named `ui-components`.

- **The story is the test.** Rendering every story in a real browser plus the axe
  check comes for free; a `play` function adds interaction assertions when the
  component has behaviour worth pinning. No parallel `*.spec.tsx` file.
- **a11y is blocking**: `a11y.test: 'error'` ([Storybook showcase](./0006-design-system.md#storybook-showcase)) — an axe
  violation fails `pnpm test`.
- **Self-arming** ([self-arming enforcement](./0002-architecture-and-boundaries.md#self-arming-enforcement)): the template ships no live component, so
  the project collects zero stories and passes (`passWithNoTests`). It arms
  itself with the first real component.
- **Playwright is the engine, not the runner.** Only chromium is installed for
  this layer; cross-browser belongs to e2e.
- A dedicated `*.browser.spec.tsx` is justified **only** when an assertion would
  pollute the public documentation of the component (focus traps, error
  boundaries, controlled/uncontrolled state). Reach for it when a real case
  proves the story insufficient — not before.
- **Version lockstep, non-negotiable**: `@vitest/browser` and
  `@vitest/browser-playwright` declare an *exact* peer on `vitest` (e.g.
  `4.1.10`, not a range). Bump all three together, or the install breaks.

### Alternatives considered

- **Standalone Vitest browser specs** (`vitest-browser-react`, no Storybook):
  keeps the test layer independent of Storybook, but discards the stories we
  already write and leaves the a11y promise unenforced. Rejected: two artefacts
  for one job.
- **Both from day one**: the destination, not the starting point. Shipping two
  conventions in a template makes *every* derived project pay to learn both.
- **Leaving a11y advisory**: keeps a documented bar that nothing enforces —
  precisely the gap this decision closes.

### Consequences

- \+ Components get render, interaction and a11y coverage with no new file type.
- \+ The a11y bar is enforced instead of aspirational.
- \+ Storybook stops being a dev/docs-only dependency and starts paying for
  itself as test infrastructure, softening a negative accepted in [ADR-0006](./0006-design-system.md#storybook-showcase).
- − The gate checks **one render**: default state, light theme, no interaction.
  Dark theme, focus/hover styling and the keyboard path stay uncovered unless the
  project extends them — deliberately a [guidance](../guidances/component-a11y.md), not a decision, since a
  project that ships no dark mode should not pay for that coverage.
- − The component layer is coupled to Storybook: dropping Storybook drops it.
- − CI must install a Chromium binary (cached) for the PR path, which previously
  needed no browser.
- − `packages/ui` now carries `storybook` devDependencies, since live stories
  resolve `storybook/test`.
- − **Revisit when**: a11y violations are routinely silenced rather than fixed,
  or `play` functions grow so numerous that the stories stop reading as
  documentation — both signal the standalone-spec escape hatch should widen.

## Test database isolation

### Context

Integration tests (`.test.ts`) run against a real Postgres via
`@testcontainers/postgresql` ([testing strategy](#testing-strategy), never mock the DB). `createTestDb` starts
the container with `.withReuse()` so the **same** server is shared across test
files, parallel package suites, and consecutive `vitest run` invocations —
paying Postgres startup once.

Reuse is a deliberate testcontainers opt-in that lives in the machine's
`~/.testcontainers.properties` (or `TESTCONTAINERS_REUSE_ENABLE`), **not** in the
repo: without it `.withReuse()` is silently ignored and every run spins a fresh
container. Two failure modes shape the decision: (1) calling `container.stop()`
defeats reuse and races sibling packages re-attaching to the labeled container;
(2) two `createTestDb` instances sharing the reused container also share one
database and one `__drizzle_migrations` journal, so an instance that applies its
own migrations corrupts/leaks state for the others.

### Decision

1. **Reuse is a per-developer local opt-in, never committed, off in CI.** Each
   dev enables it once via `~/.testcontainers.properties`
   (`testcontainers.reuse.enable=true`). CI runs ephemerally; Ryuk reaps
   everything at session end.
2. **`stopTestDb` never calls `container.stop()`.** Teardown only clears
   in-process state. With reuse on, the shared container persists for the next
   run; with reuse off (CI), Ryuk culls it. No code path stops the container.
3. **Isolate via `databaseName`, not via a separate container.** An instance that
   commits state (real migrations) passes a dedicated `databaseName`;
   `createTestDb` creates that database once on the shared container (idempotent,
   advisory-locked) and repoints the URI at it.

### Consequences

- \+ Fast local loop: Postgres starts once, reused across files/packages/runs.
- \+ No container accumulation when reuse is enabled; CI stays hygienic.
- \+ Migration-committing instances are isolated without stopping the shared
  container, so they can't leak into sibling suites.
- − Reuse is machine-local setup a new dev performs once; if skipped, tests still
  pass but containers accumulate (clean with
  `docker rm -f $(docker ps -aq --filter "label=org.testcontainers=true")`).
- − The shared container is long-lived: after a Postgres image/config bump,
  remove it manually so a fresh one is created.
