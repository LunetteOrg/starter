// What every e2e of a Lunette app imports in place of `@playwright/test`'s `test`, and the
// helpers for a control that exists only in JavaScript. The reasons are in the
// starter's docs/adr/e2e-helpers.md.

import { type BrowserContext, test as base, expect, type TestInfo } from '@playwright/test'

/** The record the messages of this module cite. */
export const E2E_HELPERS_RECORD = 'https://github.com/LunetteOrg/starter/blob/main/docs/adr/e2e-helpers.md'

/** How long one attempt waits for the effect before `repeatUntil` repeats the gesture. */
export const ATTEMPT = { timeout: 1_000 }

/**
 * Repeats an idempotent gesture on a control that exists only in JavaScript until its
 * effect shows. Before hydration the gesture lands on server HTML with no handler and
 * is lost; repeating it waits for hydration without reading anything the app writes
 * for the suite.
 *
 * ```ts
 * await repeatUntil(() => trigger.click(ATTEMPT), () => expect(menu).toBeVisible(ATTEMPT))
 * ```
 *
 * The effect asserts with `ATTEMPT`, so a lost gesture is repeated within a second
 * instead of waiting out the test's timeout.
 */
export async function repeatUntil(gesture: () => Promise<unknown>, effect: () => Promise<unknown>): Promise<void> {
  await expect(async () => {
    await gesture()
    await effect()
  }).toPass()
}

/** `E2E_HYDRATION_DELAY_MS` as milliseconds; 0 when unset. */
export function parseHydrationDelay(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `E2E_HYDRATION_DELAY_MS must be a whole number of milliseconds, got "${value}" (${E2E_HELPERS_RECORD})`,
    )
  }
  return Number(value)
}

/** Read once per worker, when the module loads: the delay of this run, 0 in a normal one. */
export const HYDRATION_DELAY_MS = parseHydrationDelay(process.env.E2E_HYDRATION_DELAY_MS)

/**
 * The chunk Vite's dep optimizer serves React DOM's client from on the dev server
 * (`/node_modules/.vite/deps/react-dom_client.js`): what a React Router app loads
 * before it hydrates. A suite run against a build sets `hydrationChunk` to the chunk
 * its build emits.
 */
export const REACT_DOM_CLIENT_CHUNK = /react-dom_client\.js/

export interface HydrationDelayOptions {
  delayMs: number
  /** The URL pattern of the chunk to hold back, as `context.route` takes it. */
  chunk: string | RegExp
}

export interface HydrationDelay {
  /** Throws when the context loaded pages and none of them requested the chunk. */
  assertDelayed(): void
}

/**
 * Holds back the chunk for `delayMs` on every page of `context`, so the server HTML stays
 * without handlers for that long. The `test` of this module does it to the test's own
 * context; a test that opens one with `browser.newContext()` calls it on that one.
 */
export async function delayHydration(
  context: BrowserContext,
  { delayMs, chunk }: HydrationDelayOptions,
): Promise<HydrationDelay> {
  let documents = 0
  let delayed = 0
  context.on('request', (request) => {
    if (request.resourceType() === 'document') documents++
  })
  await context.route(chunk, async (route) => {
    delayed++
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    // fallback, not continue: a route the test installs on the same URL still runs.
    await route.fallback()
  })
  return {
    assertDelayed() {
      if (documents > 0 && delayed === 0) {
        throw new Error(
          `E2E_HYDRATION_DELAY_MS is set but none of the ${documents} pages loaded a chunk matching ${String(chunk)}: ` +
            `the chunk was renamed or the pages never hydrate. Set hydrationChunk to the chunk the app loads (${E2E_HELPERS_RECORD})`,
        )
      }
    },
  }
}

interface HydrationFixtures {
  /** The chunk `E2E_HYDRATION_DELAY_MS` holds back. Default: `REACT_DOM_CLIENT_CHUNK`. */
  hydrationChunk: string | RegExp
}

/**
 * The `context` fixture of `test`: with a delay, every page of the test's context gets
 * the chunk that late, and a passing test that loaded pages and delayed none fails, so
 * a run that proved nothing is not green. A test that already failed keeps its own error.
 */
export function hydrationDelayFixture(delayMs: number) {
  return async (
    { context, hydrationChunk }: { context: BrowserContext; hydrationChunk: string | RegExp },
    use: (context: BrowserContext) => Promise<void>,
    testInfo: TestInfo,
  ): Promise<void> => {
    if (delayMs === 0) return use(context)
    const delay = await delayHydration(context, { delayMs, chunk: hydrationChunk })
    await use(context)
    if (testInfo.status === testInfo.expectedStatus) delay.assertDelayed()
  }
}

/**
 * The `test` every e2e imports. With `E2E_HYDRATION_DELAY_MS` set, every page of the
 * test's context gets `hydrationChunk` that many milliseconds late; set it with
 * `use: { hydrationChunk }` in the config or `test.use` in a file.
 */
export const test = base.extend<HydrationFixtures>({
  hydrationChunk: [REACT_DOM_CLIENT_CHUNK, { option: true }],
  context: hydrationDelayFixture(HYDRATION_DELAY_MS),
})

export interface FetchMetadataRun {
  /** Default: `HYDRATION_DELAY_MS`. */
  delayMs?: number
  /** Default: `test.info()`. */
  testInfo?: TestInfo
}

/**
 * Asserts the `Sec-Fetch-*` headers the browser put on a request. A delayed-hydration
 * run intercepts requests with `context.route`, and Playwright then reports them without
 * those headers: there the assertion cannot be read, so it is recorded on the test as an
 * `unchecked` annotation and the rest of the test runs.
 */
export function expectFetchMetadata(
  headers: Record<string, string>,
  expected: Record<string, string>,
  { delayMs = HYDRATION_DELAY_MS, testInfo }: FetchMetadataRun = {},
): void {
  if (delayMs > 0) {
    ;(testInfo ?? test.info()).annotations.push({
      type: 'unchecked',
      description: `Sec-Fetch-* under E2E_HYDRATION_DELAY_MS: ${JSON.stringify(expected)}`,
    })
    return
  }
  expect(headers).toMatchObject(expected)
}
