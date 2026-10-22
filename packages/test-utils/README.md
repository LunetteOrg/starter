# @lntt/test-utils

Test helpers every Lunette project uses: a real Postgres per vitest run with a
rollback around each test, the vitest preset and the jsdom setup every package and
app starts from, the Playwright helpers of an app's e2e suite, the guards that keep
architecture, serialization and migrations honest, and the guards that keep the test
suite itself honest. Kept current by
version.

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

## The vitest preset

```ts
// packages/<name>/vitest.config.ts
import { sharedTest } from '@lntt/test-utils/vitest'
export default defineConfig({ test: { ...sharedTest(), testTimeout: 30_000 } })
```

```ts
// apps/<name>/vitest.config.ts
import { testDbPlugin } from '@lntt/test-utils/plugin'
import { appTest } from '@lntt/test-utils/vitest'

export default defineConfig({
  plugins: [testDbPlugin()],
  test: appTest({
    setupFiles: ['@testing-library/jest-dom/vitest'],
    // optional: specs too heavy to share the run, isolated and run last
    last: { name: 'dev-server', include: ['**/vite-deps.test.ts'] },
  }),
})
```

- **`sharedTest({ sources = 'src' })`** sets `unstubGlobals`, `unstubEnvs` and
  `restoreMocks` (no `vi.stubGlobal`, `vi.stubEnv` or `vi.spyOn` outlives its test:
  make them in `beforeEach`, not at module scope), the JUnit reporter writing
  `test-results/junit.xml`, and V8 coverage of `<sources>/**/*.{ts,tsx}` into
  `./coverage` (install `@vitest/coverage-v8` to run it). `sharedCoverage` and
  `sharedReporters` are exported on their own.
- **`appTest({ sources = 'app', exclude, setupFiles, last })`** adds 30 s and 60 s
  timeouts and two projects: **`fast`**, worker threads with `isolate: false`, so
  React and the router load once per worker; and **`last`**, when given, isolated
  and ordered after `fast` (its `include` globs are relative to the app's root, and
  `fast` excludes them). It lists the jsdom setup after your `setupFiles`, and throws
  if you list it there too: `@lntt/test-utils/jsdom-setup`, or a path ending in
  `test-utils/src/jsdom-setup` or `test-utils/dist/jsdom-setup`.
- `isolate: false` is safe only while no spec mocks a module with a hoisted
  `vi.mock`; `assertNoModuleMocks` (below) checks it. What else a shared registry carries from file to file,
  and the rule that keeps each safe, is in the starter's
  [vitest-preset ADR](https://github.com/LunetteOrg/starter/blob/main/docs/adr/vitest-preset.md).

### The jsdom setup

`@lntt/test-utils/jsdom-setup` is the setup file of every jsdom spec (`appTest()`
lists it; a config without `appTest()` lists it in `setupFiles` itself). It needs
`jsdom`, `@testing-library/react` and its peer `@testing-library/dom` in the project.

- **Stubs**, only where jsdom lacks the API: `ResizeObserver`, `scrollIntoView`,
  `Range` `getClientRects`/`getBoundingClientRect`, `elementFromPoint`, `matchMedia`;
  and jsdom's `localStorage`/`sessionStorage` where the global is missing (from
  Node 25, vitest's jsdom environment keeps Node's, `undefined` without
  `--localstorage-file`).
- **`IS_REACT_ACT_ENVIRONMENT`** set for every file.
- **After each test**: real timers, `cleanup()`, a 1 ms wait for timers an unmount
  scheduled. **After each file**: `localStorage`, `sessionStorage` and readable
  cookies cleared, nodes added to `document.head` removed.
- Node-environment files get only the real-timers restore.

**List it, never import it** from another setup file: an imported module runs once
per worker, and its hooks would reach only the first file. The guard:

```ts
// jsdom-setup.spec.ts, in a spec that knows the project root
import { assertNoJsdomSetupImports } from '@lntt/test-utils'

it('lists the jsdom setup, never imports it', () => {
  assertNoJsdomSetupImports(resolve(__dirname, '../../..'))
})
```

## The e2e helpers

```sh
pnpm add -D @lntt/test-utils @playwright/test
```

`@playwright/test` is an optional peer: only `@lntt/test-utils/playwright` loads it.

### A stable port per checkout

```ts
// apps/web/playwright.config.ts
import { fileURLToPath } from 'node:url'
import { definePlaywrightConfig } from '@lntt/playwright-config'
import { e2ePort } from '@lntt/test-utils/e2e-port'

export const PORT = e2ePort({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  app: 'web',
  apps: ['web', 'admin'],
})

export default definePlaywrightConfig({ port: PORT, globalSetup: './__tests__/global-setup.ts' })
```

`e2ePort` returns, in this order:

- **`E2E_PORT`, when it is set,** for the first app of `apps`, and the ports after it
  for the others (`E2E_PORT=4000`: `web` on 4000, `admin` on 4001).
- **`ciPort`, when `CI` is set and one is given.** Each app's config passes its own.
- **A port derived from a hash of the checkout's real path,** between 20000 and 29999
  (below the ephemeral ranges of Linux and macOS).

Each app of `apps` gets the port next to the previous one, so `apps` lists every app
with an e2e suite once, always in the same order; it defaults to the app alone. Two
worktrees run their suites at once on different ports; when two of them hash to the
same slot, `E2E_PORT` in one of them is the way out. The global setup starts the dev
server on the exported `PORT`.

### `test`, with hydration delayed on demand

Every e2e takes `test` from the helper; `expect`, `devices` and types still come from
`@playwright/test`. The opt-in `e2e-test-from-helper.grit` plugin of
`@lntt/biome-config` flags a spec that takes `test` from the runner.

```ts
import { ATTEMPT, repeatUntil, test } from '@lntt/test-utils/playwright'
import { expect } from '@playwright/test'

test('the language menu opens', async ({ page }) => {
  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'Language' })
  const menu = page.getByRole('menu')
  await repeatUntil(() => trigger.click(ATTEMPT), () => expect(menu).toBeVisible(ATTEMPT))
})
```

- **`E2E_HYDRATION_DELAY_MS`.** Set, every page of the test's context gets React DOM's
  client chunk that many milliseconds late, so the server HTML stays without handlers
  that long. A spec that passes only when hydration is fast fails. Read once when the
  module loads (`HYDRATION_DELAY_MS`); a value that is not whole milliseconds throws.
- **A run that delayed nothing fails.** A test that passed as expected, whose context
  loaded pages and none of them requested the chunk, fails, naming the pattern: the
  chunk was renamed, or the pages never hydrate. A page is the HTML a top-level
  navigation lands on; an iframe, a redirect hop, or a navigation to text, JSON or a
  download is not counted.
- **`hydrationChunk`** is the URL pattern held back. The default,
  `REACT_DOM_CLIENT_CHUNK`, is the chunk Vite's dep optimizer serves on the dev server;
  a suite against a build sets its own with `use: { hydrationChunk }` in the config. A
  test whose pages never hydrate sets `test.use({ hydrationChunk: null })`: nothing is
  delayed or checked there.
- **A context the test opens itself** (`browser.newContext()`) is not delayed;
  `delayHydration(context, { delayMs: HYDRATION_DELAY_MS, chunk })` delays it, and its
  `assertDelayed()` makes the same check.
- **`repeatUntil(gesture, effect)` and `ATTEMPT`.** When an e2e must touch a control
  that exists only in JavaScript, it repeats an idempotent gesture until the effect
  shows. `repeatUntil` sets no timeout: pass `ATTEMPT` (one second) to the gesture and
  to the effect, as above, or a lost gesture waits out the test's timeout. A gesture
  that is not idempotent (submitting a form) has no place in it.
- **`await expectFetchMetadata(request, expected)`.** Asserts the `Sec-Fetch-*`
  headers of the request, read with `request.allHeaders()` (`request.headers()` never
  holds them). The route that delays the chunk makes Playwright report every request
  of its context without them: on a context the delay routed, the assertion is
  recorded on the test as an `unchecked` annotation instead of failing. A request of
  any other context (`hydrationChunk: null`, a context the test opened and did not
  delay) is asserted in a delayed run too.

The delayed run is a script of the project, next to `test:e2e`:

```jsonc
// package.json at the project root
"scripts": { "e2e:hydration": "E2E_HYDRATION_DELAY_MS=${E2E_HYDRATION_DELAY_MS:-3000} turbo run test:e2e" }
```

The react-router template's `turbo.json` passes every variable to its tasks; a project
that narrows it declares `"passThroughEnv": ["E2E_HYDRATION_DELAY_MS"]` on `test:e2e`.

## The guards

| Export | Asserts |
|---|---|
| `assertLayerBoundaries`, `assertNoForbiddenImports`, `getImports` | import boundaries between layers, dynamic `import()` included |
| `assertNoEntitySpreadInReturn`, `findReturnSpreads` | no `return { ...entity }` in loaders and actions |
| `assertNoSourcePattern`, `findSourceMatches`, `blankCommentsAndStrings` | a forbidden pattern in code, comments and strings aside |
| `assertNoMigrationSafetyViolations`, `checkMigration` | migrations follow expand/migrate/contract; no down-migrations |
| `assertNoJsdomSetupImports`, `findJsdomSetupImports` | the jsdom setup is listed in `setupFiles`, never imported |
| `defineFixture` | a builder with defaults, deep-merged overrides |

Their messages cite the ADRs of a project scaffolded from the Lunette `react-router`
template (`docs/adr/architecture-and-boundaries.md`, `docs/adr/data-and-migrations.md`);
`assertNoJsdomSetupImports` cites the starter's `vitest-preset` ADR.

## The guards of the test suite

Each takes the project root (or a workspace) and throws a message that names every
`file:line` and the rule's record, the starter's
[test-guards ADR](https://github.com/LunetteOrg/starter/blob/main/docs/adr/test-guards.md),
which also says why each rule holds. Each fails when its scan finds nothing to read
(no test file, no lint script, no dependency with a domain, no test project into another
package), so a moved folder cannot pass vacuously; `assertWaitingWorkspacesRunTheGuard`
then passes a project whose tests do not wait.

| Export | Asserts |
|---|---|
| `assertNoModuleMocks`, `findModuleMocks` | no hoisted `vi.mock`; a `vi.doMock` has `vi.resetModules()` before the first `vi.doMock` and after the last `vi.doUnmock` |
| `assertWaitsDeclareTimeout`, `findWaits` (`@lntt/test-utils/waits`) | every `findBy*`, `findAllBy*`, `vi.waitFor`, and every `waitFor` and `waitForElementToBeRemoved` imported from `@testing-library/*`, `storybook/test` or `@storybook/test`, passes `WAIT` as its timeout (a helper of the project named `waitFor`, or Playwright's `locator.waitFor()`, is not a wait) |
| `assertWaitingWorkspacesRunTheGuard` (`@lntt/test-utils/waits`) | every workspace whose tests wait has a spec or test that imports `assertWaitsDeclareTimeout` from `@lntt/test-utils/waits` and calls it at its top level or in a test, suite or hook that is not skipped (`.skip`, `.todo`, `.skipIf`, `.runIf`, `.fails`, `x`-prefixed); a call inside another function does not count. The path it is given and a condition around it are not checked |
| `assertBiomeDomainsDeclared`, `enabledBiomeDomains`, `BIOME_DOMAIN_OF_DEPENDENCY` | a dependency with a Biome rule domain (`vitest` → `test`, `react` → `react`…) finds it switched on in the project's Biome config |
| `assertLintFailsOnWarnings` | every `lint` and `lint:*` script runs `biome check` with `--error-on-warnings` and `stylelint` with `--max-warnings 0` |
| `assertTestsUseTxFixture`, `findDirectTestDbCalls` | no test module calls `withTestDb(` itself: integration tests take `tx` from the fixture `txTest(db.withTestDb)` builds. It pairs with `txTest`, the tx fixture of this package: turn it on once the project builds its fixture with `txTest` |
| `assertTestProjectsAreDependencies`, `testProjectPackages` | every package a vitest test project includes files from, or points at with `root`, is a dependency of the workspace; the packages are found from the root holding `pnpm-workspace.yaml`, and an include into a directory that is no `apps/*` or `packages/*` package fails, naming it |

The scans read `apps/*` and `packages/*` (directories with a `package.json`): specs and
tests, stories, `*-kit.ts(x)` helpers and any module under a `test/` directory, since a
helper shares the worker's module registry with the spec that imports it. Build
output, `e2e/` and `__fixtures__/` inside a workspace are not scanned (a workspace
named `packages/build` or `apps/e2e` is); `ignore` takes more globs, relative to the
root (to the workspace for `assertWaitsDeclareTimeout`).

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

`@lntt/test-utils/waits` parses with `parseAst` from `vite` 8, an optional peer: a project
that declares it resolves it from the root.
`assertBiomeDomainsDeclared` reads `biome.json` or `biome.jsonc` at the root (comments
allowed) and follows its `extends`; `config` and `domains` override the file and the
dependency table.
