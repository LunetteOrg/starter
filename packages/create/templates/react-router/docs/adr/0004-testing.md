# ADR-0004: Testing

- Status: accepted
- Date: 2026-07-02

How this template tests its code — the unit/integration/e2e strategy and the conventions that keep the suite fast and trustworthy — and how integration tests share a real Postgres testcontainer while staying isolated from one another.

## Testing strategy

### Context

Tests must be fast enough to run on every PR, trustworthy enough to gate deploys, and must not depend on mocking the database (mocks drift from real SQL behaviour).

### Decision

| Layer | Tool | Convention |
|---|---|---|
| Unit | Vitest | `.spec.ts`, co-located with the source — TDD red-green |
| Integration | Vitest + Testcontainers | `.test.ts`, co-located — real Postgres, transaction rollback |
| E2E | Playwright | `*.e2e.ts` — critical flows only: revenue, onboarding, data loss |

Rules:

- Never `vi.mock` the database or a repository in `.test.ts` — use `withTestDb` from `@starter/test-utils`: each test runs inside a transaction that is rolled back, so no state leaks between tests.
- External services get stub implementations in `@starter/test-utils` (e.g. stub `EmailService`, noop analytics) injected through the composition root — full flows are testable offline.
- `test` does not depend on `build` in the Turbo pipeline — Vitest runs on TypeScript sources (fast PR feedback). `test:e2e` depends on `build` and runs only on main push: Playwright gates the deploy, not the PR.
- Playwright starts from clean cookie state (`storageState: { cookies: [], origins: [] }`); tests that need cookies set them explicitly.
- E2E hygiene is linted ([import boundaries](./0002-architecture-and-boundaries.md#import-boundaries)): no `waitForTimeout()`, no reaching into React internals.

### Consequences

- \+ Integration tests exercise real SQL; schema/query bugs surface before deploy.
- \+ PR feedback stays fast; the expensive suite runs once, where it gates production.
- − Testcontainers requires a working Docker socket (Docker-in-Docker in devcontainers/Codespaces).
- − Critical-flow discipline for e2e requires judgement; the categories (revenue/onboarding/data loss) are the tie-breaker.

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

This mirrors the decision already proven in the sibling repo (pelion ADR-0008).

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
