# @lntt/test-utils

Test helpers every Lunette project uses: a real Postgres per vitest run with a
rollback around each test, and the guards that keep architecture, serialization and
migrations honest. Kept current by version.

```sh
pnpm add -D @lntt/test-utils vitest drizzle-orm
```

## The test database

```ts
// vitest.config.ts of every package whose tests touch the database
import { testDbPlugin } from '@lntt/test-utils/plugin'
export default defineConfig({ plugins: [testDbPlugin()] })
```

```ts
// the app's test database, once: app/test/db.ts
import { createTestDb, txTest } from '@lntt/test-utils'

export const db = createTestDb({ databaseName: 'web', migrationsFolder: './drizzle', relations })
export const it = txTest(db.withTestDb)
```

```ts
// an integration test
import { hasTestDatabase } from '@lntt/test-utils'
import { describe } from 'vitest'
import { it } from '#app/test/db'

describe.skipIf(!hasTestDatabase())('users repository', () => {
  it('finds a user by email', async ({ tx }) => {
    // writes here are rolled back when the test ends, passed or failed
  })
})
```

An integration test asks for `tx` in its signature. That is the way to write one.

- **One Postgres per vitest process.** `testDbPlugin()` registers a globalSetup that
  starts `postgres:17` (data on tmpfs) in vitest's main process, publishes it as
  `TEST_DATABASE_URL` to the workers, and removes it at the end. Two packages run at
  once get two servers; two worktrees of a project never share one. Nothing is
  reused across runs.
- **The globalSetup is the only owner of the container.** `createTestDb` never starts
  one, and there is no stop function for a test file to call. Without the plugin, a
  `serverUrl` or `TEST_DATABASE_URL`, `withTestDb` and `connectionString()` reject
  with an error that names `testDbPlugin()`; `createTestDb()` itself needs no server,
  so a suite that skips on `hasTestDatabase()` still loads without Docker.
- **`databaseName` is required.** Each `createTestDb` owns a database on the run's
  server, created on first use, with its own schema and `__drizzle_migrations`
  journal. One per app or one per test file is the project's choice. A lower-case
  identifier (`/^[a-z_][a-z0-9_]*$/`).
- **Migrations** run once per database, under an advisory lock, on a single
  connection. A `migrationsFolder` that does not exist throws at `createTestDb()`,
  naming the resolved path and the cwd: it is resolved from the package vitest runs
  in, not from the test file.
- **`txTest(withTestDb)`** turns the transaction into the Vitest fixture `tx`. It is
  lazy: a test that does not destructure `tx` opens no transaction. Vitest resolves
  the fixture only once the test body is over, passed or failed, so the rollback
  always runs; `src/tx-test.test.ts` proves it against a committed table.
- **`withTestDb`** underneath runs a callback in a transaction and rolls it back,
  whether it returns or throws; an error thrown inside is rethrown. It knows no test
  runner ([ADR](../../docs/adr/test-database.md), point 10).
  **`connectionString()`** returns the migrated database's URL for a test that must
  commit (two transactions racing on their own connections); that test removes its
  rows itself.
- **No Docker on a developer machine**: the globalSetup publishes no server, unit tests
  run and database suites skip on `hasTestDatabase()`. **With `CI` set** a missing
  Docker fails the run.
- **A killed run** (Ctrl-C, turbo stopping a task when a sibling fails, a closed
  terminal) removes its container synchronously on `exit`, `SIGTERM` and `SIGHUP`.
  A `SIGKILL` cannot be caught: `lntt-clean-test` is the net.
- **Ryuk is off** in the main process and in the workers: it would kill the run's
  server between two test files. `ryukDisabledPlugin()` is that half alone, for a
  package that starts other containers and stops them itself.

### `TEST_DATABASE_URL` set by you

When `TEST_DATABASE_URL` is already set, the globalSetup starts nothing and
`createTestDb` uses that server. That is right for **a server fresh per run**: a CI
service container or a job image that lives as long as the job. It is wrong for **a
server that outlives the run**, such as the project's `compose.yaml` Postgres: its
databases keep their `__drizzle_migrations` between runs, so an edited migration is
never re-applied and the suite goes green on a schema no migration builds. Drop the
test databases whenever the migrations change, or leave the variable unset.

### Cleanup

Every container carries the label `com.lntt.workspace=<workspace root>`, the nearest
directory holding `pnpm-workspace.yaml`.

```jsonc
// package.json at the project root
"scripts": { "clean:test": "lntt-clean-test" }
```

`pnpm clean:test` removes this workspace's test containers, `--all` every
workspace's (worktrees that no longer exist), `--dry-run` only lists them. It
removes by label, never by image, and fails when the Docker daemon does not answer
rather than report a clean machine it cannot see.

### The rule that arms itself

A package on `createTestDb` without the plugin has no server: its database suites
reject, or skip and go green on nothing. A package that starts containers itself
without one leaves a Postgres per worker behind, and no test turns red. Put this in
a spec that knows the project root:

```ts
// meta-containers.spec.ts
import { assertContainerUsersMountAPlugin, containerUsers } from '@lntt/test-utils'

const root = resolve(__dirname, '../../..')

it('finds the packages that start containers', () => {
  expect(containerUsers(root).length).toBeGreaterThan(0)
})
it('every one of them mounts testDbPlugin() or ryukDisabledPlugin()', () => {
  assertContainerUsersMountAPlugin(root)
})
```

It scans `apps/*` and `packages/*` for `createTestDb`, `postgresContainer`,
`new PostgreSqlContainer` and `new GenericContainer`, comments and strings blanked,
and requires a vitest config that calls a plugin.

## The guards

| Export | Asserts |
|---|---|
| `assertLayerBoundaries`, `assertNoForbiddenImports`, `getImports` | import boundaries between layers, dynamic `import()` included |
| `assertNoEntitySpreadInReturn`, `findReturnSpreads` | no `return { ...entity }` in loaders and actions |
| `assertNoSourcePattern`, `findSourceMatches`, `blankCommentsAndStrings` | a forbidden pattern in code, comments and strings aside |
| `assertNoMigrationSafetyViolations`, `checkMigration` | migrations follow expand/migrate/contract; no down-migrations |
| `defineFixture` | a builder with defaults, deep-merged overrides |

Their messages cite the ADRs of a project scaffolded from the Lunette `react-router`
template (`docs/adr/architecture-and-boundaries.md`, `docs/adr/data-and-migrations.md`).
