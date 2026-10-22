import type { BrowserContext, Route, TestInfo } from '@playwright/test'
import { describe, expect, it, vi } from 'vitest'
import {
  delayHydration,
  expectFetchMetadata,
  hydrationDelayFixture,
  parseHydrationDelay,
  REACT_DOM_CLIENT_CHUNK,
  repeatUntil,
} from './playwright.ts'

/**
 * A browser context with nothing behind it: `load` plays what a page load does to the
 * listeners and the routes the fixture installs, a document request and then a script
 * request for each URL.
 */
function fakeContext() {
  const listeners: ((request: { resourceType(): string }) => void)[] = []
  const routes: { pattern: RegExp | string; handler: (route: Route) => Promise<void> }[] = []
  const fallbacks: string[] = []
  const context = {
    on(event: string, listener: (request: { resourceType(): string }) => void) {
      if (event === 'request') listeners.push(listener)
    },
    async route(pattern: RegExp | string, handler: (route: Route) => Promise<void>) {
      routes.push({ pattern, handler })
    },
  }
  async function load(...scripts: string[]) {
    for (const listener of listeners) listener({ resourceType: () => 'document' })
    for (const url of scripts) {
      for (const listener of listeners) listener({ resourceType: () => 'script' })
      for (const { pattern, handler } of routes) {
        const matches = typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        if (!matches) continue
        await handler({ fallback: async () => void fallbacks.push(url) } as unknown as Route)
      }
    }
  }
  return { context: context as unknown as BrowserContext, routes, fallbacks, load }
}

const DEV_CHUNK = 'http://localhost:20001/node_modules/.vite/deps/react-dom_client.js?v=1a2b3c'
const info = (status: TestInfo['status'] = 'passed') =>
  ({ status, expectedStatus: 'passed', annotations: [] }) as unknown as TestInfo

describe('parseHydrationDelay', () => {
  it('is 0 when unset or empty', () => {
    expect(parseHydrationDelay(undefined)).toBe(0)
    expect(parseHydrationDelay('')).toBe(0)
  })

  it('reads whole milliseconds', () => {
    expect(parseHydrationDelay('3000')).toBe(3000)
  })

  it.each(['3s', '-1', '1.5', 'abc'])('rejects %j', (value) => {
    expect(() => parseHydrationDelay(value)).toThrow(/E2E_HYDRATION_DELAY_MS/)
  })
})

describe('REACT_DOM_CLIENT_CHUNK', () => {
  it("matches the chunk Vite's dep optimizer serves React DOM's client from", () => {
    expect(REACT_DOM_CLIENT_CHUNK.test(DEV_CHUNK)).toBe(true)
    expect(REACT_DOM_CLIENT_CHUNK.test('http://localhost:20001/node_modules/.vite/deps/react-dom.js')).toBe(false)
  })
})

describe('delayHydration', () => {
  it('holds the chunk for the delay, then hands it on to the next route', async () => {
    const { context, fallbacks, load } = fakeContext()
    await delayHydration(context, { delayMs: 30, chunk: REACT_DOM_CLIENT_CHUNK })
    const started = performance.now()
    await load(DEV_CHUNK)
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
    expect(fallbacks).toEqual([DEV_CHUNK])
  })

  it('passes when the pages loaded the chunk', async () => {
    const { context, load } = fakeContext()
    const delay = await delayHydration(context, { delayMs: 1, chunk: REACT_DOM_CLIENT_CHUNK })
    await load(DEV_CHUNK)
    expect(() => delay.assertDelayed()).not.toThrow()
  })

  it('passes when no page was loaded', async () => {
    const { context } = fakeContext()
    const delay = await delayHydration(context, { delayMs: 1, chunk: REACT_DOM_CLIENT_CHUNK })
    expect(() => delay.assertDelayed()).not.toThrow()
  })

  it('fails when pages were loaded and none got the delay', async () => {
    const { context, load } = fakeContext()
    const delay = await delayHydration(context, { delayMs: 1, chunk: REACT_DOM_CLIENT_CHUNK })
    await load('http://localhost:20001/assets/entry.client-Bx1.js')
    await load('http://localhost:20001/assets/entry.client-Bx1.js')
    expect(() => delay.assertDelayed()).toThrow(/none of the 2 pages loaded .*react-dom_client.*hydrationChunk/s)
  })
})

describe('hydrationDelayFixture', () => {
  it('hands the context over untouched when no delay is set', async () => {
    const { context, routes } = fakeContext()
    const use = vi.fn(async () => {})
    await hydrationDelayFixture(0)({ context, hydrationChunk: REACT_DOM_CLIENT_CHUNK }, use, info())
    expect(use).toHaveBeenCalledWith(context)
    expect(routes).toEqual([])
  })

  it('fails a passing test whose pages got no delay', async () => {
    const { context, load } = fakeContext()
    const fixture = hydrationDelayFixture(1)
    await expect(
      fixture({ context, hydrationChunk: /react-dom_client\.js/ }, () => load('http://x/app.js'), info()),
    ).rejects.toThrow(/E2E_HYDRATION_DELAY_MS is set but none of the 1 pages/)
  })

  it('delays the chunk the project names', async () => {
    const { context, fallbacks, load } = fakeContext()
    const chunk = /\/assets\/entry\.client-\w+\.js/
    await hydrationDelayFixture(1)(
      { context, hydrationChunk: chunk },
      () => load('http://x/assets/entry.client-Bx1.js'),
      info(),
    )
    expect(fallbacks).toEqual(['http://x/assets/entry.client-Bx1.js'])
  })

  it('leaves a test that already failed with its own error', async () => {
    const { context, load } = fakeContext()
    await expect(
      hydrationDelayFixture(1)(
        { context, hydrationChunk: REACT_DOM_CLIENT_CHUNK },
        () => load('http://x/a.js'),
        info('failed'),
      ),
    ).resolves.toBeUndefined()
  })
})

describe('expectFetchMetadata', () => {
  const headers = { 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'document' }

  it('asserts the headers in a normal run', () => {
    const testInfo = info()
    expect(() =>
      expectFetchMetadata(headers, { 'sec-fetch-site': 'same-site' }, { delayMs: 0, testInfo }),
    ).not.toThrow()
    expect(() => expectFetchMetadata(headers, { 'sec-fetch-site': 'cross-site' }, { delayMs: 0, testInfo })).toThrow()
    expect(testInfo.annotations).toEqual([])
  })

  it('records the assertion as unchecked under a hydration delay, where the headers are stripped', () => {
    const testInfo = info()
    expectFetchMetadata({}, { 'sec-fetch-site': 'cross-site' }, { delayMs: 3000, testInfo })
    expect(testInfo.annotations).toEqual([
      { type: 'unchecked', description: 'Sec-Fetch-* under E2E_HYDRATION_DELAY_MS: {"sec-fetch-site":"cross-site"}' },
    ])
  })
})

describe('repeatUntil', () => {
  it('repeats the gesture until the effect shows', async () => {
    let clicks = 0
    await repeatUntil(
      async () => {
        clicks++
      },
      async () => {
        if (clicks < 3) throw new Error('menu not open yet')
      },
    )
    expect(clicks).toBe(3)
  })
})
