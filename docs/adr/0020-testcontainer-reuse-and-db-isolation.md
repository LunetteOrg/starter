# ADR-0020: Postgres testcontainer reuse and per-instance DB isolation

- Status: accepted
- Date: 2026-06-30

## Context

Integration tests (`.test.ts`) run against a real Postgres via
`@testcontainers/postgresql` (ADR-0006, never mock the DB). `createTestDb` starts
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

## Decision

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

## Consequences

- \+ Fast local loop: Postgres starts once, reused across files/packages/runs.
- \+ No container accumulation when reuse is enabled; CI stays hygienic.
- \+ Migration-committing instances are isolated without stopping the shared
  container, so they can't leak into sibling suites.
- − Reuse is machine-local setup a new dev performs once; if skipped, tests still
  pass but containers accumulate (clean with
  `docker rm -f $(docker ps -aq --filter "label=org.testcontainers=true")`).
- − The shared container is long-lived: after a Postgres image/config bump,
  remove it manually so a fresh one is created.
