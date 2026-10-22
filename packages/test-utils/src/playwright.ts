// What every e2e of a Lunette app imports in place of `@playwright/test`'s `test`, and the
// helpers for a control that exists only in JavaScript. The reasons are in the
// starter's docs/adr/e2e-helpers.md.

import {
  type BrowserContext,
  test as base,
  expect,
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type Request,
  type Response,
  type TestInfo,
} from '@playwright/test'

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
 * `repeatUntil` sets no timeout of its own: the gesture and the effect each take
 * `ATTEMPT`, so a lost gesture is repeated within a second instead of waiting out the
 * test's timeout.
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
 * A page that can hydrate: the HTML a top-level navigation lands on. An iframe, a hop
 * of a redirect, and a navigation to text, JSON or a download are not pages here.
 */
function isPage(response: Response): boolean {
  const request = response.request()
  if (request.resourceType() !== 'document' || !request.isNavigationRequest()) return false
  if (response.status() >= 300 && response.status() < 400) return false
  if (!/^text\/html\b/i.test(response.headers()['content-type'] ?? '')) return false
  try {
    return request.frame().parentFrame() === null
  } catch {
    // A service worker's request has no frame.
    return false
  }
}

/** The contexts `delayHydration` routed: Playwright reports their requests without `Sec-Fetch-*`. */
const delayedContexts = new WeakSet<BrowserContext>()

/**
 * Holds back the chunk for `delayMs` on every page of `context`, so the server HTML stays
 * without handlers for that long. The `test` of this module does it to the test's own
 * context; a test that opens one with `browser.newContext()` calls it on that one.
 */
export async function delayHydration(
  context: BrowserContext,
  { delayMs, chunk }: HydrationDelayOptions,
): Promise<HydrationDelay> {
  let pages = 0
  let delayed = 0
  context.on('response', (response) => {
    if (isPage(response)) pages++
  })
  await context.route(chunk, async (route) => {
    delayed++
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    // fallback, not continue: a route the test installs on the same URL still runs.
    await route.fallback()
  })
  delayedContexts.add(context)
  return {
    assertDelayed() {
      if (pages > 0 && delayed === 0) {
        throw new Error(
          `E2E_HYDRATION_DELAY_MS is set but none of the ${pages} pages loaded a chunk matching ${String(chunk)}: ` +
            'the chunk was renamed or the pages never hydrate. Set hydrationChunk to the chunk the app loads, ' +
            `or to null in a test whose pages never hydrate (${E2E_HELPERS_RECORD})`,
        )
      }
    },
  }
}

export interface HydrationFixtures {
  /**
   * The chunk `E2E_HYDRATION_DELAY_MS` holds back. Default: `REACT_DOM_CLIENT_CHUNK`.
   * `null` in a test whose pages never hydrate: nothing is delayed and nothing checked.
   */
  hydrationChunk: string | RegExp | null
}

/**
 * The `context` fixture of `test`: with a delay, every page of the test's context gets
 * the chunk that late, and a test that passed as expected, loaded pages and delayed none
 * fails, so a run that proved nothing is not green. A test that failed, or that is
 * expected to fail, keeps its own outcome.
 */
export function hydrationDelayFixture(delayMs: number) {
  return async (
    { context, hydrationChunk }: { context: BrowserContext; hydrationChunk: string | RegExp | null },
    use: (context: BrowserContext) => Promise<void>,
    testInfo: TestInfo,
  ): Promise<void> => {
    if (delayMs === 0 || hydrationChunk === null) return use(context)
    const delay = await delayHydration(context, { delayMs, chunk: hydrationChunk })
    await use(context)
    if (testInfo.status === 'passed' && testInfo.expectedStatus === 'passed') delay.assertDelayed()
  }
}

/** What `test` adds to Playwright's `test`: exported so a spec can check the wiring. */
export const hydrationFixtures: Fixtures<
  HydrationFixtures,
  object,
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
  hydrationChunk: [REACT_DOM_CLIENT_CHUNK, { option: true }],
  context: hydrationDelayFixture(HYDRATION_DELAY_MS),
}

/**
 * The `test` every e2e imports. With `E2E_HYDRATION_DELAY_MS` set, every page of the
 * test's context gets `hydrationChunk` that many milliseconds late; set it with
 * `use: { hydrationChunk }` in the config or `test.use` in a file.
 */
export const test = base.extend<HydrationFixtures>(hydrationFixtures)

export interface FetchMetadataOptions {
  /** Default: `test.info()`. */
  testInfo?: TestInfo
}

/**
 * Asserts the `Sec-Fetch-*` headers the browser put on `request`, read with
 * `request.allHeaders()`: `request.headers()` never holds them. Once `delayHydration`
 * has routed a context, Playwright reports every request of that context without those
 * headers: there the assertion cannot be read, so it is recorded on the test as an
 * `unchecked` annotation and the rest of the test runs. A request of any other context
 * is asserted, in a delayed run too.
 *
 * ```ts
 * await expectFetchMetadata(request, { 'sec-fetch-site': 'same-origin' })
 * ```
 */
export async function expectFetchMetadata(
  request: Request,
  expected: Record<string, string>,
  { testInfo }: FetchMetadataOptions = {},
): Promise<void> {
  if (routedByDelay(request)) {
    ;(testInfo ?? test.info()).annotations.push({
      type: 'unchecked',
      description: `Sec-Fetch-* under E2E_HYDRATION_DELAY_MS: ${JSON.stringify(expected)}`,
    })
    return
  }
  expect(await request.allHeaders()).toMatchObject(expected)
}

function routedByDelay(request: Request): boolean {
  try {
    return delayedContexts.has(request.frame().page().context())
  } catch {
    // A service worker's request has no frame, so no context to read: it is asserted.
    return false
  }
}
