import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ryukDisabledPlugin, testDbPlugin } from './plugin.ts'

/**
 * The test database rests on three facts. Two look redundant next to each other and
 * are not: `config()` runs in the MAIN vitest process (the one that runs the
 * globalSetup and starts the container), while `test.env` reaches the WORKER
 * processes. Drop either and a container starts somewhere with the reaper alive,
 * which kills the run's Postgres between two test files.
 */
const RYUK = 'TESTCONTAINERS_RYUK_DISABLED'

type Config = { test?: { env?: Record<string, string>; globalSetup?: string[] } }

function callConfig(plugin: ReturnType<typeof testDbPlugin>): Config {
  const config = plugin.config
  if (typeof config !== 'function') expect.unreachable('the plugin must define config()')
  return (config as () => Config)()
}

describe('testDbPlugin', () => {
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env[RYUK]
    delete process.env[RYUK]
  })

  afterEach(() => {
    if (previous === undefined) delete process.env[RYUK]
    else process.env[RYUK] = previous
  })

  it('disables Ryuk in the main process, as a side effect of config()', () => {
    callConfig(testDbPlugin())
    expect(process.env[RYUK]).toBe('true')
  })

  it('disables Ryuk in the worker processes, through test.env', () => {
    expect(callConfig(testDbPlugin()).test?.env?.[RYUK]).toBe('true')
  })

  it('registers exactly one globalSetup, the one that owns the container', () => {
    const globalSetup = callConfig(testDbPlugin()).test?.globalSetup
    expect(globalSetup).toHaveLength(1)
    expect(globalSetup?.[0]).toMatch(/global-setup\.(ts|js)$/)
  })

  it('ryukDisabledPlugin does the Ryuk half and nothing else', () => {
    const result = callConfig(ryukDisabledPlugin())
    expect(process.env[RYUK]).toBe('true')
    expect(result.test?.env?.[RYUK]).toBe('true')
    expect(result.test?.globalSetup).toBeUndefined()
  })
})
