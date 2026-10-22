---
status: accepted
date: 2026-10-22
tags: [testing, e2e, playwright, hydration, ports, packages, test-utils, biome]
---

# The e2e helpers of `@lntt/test-utils`: delayed hydration, `repeatUntil` and the e2e port

## Context

A Lunette app renders on the server and hydrates in the browser. Its e2e suite runs on
Playwright with the base config of `@lntt/playwright-config`, which takes the port
from the app and starts no server of its own.

- **A spec that passes only when hydration is fast.** Before React DOM's client has
  loaded, a click on a control that exists only in JavaScript lands on server HTML
  with no handler and is lost. On a fast machine hydration wins the race and the spec
  is green; on a loaded CI runner the same spec fails now and then. pelion, scaffolded
  from the react-router template, found these specs by running the whole suite with
  React DOM's client chunk held back a few seconds.
- **Holding the chunk back strips `Sec-Fetch-*`.** Playwright reports a request it has
  routed with `context.route` without its Fetch Metadata headers, so an assertion on
  them cannot be read in that run.
- **Two worktrees of one project run their e2e suites at once.** With a fixed port per
  app, the second dev server finds the port taken.

## Decision

Two subpaths of `@lntt/test-utils`: `./playwright` and `./e2e-port`, and an opt-in
plugin of `@lntt/biome-config`. `@playwright/test` is an optional peer: only
`./playwright` loads it. `./e2e-port` depends on Node alone, so a
`playwright.config.ts` loads it without the database helpers.

```ts
// apps/web/playwright.config.ts
export const PORT = e2ePort({ root: fileURLToPath(new URL('../..', import.meta.url)), app: 'web' })
export default definePlaywrightConfig({ port: PORT, globalSetup: './__tests__/global-setup.ts' })

// apps/web/__tests__/menu.e2e.ts
import { ATTEMPT, repeatUntil, test } from '@lntt/test-utils/playwright'
import { expect } from '@playwright/test'
```

1. **Every e2e takes `test` from `@lntt/test-utils/playwright`.** Its `context`
   fixture reads `E2E_HYDRATION_DELAY_MS` once per worker, when the module loads
   (`HYDRATION_DELAY_MS`, 0 when unset; anything but whole milliseconds throws). With a
   delay, every request of the test's context for the `hydrationChunk` waits that long
   and then falls back to the next route, so a route the test installs still runs.
   Without one the fixture hands the context over untouched.
2. **A run that delays nothing fails.** When a test passed, its context loaded pages,
   and none of them requested the chunk, the fixture throws, naming the pattern: the
   chunk was renamed or the pages never hydrate, and a green delayed run would have
   proved nothing. A test that already failed keeps its own error.
3. **The chunk is an option.** `hydrationChunk` is a Playwright option fixture;
   `REACT_DOM_CLIENT_CHUNK` (`/react-dom_client\.js/`) is the default, the name Vite's
   dep optimizer gives React DOM's client on the dev server. A suite that runs against
   a build sets the pattern of the chunk its build emits, with `use: { hydrationChunk }`.
   `delayHydration(context, { delayMs, chunk })` does the same to a context the test
   opens itself with `browser.newContext()`, which the fixture does not reach.
4. **The lint rule is `e2e-test-from-helper.grit`**, mounted by the project on its e2e
   files and their fixtures, as the other e2e plugins. It flags an import that takes
   `test` from `@playwright/test`: by name, renamed, as the default export or through a
   namespace. `expect`, `devices` and `import type` pass.
5. **`expectFetchMetadata(headers, expected)`** asserts the `Sec-Fetch-*` headers in a
   normal run; under a delay it records an `unchecked` annotation on the test and
   returns, and the rest of the test runs.
6. **`repeatUntil(gesture, effect)` and `ATTEMPT` (one second).** A control that exists
   only in JavaScript is proved in a component test; when an e2e must touch one anyway,
   it repeats an idempotent gesture until the effect shows, each attempt bounded by
   `ATTEMPT`, so a gesture lost before hydration is repeated within a second instead
   of waiting out the test's timeout. A gesture that is not idempotent (submitting a
   form) is never repeated: the spec reaches that state another way.
7. **`e2ePort({ root, app, apps, ciPort, env })`**: `E2E_PORT` when set (an integer
   from 1 to 65535, anything else throws), `ciPort` when `CI` is set and one is given,
   otherwise the port derived from a SHA-256 of the checkout's real path, in
   `E2E_PORT_RANGE` (20000 to 29999). Each slot holds one port per app of `apps`, in
   that order, so the apps of one checkout never meet; `apps` defaults to the app
   alone. The range sits below the ephemeral ports of Linux (from 32768) and macOS
   (from 49152), so a port the system hands to a container mapping never lands on it.
   A symlink and its target, or a path with and without a trailing slash, get one port.
8. **The e2e port is separate from `lntt`'s local slots.** `lntt` runs an app by hand
   on `local.apps.<name>.port` plus ten per worktree slot, slots stored in the git
   common dir (`packages/lntt/src/local.ts`). The e2e suite starts its own server in
   its global setup, next to the containers it needs, while the developer's dev server
   may be up on the slot port of the same checkout: the two need different ports. The
   e2e port needs no git, no file and no `lntt`, because every Playwright worker
   evaluates the config. Local base ports stay outside 20000 to 29999.
9. **The delayed run is a script of the project**, not of this package, because it
   wraps the project's own e2e command:
   `"e2e:hydration": "E2E_HYDRATION_DELAY_MS=${E2E_HYDRATION_DELAY_MS:-3000} turbo run test:e2e"`.

The messages cite this record by URL, as the guards of `@lntt/test-utils` do.

## Consequences

### Positive

- A spec that depends on fast hydration fails in a delayed run on any machine, rather
  than now and then on CI.
- A delayed run that delayed nothing is red, so a renamed chunk cannot pass for a proof.
- Two worktrees run their e2e suites at once without choosing ports by hand.

### Negative / accepted risks

- The delay is paid on every page load: a test with many navigations nears its timeout
  in a delayed run.
- Two checkouts share a slot with a chance of `apps.length` in 10,000 per pair: then
  `E2E_PORT` on one of them.
- The default chunk matches the dev server only; a suite against a build that keeps
  the default fails every delayed test, by design, until it sets `hydrationChunk`.
- `Sec-Fetch-*` assertions are not checked in a delayed run.

### When to deviate (revisit triggers)

- Playwright reports Fetch Metadata headers on routed requests: `expectFetchMetadata`
  goes, and the assertions become plain ones.
- Vite renames the dep chunk or React Router stops serving React DOM separately in
  dev: the default changes.
- A project needs more e2e apps than a slot of 10,000 ports divided evenly can hold
  without collisions it notices: the range widens.

## Discarded directions

- **A `noRestrictedImports` override in the README instead of a plugin.** Biome keeps
  one options object per rule per file, and a later override's replaces an earlier
  one's: a project that restricts other imports in its e2e files would silently drop
  this restriction, or the reverse. The plugin is independent of the project's own
  rules and ships with the package version.
- **The override inside the shared `biome.json`.** Every project extending the config
  would get it, including one whose e2e suite does not use the helper; the plugins are
  opt-in.
- **The e2e port from `lntt`'s slot.** It would put the suite on the port of the dev
  server the developer runs in the same checkout, and make every Playwright worker run
  git and write the slots file.
- **Port derivation inside `@lntt/playwright-config`.** The port is also read by the
  app's global setup and by cleanup scripts that do not load the config; a Node-only
  module in `@lntt/test-utils` serves them all, and `definePlaywrightConfig` keeps
  taking the port it is given.
- **The app list and CI ports fixed in the package**, as pelion's two apps are. They are
  the project's: `apps` and `ciPort` are options.
- **A `pnpm e2e:hydration` script shipped as a bin.** What it runs (the e2e task, its
  filters, a lock shared with other local runs) is the project's pipeline.
