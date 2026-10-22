---
status: accepted
date: 2026-10-22
tags: [testing, postgres, testcontainers, ryuk, docker, packages, test-utils]
---

# The test database of `@lntt/test-utils`

## Context

Every Lunette project runs its integration tests on a real Postgres started by
testcontainers, and gets the helpers from `@lntt/test-utils`. The react-router
template starts that Postgres from `createTestDb` with `.withReuse()`. The two
projects scaffolded from it (pelion, wai) met the same failures and converged on the
same fix; this package carries it. The counts below were measured in pelion and wai,
October 2026.

- **Reuse never reuses within a run.** It is a lookup at `start()`; vitest's workers
  start together, so none finds a container the others have not created yet. One
  pelion suite created 14 containers on 15 CPUs.
- **Nothing stops the containers.** `.withReuse()` excludes them from the reaper, and
  the template's `stopTestDb()` does not stop them: 24 alive in pelion, the oldest
  45 hours; one in wai up two days with nine databases.
- **A stale server makes a suite lie.** The reuse hash comes from the container
  configuration, not the checkout, so every clone and worktree on a machine attaches
  to the same server and the same `__drizzle_migrations` journal. A missing
  `migrationsFolder` was skipped silently and passed green on a schema an earlier run
  left.
- **A container needs an owner that lives as long as the run.** Without reuse and
  without a globalSetup, each worker starts a Postgres of its own, owned by a process
  that exits first; Ryuk, the testcontainers reaper, removes that container when its
  worker exits, between two test files (120 failing tests, exit 137). Owned by the
  vitest main process, the container outlives every test, and Ryuk removes it only
  once the run is gone.

## Decision

**One Postgres per vitest process, owned by a globalSetup in the main process and
handed to the workers as `TEST_DATABASE_URL`.**

```
vitest main process
  testDbPlugin().config()  -> registers the globalSetup, nothing else
  globalSetup.setup()      -> TEST_DATABASE_URL set: use it, start nothing
                           -> Docker: postgresContainer().start(), publish TEST_DATABASE_URL
                           -> no Docker: CI fails the run; locally publish nothing
    worker 1..N            -> createTestDb reads TEST_DATABASE_URL; one database per databaseName
  globalSetup.teardown()   -> stop the container
  exit / SIGTERM / SIGHUP  -> docker rm --force, synchronously
  SIGKILL                  -> Ryuk removes the container ~10 s after the last
                              testcontainers process on the machine disconnects
```

1. **The globalSetup owns the container**: it starts it and removes it, in the only
   process that outlives every worker, and it is the only code that does. `createTestDb`
   never starts one and exports no stop function for a test file to call: without the
   plugin, a `serverUrl` or `TEST_DATABASE_URL`, `withTestDb` and `connectionString()`
   reject with an error that names `testDbPlugin()`. Construction needs no server, so
   a suite that skips on `hasTestDatabase()` loads without Docker. Nothing is reused
   across runs.
2. **`postgresContainer()`** is the one factory: `postgres:17` (the template's major),
   data on tmpfs at the image's declared volume, labelled
   `com.lntt.workspace=<workspace root>`. The workspace root is the nearest directory
   holding `pnpm-workspace.yaml`, so each worktree is a workspace of its own.
3. **Ryuk is on.** The main process holds Ryuk's connection for the whole run, and
   no worker starts a container, so Ryuk removes the Postgres only after the run is
   gone. Ryuk is a per-machine singleton; every Node testcontainers process joins the
   running one and its session, and Ryuk removes the session's containers about 10 s
   after the last of them disconnects: a killed run's Postgres stays while another
   run is connected. No plugin and no setup of the package sets or clears
   `TESTCONTAINERS_RYUK_DISABLED`. A runtime that refuses Ryuk is first given
   `TESTCONTAINERS_RYUK_PRIVILEGED=true` (Podman); disabling Ryuk in the user's own
   shell is the last resort.
4. **The label serves cleanup only**, for what Ryuk misses. `lntt-clean-test` removes
   every container carrying this workspace's label, running or exited (`docker ps
   -a`), `--all` every workspace's, `--dry-run` lists them; it fails when `docker
   info` does not answer. The label and `workspaceRoot()`
   are their own Node-only module, `@lntt/test-utils/workspace`, so a suite that
   starts other containers labels them without loading the database module.
5. **The rules arm themselves.** `assertContainerRules(root, options?)` scans the
   sources of `apps/*` and `packages/*` and fails once, grouped by rule:
   - a workspace whose code uses `createTestDb` or `withTestDb` (comments and strings
     blanked) without a vitest config that calls `testDbPlugin()`; a workspace that
     only starts other containers needs no plugin: the file that starts one (a Vault,
     a Mailpit) starts it in its `beforeAll` and stops it in its `afterAll`, so the
     worker that owns it outlives its use, and Ryuk removes it when the run is killed;
   - any source (vitest configs and globalSetup files included, string literals
     counted, declaration files not) or `package.json` script that sets
     `TESTCONTAINERS_RYUK_DISABLED`, by an assignment or an object key; reading it
     is allowed;
   - a `new GenericContainer(` or `new PostgreSqlContainer(` whose builder chain has
     no `.withLabels(...)` with `WORKSPACE_LABEL` (or a constant in `options.labels`)
     as a computed key, `{ [WORKSPACE_LABEL]: … }`, so `lntt-clean-test` can find it.

   The scan reads source text with comments and strings blanked, not a syntax tree:
   a quote or a `/*` in a regular expression literal or in JSX text can throw it off
   for the rest of that file.
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
   A `SIGKILL`, or a signal during `start()`, is Ryuk's: the container carries the
   session label from its creation.
10. **An integration test asks for `tx`**: each app builds its `it` once with
    `export const it = txTest(db.withTestDb)`, and a test is
    `it('…', async ({ tx }) => …)`. The `tx` fixture is lazy (a test that does not
    destructure it opens no transaction), and Vitest resolves it only after the body,
    passed or failed, so the rollback always runs; `tx-test.test.ts` proves it on a
    committed table from a separate connection. **`withTestDb`** underneath rolls
    each callback back and knows no test runner: `txTest` is the only code that
    knows `test.extend`. **`connectionString()`** gives the migrated database to a
    test that must commit; that test removes what it committed.
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

### Measured

In wai (Welcome-Association-Italy/wai#441, 2026-10-14, testcontainers 12.0.4), with
`TESTCONTAINERS_RYUK_DISABLED` removed everywhere and a script that watched
`docker ps` for the run's labels and sent `SIGKILL` to the run's process group:

| Run | Outcome |
|---|---|
| integration suite, 41 files, 291 tests | green, no `ECONNREFUSED`, no container left |
| the same, `SIGKILL` mid-run | Postgres removed by Ryuk ~10 s after the kill |
| three more suites (51, 10, 39 files) | green, no `ECONNREFUSED` |
| one suite running while another is killed | the running one green; the orphan goes ~10 s after it ends |
| a Vault container suite, normal and killed | stopped in `afterAll`; removed by Ryuk ~10 s after the kill |
| Playwright e2e `globalSetup`, normal and killed | stopped in teardown; removed by Ryuk ~10 s after the kill |
| the whole monorepo through turbo | green |

In the starter (2026-10-22, macOS, Docker Desktop, testcontainers 12.0.4, Ryuk
0.14.0): a project scaffolded from the react-router template, with the packed package
and a `testDbPlugin()` package whose test holds the run open. With no other Ryuk
client on the machine, the run's process group was sent `SIGKILL` once its Postgres
was up and the test running; `docker ps` was polled every second for the
workspace label.

| Run | Postgres gone after the kill |
|---|---|
| 1 | 11 s |
| 2 | 12 s |
| 3 | 11 s |

## Consequences

### Positive

- What a run starts is removed however the run ends: by the run itself, or after a
  `SIGKILL` by Ryuk, about 10 s after the last Node testcontainers process on the
  machine disconnects.
- Every run builds its schema from its own migrations; a wrong migrations path fails
  at once.
- Two worktrees, or two packages of one, never share a server.
- Local and CI take the same path; `TEST_DATABASE_URL` is the only difference.

### Negative / accepted risks

- **Every run pays for starting a Postgres container**, unit-only runs of a package
  with the plugin included.
- **Every run needs Ryuk**: the `testcontainers/ryuk` image and a runtime that lets
  Ryuk mount the Docker socket. A machine offline without the image, or a runtime
  that refuses the mount, fails before the Postgres starts. On Podman,
  `TESTCONTAINERS_RYUK_PRIVILEGED=true` in the user's shell starts Ryuk privileged.
  `TESTCONTAINERS_RYUK_DISABLED=true` in that shell is the last resort: it gives up
  the `SIGKILL` cleanup, and `lntt-clean-test` removes that machine's killed runs.
- **Ryuk's session is the machine's**: every Node testcontainers process joins it, so
  a killed run's container goes about 10 s after the LAST of them disconnects, not
  after the kill: it stays while another run is connected.
- **Docker restarting** leaves the containers of a run alive at that moment exited:
  they have no restart policy, and Ryuk does not survive the restart.
  `lntt-clean-test` lists them with `docker ps -a` and removes them.
- **Integration tests are coupled to Vitest's fixture API**: the `({ tx })` signature
  and the app-level `it`. The coupling is contained (point 10; Playwright's fixtures
  have the same shape), but a change of test runner touches every integration
  test's signature.
- **The Postgres major is the package's**: a project on another major waits for the
  package or passes its own server through `TEST_DATABASE_URL`.
- The no-Docker path is tested on the decision function, not end to end: testcontainers
  falls back to `/var/run/docker.sock`, so a missing runtime cannot be simulated on a
  machine that has one.

### When to deviate (revisit triggers)

- A testcontainers major that changes reuse or reaper mechanics.
- A package that uses the test database and cannot mount a vitest plugin (a
  non-vitest runner): the container rule will demand one.
- A container runtime most of the team uses that cannot run Ryuk, privileged
  included: the escape hatch becomes the norm, and `SIGKILL` falls back to
  `lntt-clean-test`.
- A suite that needs its server to outlive the run: that is `TEST_DATABASE_URL`; if it
  is not enough, this record is.

## Discarded directions

- **`.withReuse()` with a checkout label in the reuse hash.** It separates checkouts
  and keeps every other failure: no reuse within a run, nothing stopped, a schema of
  unknown age.
- **Dropping `.withReuse()` and letting Ryuk clean up, with a container per worker.**
  Ryuk removes each container when its worker exits, between two test files (see
  Context).
- **Ryuk off everywhere, with `docker rm` on signals and `lntt-clean-test` for
  `SIGKILL`.** A `SIGKILL`ed run leaves its Postgres until someone runs `clean:test`.
- **Stopping the container from the worker on `beforeExit`.** `beforeExit` fires
  between files too: 88 failing tests.
- **An auto-invalidating database name** (a hash of the migrations). It answers the
  stale schema and not the piling containers, and depends on a folder whose path may
  itself be wrong.
- **Pointing the tests at the compose Postgres.** It outlives the run, which is the
  stale-schema false green.
- **Wrapping each test body in `withTestDb(async (tx) => …)`.** Every test pays a
  level of nesting, and nothing stops a test from writing outside the callback or
  from forgetting to open it. It is the layer under `txTest`, not the way to write a
  test.
- **`afterAll(() => stop…Db())` in test files.** Under the globalSetup it is a no-op,
  and under a shared module registry the first file that runs it can stop the
  database under the files that follow (pelion#1131).
- **An optional `databaseName` with a default instance.** Instances without a name
  share one database and one migrations journal, the leak this package exists to
  close.
