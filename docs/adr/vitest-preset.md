---
status: accepted
date: 2026-10-22
tags: [testing, vitest, jsdom, isolate, packages, test-utils]
---

# The vitest preset and the jsdom setup of `@lntt/test-utils`

## Context

A Lunette project's suite is mostly two kinds of files: node specs in its packages,
and jsdom component specs in its apps. pelion, scaffolded from the react-router
template, wrote the same `test` block into every package and converged on one shape
for its apps.

- **A stub or spy outlives its test** unless something undoes it: a manual restore at
  the end of a test is skipped when an assertion before it fails.
- **Each jsdom file reloads React, the router and the component library** when vitest
  isolates files. With the module registry and the environment shared by the files
  of a worker (`isolate: false`, worker threads) a jsdom-heavy suite skips those
  reloads, and pelion's two apps ran markedly faster; a node-only package has nothing
  heavy to reload and gains next to nothing. The timings are in
  [issue #92](https://github.com/LunetteOrg/starter/issues/92#issuecomment-6195713671).
- **One spec that boots a whole Vite dev server** takes over a gigabyte; run alongside
  the others, the sum got the CI process killed.
- **jsdom lacks APIs a real DOM always has** (`ResizeObserver`, `scrollIntoView`,
  `matchMedia`, range rects, `elementFromPoint`), and a shared environment carries
  what one file leaves into the next.

## Decision

Two subpaths of `@lntt/test-utils`: `./vitest` (the preset) and `./jsdom-setup`
(the setup file). `@testing-library/react` is an optional peer: only the jsdom setup
loads it.

```ts
// packages/<name>/vitest.config.ts
export default defineConfig({ test: { ...sharedTest(), testTimeout: 30_000 } })

// apps/<name>/vitest.config.ts
export default defineConfig({
  plugins: [testDbPlugin()],
  test: appTest({
    setupFiles: ['@testing-library/jest-dom/vitest'],
    last: { name: 'dev-server', include: ['**/vite-deps.test.ts'] },
  }),
})
```

1. **`sharedTest({ sources })` is every package's `test` block.**
   - `unstubGlobals`, `unstubEnvs` and `restoreMocks`: before each test vitest undoes
     every `vi.stubGlobal`, `vi.stubEnv` and `vi.spyOn`. A stub made at module scope
     or in `beforeAll` is undone before the first test: it goes in `beforeEach`.
   - The JUnit reporter next to the default one, written to
     `test-results/junit.xml` in the package, the file a CI job collects.
   - V8 coverage (`sharedCoverage`) written to `./coverage`, so a task runner can
     declare it as an output, with `text-summary`, `html` and `json-summary` reports,
     and `include` set to `<sources>/**/*.{ts,tsx}` (`src` by default). Specs, tests,
     stories, `test/` folders and `.react-router/` are excluded; barrels are not. No
     thresholds: a project sets them when it decides one.
   - No `pool` and no `isolate`: a package keeps vitest's isolation.
2. **`appTest({ sources, exclude, setupFiles, last })` is an app's `test` block**:
   `sharedTest` on `app` (React Router's directory), the longer test and hook timeouts
   of a component suite (their values are in `appTest()`), and projects that inherit
   it (`extends: true`):
   - **`fast`**, every file not excluded: `pool: 'threads'`, `isolate: false`.
   - **`last`**, when given: the heavy specs, by name and globs the app passes, with
     vitest's isolation and `sequence.groupOrder: 1`, so they run after `fast` and
     their memory does not add to it. `fast` excludes the same globs. They are
     relative to the app's root, as vitest's `include`: a spec in a subdirectory needs
     a leading `**/`. A `last` with an empty `include` throws.
   - `exclude` adds to vitest's defaults, `.react-router/`, `build/` and `e2e/`.
3. **The jsdom setup is listed in `setupFiles`, never imported.** Setup files run
   again for every test file; a module they import runs once per worker, so under
   `isolate: false` its hooks would reach only the first file of each worker.
   `appTest()` appends `@lntt/test-utils/jsdom-setup` after the app's own setup files.
   It throws when the app lists it too, and `assertNoJsdomSetupImports(root)` fails on
   any import of it (side effect, `from`, dynamic, `require`) in the workspaces under
   `apps/*` and `packages/*`, naming the file and line; a project calls it from a
   spec, as it calls the other guards. Both recognise it the same way: by its package
   name, by the built file under `node_modules`, or by a path ending in
   `test-utils/src/jsdom-setup` or `test-utils/dist/jsdom-setup`, with no extension
   or one of `.js`, `.ts`, `.mjs`, `.cjs`, `.mts`, `.cts`. An app's own file named
   `jsdom-setup`, an alias, or a copy under another directory name is not caught; an
   app's own file at such a path is.
4. **What the jsdom setup does**, in every jsdom file. Everything that touches the DOM
   is behind `typeof window !== 'undefined'`: an app's node files run the same setup.
   - **Stubs** for what jsdom lacks, each installed only when missing:
     `ResizeObserver` (no-op), `Element.prototype.scrollIntoView` (no-op),
     `Range.prototype.getClientRects` (empty) and `getBoundingClientRect` (zeroed),
     `document.elementFromPoint` (`null`), `window.matchMedia` (matches nothing). A
     component never guards these with `typeof … === 'function'`; a test that asserts
     a call puts its own `vi.spyOn` on top.
   - **jsdom's `localStorage` and `sessionStorage`** where the global is missing. From
     Node 25, Node defines both globals and vitest's jsdom environment keeps Node's:
     `localStorage` is `undefined` unless Node runs with `--localstorage-file`. A
     storage the environment has, Node's `sessionStorage` included, stays.
   - **`IS_REACT_ACT_ENVIRONMENT = true`**, set by the setup for every file:
     `@testing-library/react` sets it in a `beforeAll` registered when it loads, which
     under a shared registry reaches only the first file.
   - **After each test**, in one hook so the order is fixed: real timers back
     (`vi.useRealTimers()`, which vitest does not restore on its own), `cleanup()`,
     then a 1 ms wait so a timer an unmount scheduled (an editor destroyed in
     `setTimeout(…, 1)`) fires while the environment exists. A node file gets the
     real-timers restore alone.
   - **After each file**: `localStorage` and `sessionStorage` cleared, the cookies the
     page can read expired (path `/` and the current path), and the nodes added to
     `document.head` during the file removed. Per file rather than per test, because a
     file may set them up in `beforeAll`.

### What the shared registry still leaks

The setup does not undo these. Each is safe while the suite follows the rule beside
it; none has been seen failing in pelion.

| Leak | The rule that keeps it safe |
|---|---|
| A hoisted `vi.mock` of a module: every later file of the worker gets the mock | No `vi.mock` in a file of `fast`; `vi.doMock` with `vi.resetModules()` around it, or dependency injection. `assertNoModuleMocks` of `@lntt/test-utils` asserts it ([test-guards](./test-guards.md)) |
| A direct assignment to `window`, `globalThis` or a prototype | `vi.stubGlobal` or `vi.spyOn`, which `sharedTest()` undoes |
| A module-level singleton (a store, a cache, a client) | Built per test, or reset by the module's own test helper in `beforeEach` |
| A global testing-library `configure({ asyncUtilTimeout })` | A timeout on each `findBy*` and `waitFor` call (`const WAIT = { timeout: 5_000 }`) |
| A promise or a real timer longer than 1 ms that outlives its file | Awaited, or cleared by the component's unmount |
| Listeners on `window` or `document`, history entries, attributes on `<html>` and `<body>`, custom elements | Removed by the code that added them; `customElements.define` is not undoable and runs once per worker |
| A cookie set on another path or domain | Not readable from the page, so not cleared: set on `/` |

A project whose suite breaks one of these rules keeps the file out of `fast`: in
`last`, or in a project of its own with vitest's isolation.

### Patterns worth documenting, not shipping

- **Layout logic as a pure function in the UI package, proved in a real browser.**
  "Does this element end below the viewport?" is a function in `packages/ui`, tested
  in the browser project; the app tests only how it is wired, in jsdom, and needs no
  browser project of its own.
- **A page harness per family of routes.** Detail pages that share seeding, session,
  loader and markup share one harness instead of a copy of each per route.
- **Sharp test levels.** A pure property (ordering, dedupe, normalisation) is asserted
  on the function, not through the fetcher that feeds it. The levels themselves are
  `lntt check tests levels` ([test-checks](./test-checks.md)).

## Consequences

### Positive

- A package's config is one spread, an app's one call; a stub or spy cannot outlive
  its test.
- An app's jsdom specs load the framework once per worker.
- Importing the jsdom setup from a setup file, by name or by a path to this package,
  fails in the project's suite, not in a file that leaks only when the order of files
  changes.

### Negative / accepted risks

- Under `isolate: false` the leaks above are kept out by rules, not by the runner. A
  guard of `@lntt/test-utils` asserts only the hoisted `vi.mock`
  ([test-guards](./test-guards.md)); the review holds the others, and a project adds a
  `tests.rules` pattern for the ones a pattern can catch.
- A path does not say which package holds a file: an app's own
  `test-utils/src/jsdom-setup` or `test-utils/dist/jsdom-setup` is refused in
  `setupFiles` and reported when imported, as this package's setup would be. The app
  renames its directory or its file.
- The setup's 1 ms wait adds to every jsdom test.
- Fake timers are reset after every test of an app: a test that keeps a fake clock
  across tests sets it up in `beforeEach`.

### When to deviate (revisit triggers)

- A file of the `fast` project fails alone and passes in the run, or the reverse: a
  leak the table does not hold. It moves out of `fast`, and the table gains a row.
- vitest gains a per-file reset of the shared environment, or `isolate: false` stops
  being faster than isolation on an app's jsdom suite.

## Discarded directions

- **`isolate: false` in `sharedTest()`.** Node-only packages gain next to nothing,
  and would take on every leak above.
- **A separate `@lntt/vitest-config` package.** The preset lists the jsdom setup by
  this package's name, and the guards share its scanning; one published package with
  subpaths keeps them at the same version.
- **Importing the jsdom setup from the app's own setup file.** Its hooks would reach
  the first file of each worker only.
- **The heavy project named `dev-server` with pelion's `vite-deps.test.ts`.** Which
  spec is heavy and what it is called is the app's: both are options of `appTest()`.
- **Clearing storage and cookies after each test.** A file that seeds them in
  `beforeAll` for its tests would lose them after the first.
