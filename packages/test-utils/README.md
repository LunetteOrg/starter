# @lntt/test-utils

Test helpers every Lunette project uses: a real Postgres per vitest run with a
rollback around each test, the guards that keep architecture, serialization and
migrations honest, and the guards that keep the test suite itself honest. Kept current
by version.

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
  A `SIGKILL` cannot be caught: Ryuk removes that Postgres about 10 s after the last
  Node testcontainers process on the machine disconnects, so it stays while another
  run is connected.
- **Ryuk, the testcontainers reaper, is on.** The globalSetup starts the Postgres in
  vitest's main process, which holds Ryuk's connection for the whole run, and no
  worker starts a container. Ryuk's session is shared by every Node testcontainers
  process on the machine: it removes the container about 10 s after the LAST of them
  disconnects, never while the run is alive. No plugin or setup of this package sets
  or clears `TESTCONTAINERS_RYUK_DISABLED`.
- **What Ryuk asks of the machine.** Every run needs the `testcontainers/ryuk` image
  and a runtime that lets Ryuk mount the Docker socket: offline without the image,
  or on a runtime that refuses the mount, the run fails before the Postgres starts.
  On Podman, set `TESTCONTAINERS_RYUK_PRIVILEGED=true` in your shell first:
  testcontainers then starts Ryuk privileged. Disabling Ryuk
  (`TESTCONTAINERS_RYUK_DISABLED=true`, in your own shell) is the last resort, and it
  gives up the `SIGKILL` cleanup: `clean:test` is then the net for a killed run.
- **Docker restarting.** The containers of a run alive when the Docker daemon
  restarts are left exited: they have no restart policy, and Ryuk does not survive
  the restart. `clean:test` lists stopped containers too (`docker ps -a`) and removes
  them.

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

A suite that starts containers of its own labels them the same way, from
`@lntt/test-utils/workspace`, a module that loads nothing beyond Node (no
testcontainers, postgres or drizzle):

```ts
import { WORKSPACE_LABEL, workspaceRoot } from '@lntt/test-utils/workspace'

const vault = await new GenericContainer('hashicorp/vault:1.18')
  .withLabels({ [WORKSPACE_LABEL]: workspaceRoot() })
  .start()
```

### The rule that arms itself

None of the ways a container goes wrong turns a test red: a package on
`createTestDb` without `testDbPlugin()` has no server, so its database suites reject,
or skip and go green on nothing; a `TESTCONTAINERS_RYUK_DISABLED` set in the project
leaves every killed run's containers; an unlabelled container is one `clean:test`
cannot find. Put this in a spec that knows the project root:

```ts
// meta-containers.spec.ts
import { resolve } from 'node:path'
import { assertContainerRules, testDbUsers } from '@lntt/test-utils'

const root = resolve(__dirname, '../../..')

it('finds the packages that use the test database', () => {
  expect(testDbUsers(root).length).toBeGreaterThan(0)
})
it('every container the tests start can be cleaned up', () => {
  assertContainerRules(root)
})
```

It scans the sources of `apps/*` and `packages/*` (`.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.mjs`, `.cjs`, vitest configs and globalSetup files included) and fails
once, listing every violation under its rule with what to do:

- **`testDbUsers`**: a workspace whose code calls `createTestDb` or `withTestDb`
  (comments and strings blanked) needs a `vitest*.config.*` that calls
  `testDbPlugin()`. A workspace that only starts other containers needs no plugin.
- **`ryukDisablers`**: no source may set `TESTCONTAINERS_RYUK_DISABLED`, by an
  assignment (`process.env.NAME = …`, `process.env['NAME'] = …`, or `??=`, `||=`,
  `&&=`) or an object key
  (`env: { NAME: … }`, `{ 'NAME': … }`), string literals included; and no `scripts`
  entry of the root's or a workspace's `package.json` may assign or export it.
  Reading the variable, or checking that it is absent, is allowed; declaration files
  (`*.d.ts`) are not read. A `package.json` that is not valid JSON, or not an object,
  fails the rule, naming the file.
- **`unlabelledContainers`**: every `new GenericContainer(` and
  `new PostgreSqlContainer(` needs, in its builder chain, a `.withLabels(...)` whose
  argument has `WORKSPACE_LABEL` as a computed key: `{ [WORKSPACE_LABEL]: … }`. Pass
  `{ labels: ['E2E_LABEL'] }` to accept other label constants. Links written `?.`,
  after a `!`, or with generic arguments are part of the chain. Other container
  classes (`new RedisContainer(`) are not checked. Only the chain and the literal key
  are read: a container labelled later through a variable, labels spread from an
  object (`{ ...labels }`) and a chain broken by an `as` cast fail the rule; label it
  in the chain, with the constant as the key.

The rules read source text, not a syntax tree: a quote or a `/*` inside a regular
expression literal or JSX text can throw the scan off for the rest of that file,
passing a violation or failing a correct line.

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

## The guards of the test suite

Each takes the project root (or a workspace) and throws a message that names every
`file:line` and the rule's record, the starter's
[test-guards ADR](https://github.com/LunetteOrg/starter/blob/main/docs/adr/test-guards.md),
which also says why each rule holds. Each fails when its scan finds nothing to check,
so a moved folder cannot pass vacuously.

| Export | Asserts |
|---|---|
| `assertNoModuleMocks`, `findModuleMocks` | no hoisted `vi.mock`; a `vi.doMock` has `vi.resetModules()` before the first `vi.doMock` and after the last `vi.doUnmock` |
| `assertWaitsDeclareTimeout`, `findWaits` (`@lntt/test-utils/waits`) | every `findBy*`, `findAllBy*`, `waitFor`, `vi.waitFor` and `waitForElementToBeRemoved` passes `WAIT` as its timeout (Playwright's `locator.waitFor(options?)` is not a wait) |
| `assertWaitingWorkspacesRunTheGuard` (`@lntt/test-utils/waits`) | every workspace whose tests wait has a test calling `assertWaitsDeclareTimeout` |
| `assertBiomeDomainsDeclared`, `enabledBiomeDomains`, `BIOME_DOMAIN_OF_DEPENDENCY` | a dependency with a Biome rule domain (`vitest` → `test`, `react` → `react`…) finds it switched on in the project's Biome config |
| `assertLintFailsOnWarnings` | every `lint` and `lint:*` script runs `biome check` with `--error-on-warnings` and `stylelint` with `--max-warnings 0` |
| `assertTestsUseTxFixture`, `findDirectTestDbCalls` | no test module calls `withTestDb(` itself: integration tests take `tx` from the fixture `txTest(db.withTestDb)` builds. It pairs with `txTest`, the tx fixture [#90](https://github.com/LunetteOrg/starter/issues/90) adds to this package: turn it on once the project builds its fixture with `txTest` |
| `assertTestProjectsAreDependencies`, `testProjectPackages` | every package a vitest test project includes files from, or points at with `root`, is a dependency of the workspace; the packages are found from the root holding `pnpm-workspace.yaml` |

The scans read `apps/*` and `packages/*` (directories with a `package.json`): specs and
tests, stories, `*-kit.ts(x)` helpers and any module under a `test/` directory, since a
helper shares the worker's module registry with the spec that imports it. Build
output, `e2e/` and `__fixtures__/` are not scanned; `ignore` takes more globs,
relative to the root (to the workspace for `assertWaitsDeclareTimeout`).

```ts
// packages/test-utils/src/suite.spec.ts: the project-wide guards
import { assertBiomeDomainsDeclared, assertLintFailsOnWarnings, assertNoModuleMocks } from '@lntt/test-utils'
import { assertWaitingWorkspacesRunTheGuard } from '@lntt/test-utils/waits'

const root = resolve(__dirname, '../../..')

it('no test mocks a module for the whole worker', () => assertNoModuleMocks(root))
it('every workspace that waits runs the wait guard', () => assertWaitingWorkspacesRunTheGuard(root))
it('the Biome domains of the stack are declared', () => assertBiomeDomainsDeclared(root))
it('a lint warning fails the script', () => assertLintFailsOnWarnings(root))
```

```ts
// apps/web/app/waits.spec.ts: in each workspace whose tests wait
import { assertWaitsDeclareTimeout } from '@lntt/test-utils/waits'

it('every findBy* and waitFor declares its timeout', () => {
  assertWaitsDeclareTimeout(resolve(__dirname, '..'), 'apps/web')
})
```

```ts
// in a test file that waits
const WAIT = { timeout: 5_000 }

await screen.findByRole('button', { name: 'Send' }, WAIT)
await waitFor(() => expect(onSend).toHaveBeenCalled(), WAIT)
```

```ts
// apps/design-system/src/test-projects.spec.ts: in a workspace whose projects include other packages
import { assertTestProjectsAreDependencies } from '@lntt/test-utils'
import config from '../vitest.config.ts'

it('every package a test project includes is a dependency', () => {
  assertTestProjectsAreDependencies(resolve(__dirname, '..'), config)
})
```

`@lntt/test-utils/waits` parses with `parseAst` from `vite` 8, an optional peer: vitest
4 already installs it, and a project that declares it resolves it from the root.
`assertBiomeDomainsDeclared` reads `biome.json` or `biome.jsonc` at the root (comments
allowed) and follows its `extends`; `config` and `domains` override the file and the
dependency table.
