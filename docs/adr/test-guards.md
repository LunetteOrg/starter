---
status: accepted
date: 2026-10-22
tags: [testing, test-utils, vitest, biome, lint, guards]
---

# The guards of a project's test suite in `@lntt/test-utils`

## Context

A project that runs its jsdom tests in worker threads with `isolate: false` loads the
module registry once per worker and shares it with every file the worker runs, which
roughly halves a jsdom-heavy suite. Sharing the registry makes some test code leak
from one file into the next, and the leak depends on the order files run in: a test
passes alone and fails in the suite, or the reverse. Other drift in a suite goes
unseen for the opposite reason: nothing fails. A lint domain switched off, a lint
warning that exits 0, a test project whose package the task cache does not track.

pelion met each of these and wrote an architecture test per rule; the rules hold for
any Lunette project, so they ship in `@lntt/test-utils` as functions a project calls
from its own specs.

## Decision

The package exports one guard per rule. Each takes the project root (or a workspace),
throws a message naming every offending `file:line` and pointing at this record, and
fails when its scan finds nothing to check, so a moved folder cannot pass on an empty
list. The scans read the workspaces under `apps/*` and `packages/*` that have a
`package.json`, and in each the modules a test run loads: specs and tests, stories,
`*-kit.ts(x)` helpers and any module under a `test/` directory. A helper shares the
worker's registry with the spec that imports it, so it obeys the same rules. Build
output, `e2e/` (Playwright, no vitest registry) and `__fixtures__/` are not scanned.

### Module mocks

`assertNoModuleMocks(root)` fails on a hoisted `vi.mock` and on a `vi.doMock` without
`vi.resetModules()` before the first `vi.doMock` and after the last `vi.doUnmock`.
Comments, strings and regex literals are blanked first, so a mention of `vi.mock` in
them is no call, and a quote inside `/can't/` opens no string.

- A hoisted `vi.mock` registers in the shared registry and stays there: every later
  file of the worker imports the mock. A test replaces a dependency by injecting it,
  or with `vi.doMock` inside the test.
- `vi.resetModules()` before the mock makes the dynamic import load the mocked copy
  instead of the one already cached; the reset after `vi.doUnmock` keeps the next
  file from inheriting it.

### Waits

`assertWaitsDeclareTimeout(workspace)` (`@lntt/test-utils/waits`) fails on every
`findBy*`, `findAllBy*`, `waitFor`, `vi.waitFor` and `waitForElementToBeRemoved` that
does not pass the identifier `WAIT` where the timeout goes (`findBy*(query, options,
WAIT)`, `waitFor(callback, WAIT)`). A file declares `const WAIT = { timeout: 5_000 }`.

- A global `configure({ asyncUtilTimeout })` is module state: under `isolate: false`
  it reaches every file the worker runs after it. A timeout on each call does not.
- The identifier, not any options object, is what the guard accepts: one name says
  "this wait declared its budget" and is found by a search.
- The calls are found by parsing (`parseAst` from vite 8, which reads TypeScript and
  JSX), so a call in a comment or a string is no call. Only testing-library's query
  suffixes count, so a repository's `findById` is not a wait, and a `waitFor` with no
  argument or an object first is Playwright's `locator.waitFor(options?)`, not a wait.
- `ignore` takes globs, relative to the workspace, for modules the guard must not
  read (a fixture that does not parse).

`assertWaitingWorkspacesRunTheGuard(root)` is the rule that arms itself: every
workspace whose test modules wait has a spec or test that calls
`assertWaitsDeclareTimeout`, found by parsing as well. The guard sits in each workspace so that a wait without
`WAIT` fails that workspace's own test task, which a task cache keys on the
workspace's files. `vite` is an optional peer of the package: only this subpath
needs it, and vitest 4 already installs it.

### Lint

- `assertBiomeDomainsDeclared(root)` fails when a dependency of the root manifest or of
  a workspace calls for a Biome rule domain (`vitest` → `test`, `react` → `react`,
  `drizzle-orm` → `drizzle`…) that the project's Biome config does not switch on in
  `linter.domains` or an override. Biome enables a domain by itself only when it can
  read the dependency's version from a manifest; a `catalog:` or `workspace:` spec is
  no version, and the domain goes off without a diagnostic. The config is read with
  its comments (`biome.jsonc`) and its `extends`; the dependency table is a parameter
  with a default.
- `assertLintFailsOnWarnings(root)` fails on a `lint` or `lint:*` script whose
  `biome check|lint|ci` step lacks `--error-on-warnings`, or whose `stylelint` step
  lacks `--max-warnings 0`. A warning that exits 0 is a rule nobody enforces.

### The tx fixture

`assertTestsUseTxFixture(root)` fails on every test module that calls `withTestDb(`
itself. An integration test reaches the database through the `tx` fixture that
`txTest` of `@lntt/test-utils` (#90) builds, `export const it = txTest(db.withTestDb)`,
and asks for `tx` in its signature: the rollback around the test is the fixture's, so
a test cannot open a second transaction beside it or forget to roll its own back.
Passing the function by reference, as `txTest(db.withTestDb)` does, is no call. The
scan blanks comments, strings and regex literals first, like the module-mocks scan,
and reads the same modules.

### Test projects

`assertTestProjectsAreDependencies(workspace, config)` reads the inline projects of
the workspace's vitest config (or its own `test.include`) and fails when an include
points into another workspace whose package is not among the workspace's
dependencies or devDependencies. A project with no `include` points at its `root`
(and `test.dir`), where vitest's default include looks. An include whose fixed part
stops above one package (`../../packages/{ui,icons}/**`) fails: the guard names one
package per include. Without the dependency, pnpm does not link the
package for the tests' imports, and a task cache keyed on the workspace's
dependencies does not rerun those tests when only that package changes.

### What makes `isolate: false` safe

The module-mocks and waits guards remove the two leaks of a shared registry that
test code writes most often: a mock and a timeout that outlive their file. The other
state a file can leave behind (assignments to globals, fake timers, storage and
cookies, nodes added to the document, module-level singletons) is not a pattern a
scan can reject; `isolate: false` stays limited to jsdom-heavy app projects, where it
pays.

## Consequences

### Positive

- An order-dependent failure caused by a module mock or a global timeout is a red
  guard naming the line, before it is a flaky suite.
- A switched-off lint domain or a lint script that ignores warnings fails a test.
- The rules are the same code in every project, versioned with the package.

### Negative / accepted risks

- The checks read source text and configs, not the running suite: a mock reached
  through an alias of `vi`, or a test project given as a path to another config, is
  not seen.
- The module-mocks and tx-fixture scans tell a regex literal from a division by the
  token before the `/`, and do not read JSX: a regex right after `)`
  (`if (x) /'/.test(s)`) or an apostrophe in JSX text (`<p>Don't</p>`) is read as the
  start of a string, and the code after it on the following lines is not scanned. The
  waits scans parse the module and have neither miss.
- The wait guard requires vite 8; a project on an older vite cannot import
  `@lntt/test-utils/waits`.
- Projects call the guards from their own specs; a project that never calls one is not
  guarded by it. Once called, the wait guard extends itself to every workspace that
  waits; the others are one line each in one spec.

### When to deviate (revisit triggers)

- vitest gains a per-file reset of module mocks or of testing-library's configuration
  under `isolate: false`: the matching guard becomes redundant.
- Biome reads `catalog:` specs: the domains guard becomes a check on the defaults.

## Discarded directions

- **A `test-levels` guard** (every `.test` file opens an integration harness): the
  [`levels` check](./test-checks.md#decision) of `lntt check tests` holds it.
- **Accepting any options object as a wait's timeout.** An inline `{ timeout: 5_000 }`
  cannot be told from options that carry no timeout without evaluating them, and it
  scatters the budget across the file.
- **Matching waits with a regular expression.** It cannot tell a call from a mention in
  a string or a template literal, and misses the argument position.
- **Specs in this package that scan the project.** The package is installed in other
  projects and does not know their root; the guards are functions their specs call.
