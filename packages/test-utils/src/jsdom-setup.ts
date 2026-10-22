/// <reference lib="dom" />
/**
 * The setup every jsdom test file needs: the APIs jsdom lacks (`jsdom-env.ts`) and
 * the teardown that keeps one file from leaking into the next when the files of a
 * worker share the environment and the module registry (`isolate: false`).
 *
 * List it in `setupFiles` itself (`appTest()` does), never import it from another
 * setup file: setup files run again for every test file, a module they import runs
 * once per worker, and the hooks below would reach only its first file.
 *
 * Everything that touches the DOM is behind `typeof window !== 'undefined'`: an app
 * runs this setup for its node-environment files too, where an invented API would be
 * missed by nobody and would hide the real absence.
 */
import { afterAll, afterEach, vi } from 'vitest'
import { clearCookies, clearStorage, installDomStubs, removeHeadNodesAddedSince } from './jsdom-env.ts'

/**
 * `act()` flushes updates synchronously only when this flag is true.
 * `@testing-library/react` sets it in a `beforeAll` registered when it loads, so with
 * a shared registry only the first file of a worker gets it, and that file's
 * `afterAll` resets it for the rest. Setup files run for every test file.
 */
const reactActEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true

/**
 * A component that schedules work on unmount with a short `setTimeout` (an editor
 * destroyed in `setTimeout(…, 1)`) would otherwise run it once the environment is
 * gone, and fail the run on `window is not defined` with every test green. Timers of
 * the same delay fire in scheduling order, so waiting 1ms after `cleanup()` outlasts
 * them.
 */
const UNMOUNT_TIMERS_MS = 1

if (typeof window === 'undefined') {
  // Fake timers have no global restore: one test's clock would reach the next file.
  afterEach(() => {
    vi.useRealTimers()
  })
} else {
  installDomStubs()

  // Imported only here: a node-environment file has no tree to unmount and no reason
  // to load React.
  const { cleanup } = await import('@testing-library/react')

  // One hook, so the order does not depend on how vitest sequences hooks: real
  // timers first, or the wait below would never end on a fake clock.
  afterEach(async () => {
    vi.useRealTimers()
    cleanup()
    await new Promise((resolve) => setTimeout(resolve, UNMOUNT_TIMERS_MS))
  })

  // What a file leaves in the shared environment, removed when the file ends rather
  // than after each test: a file may set up storage in `beforeAll` for its tests.
  const headAtStart = new Set(document.head.childNodes)
  afterAll(() => {
    clearStorage()
    clearCookies()
    removeHeadNodesAddedSince(headAtStart)
  })
}
