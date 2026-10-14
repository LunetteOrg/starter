---
status: accepted
date: 2026-10-14
tags: [testing, postgres, testcontainers, docker, packages, test-utils]
---

# The test database of `@lntt/test-utils`

## Context

Every Lunette project runs its integration tests on a real Postgres started by
testcontainers, and gets the helpers from `@lntt/test-utils`. The react-router
template's first version started that Postgres from `createTestDb` with
`.withReuse()`. The two projects scaffolded from it (pelion, wai) met the same
failures and converged on the same fix; this package carries it.

- **Reuse never reuses within a run.** It is a lookup at `start()`; vitest's workers
  start together, so none finds a container the others have not created yet. One
  pelion suite created 14 containers on 15 CPUs.
- **Nothing stops the containers.** `.withReuse()` excludes them from the reaper, and
  `stopTestDb()` did not stop them: 24 alive in pelion, the oldest 45 hours; one in
  wai up two days with nine databases.
- **A stale server makes a suite lie.** The reuse hash comes from the container
  configuration, not the checkout, so every clone and worktree on a machine attached
  to the same server and the same `__drizzle_migrations` journal. A missing
  `migrationsFolder` was skipped silently and passed green on a schema an earlier run
  left.
- **Dropping reuse and nothing else is worse.** Each worker then starts a Postgres of
  its own, owned by a process that exits first; with the reaper on, it kills the
  server between two test files (120 failing tests, exit 137).

## Decision

**One Postgres per vitest process, owned by a globalSetup in the main process and
handed to the workers as `TEST_DATABASE_URL`.**

```
vitest main process
  testDbPlugin().config()  -> TESTCONTAINERS_RYUK_DISABLED=true (main) + test.env (workers)
  globalSetup.setup()      -> TEST_DATABASE_URL set: use it, start nothing
                           -> Docker: postgresContainer().start(), publish TEST_DATABASE_URL
                           -> no Docker: CI fails the run; locally publish nothing
    worker 1..N            -> createTestDb reads TEST_DATABASE_URL; one database per databaseName
  globalSetup.teardown()   -> stop the container
  exit / SIGTERM / SIGHUP  -> docker rm --force, synchronously
```

1. **The globalSetup owns the container**: it starts it and removes it, in the only
   process that outlives every worker. `createTestDb` starts a container only when
   used without the plugin and without a server. Nothing is reused across runs.
2. **`postgresContainer()`** is the one factory: `postgres:17` (the template's major),
   data on tmpfs at the image's declared volume, labelled
   `com.lntt.workspace=<workspace root>`. The workspace root is the nearest directory
   holding `pnpm-workspace.yaml`, so each worktree is a workspace of its own.
3. **Ryuk is off** in the main process (`config()`) and in the workers (`test.env`).
   `ryukDisabledPlugin()` is that half alone, for packages that start other
   containers.
4. **The label serves cleanup only.** `lntt-clean-test` removes this workspace's
   containers by label, `--all` every workspace's, `--dry-run` lists them; it fails
   when `docker info` does not answer.
5. **The rule arms itself.** `assertContainerUsersMountAPlugin(root)` fails a
   workspace whose sources start containers (comments and strings blanked) without a
   vitest config that calls one of the plugins.
6. **`databaseName` is required**, a lower-case identifier checked at construction.
   Each instance owns one database, created under an advisory lock. Whether a
   project uses one per app or one per test file is its own choice.
7. **Migrations** run once per database under an advisory lock, on a `max: 1` client
   (the lock is session-scoped). A missing `migrationsFolder` throws at construction,
   naming the resolved path and the cwd. A failing unlock never replaces the error
   that explains the failure.
8. **No Docker**: unit tests run and database suites skip on `hasTestDatabase()`
   locally; with `CI` set it is a hard error.
9. **Killed runs** remove their container with a synchronous `docker rm --force` on
   `exit`, `SIGTERM` and `SIGHUP`, registered only by the process that started it.
10. **`withTestDb`** rolls each test back. **`connectionString()`** gives the migrated
    database to a test that must commit; that test removes what it committed.
11. **`TEST_DATABASE_URL` set from outside** is used as is, and the globalSetup neither
    starts nor stops anything. When that is right and when it brings the stale-schema
    false green back is in the package README (§ `TEST_DATABASE_URL` set by you).
12. **Watch mode** runs setup and teardown again in one process: teardown takes back
    the `TEST_DATABASE_URL` it published, and the kill handlers are registered once.

The package also carries the template's guards (architecture boundaries,
serialization, source patterns, migration safety) unchanged; their messages cite the
template's ADR files, which every project scaffolded from it has.

Tests in `packages/test-utils` cover each point; `workspaces.test.ts` runs two
checkouts' suites at once with the same `databaseName` and migration name and
asserts two servers and no leftover container. The scaffold smoke runs a database
test in a generated project on the packed package.

## Consequences

### Positive

- What a run starts, the same run removes, however it ends short of `SIGKILL`.
- Every run builds its schema from its own migrations; a wrong migrations path fails
  at once.
- Two worktrees, or two packages of one, never share a server.
- Local and CI take the same path; `TEST_DATABASE_URL` is the only difference.

### Negative / accepted risks

- **Every run pays for starting a Postgres container**, unit-only runs of a package
  with the plugin included.
- **Ryuk is off**: a `SIGKILL`, or a signal during `start()` (the container exists, the
  handler does not know it yet), leaves a container. `lntt-clean-test` is the remedy.
  Removing by label on exit would close the window, but sibling packages of one
  workspace run under the same label at the same time.
- **The Postgres major is the package's**: a project on another major waits for the
  package or passes its own server through `TEST_DATABASE_URL`.
- The no-Docker path is tested on the decision function, not end to end: testcontainers
  falls back to `/var/run/docker.sock`, so a missing runtime cannot be simulated on a
  machine that has one.

### When to deviate (revisit triggers)

- A testcontainers major that changes reuse or reaper mechanics.
- A package that starts containers and cannot mount a vitest plugin (a non-vitest
  runner): the container rule will demand one.
- A suite that needs its server to outlive the run: that is `TEST_DATABASE_URL`; if it
  is not enough, this record is.

## Discarded directions

- **`.withReuse()` with a checkout label in the reuse hash.** pelion's first fix. It
  separates checkouts and keeps every other failure: no reuse within a run, nothing
  stopped, a schema of unknown age.
- **Dropping `.withReuse()` and letting Ryuk clean up.** Ryuk reaps when the last
  connection drops, between two test files: measured at 120 failing tests.
- **Stopping the container from the worker on `beforeExit`.** `beforeExit` fires
  between files too: 88 failing tests.
- **An auto-invalidating database name** (a hash of the migrations). It answers the
  stale schema and not the piling containers, and depends on a folder whose path may
  itself be wrong.
- **Pointing the tests at the compose Postgres.** It outlives the run, which is the
  stale-schema false green.
- **An optional `databaseName` with a default instance.** Instances without a name
  share one database and one migrations journal, the leak this package exists to
  close.
