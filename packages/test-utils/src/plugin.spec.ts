import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testDbPlugin } from './plugin.ts'

/**
 * The plugin registers the globalSetup and leaves Ryuk, the testcontainers reaper, to
 * the user. Ryuk is what removes a run's Postgres when the run is killed outright: the
 * globalSetup starts the container in the MAIN vitest process, which holds Ryuk's
 * connection for the whole run, and Ryuk removes the container about 10 s after that
 * process is gone. Disabling it, in `config()` (the main process) or in `test.env` (the
 * workers), would bring back a Postgres that outlives every `SIGKILL`ed run. A user
 * whose machine cannot run Ryuk sets `TESTCONTAINERS_RYUK_DISABLED` in their own
 * shell, and the plugin must leave that value as it finds it.
 */
const RYUK = 'TESTCONTAINERS_RYUK_DISABLED'

type Config = { test?: { env?: Record<string, string>; globalSetup?: string[] } }

function callConfig(plugin: ReturnType<typeof testDbPlugin>): Config {
  const config = plugin.config
  if (typeof config !== 'function') expect.unreachable('the plugin must define config()')
  return (config as () => Config)() ?? {}
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

  it('leaves Ryuk on in the main process: config() writes no TESTCONTAINERS_RYUK_DISABLED', () => {
    const before = { ...process.env }
    callConfig(testDbPlugin())
    expect(process.env[RYUK]).toBeUndefined()
    expect(process.env).toEqual(before)
  })

  it('leaves Ryuk on in the workers: no TESTCONTAINERS_RYUK_DISABLED in test.env', () => {
    expect(callConfig(testDbPlugin()).test?.env?.[RYUK]).toBeUndefined()
  })

  it('leaves a value set in the shell untouched, the escape hatch for a machine without Ryuk', () => {
    process.env[RYUK] = 'true'
    callConfig(testDbPlugin())
    expect(process.env[RYUK]).toBe('true')
  })

  it('registers exactly one globalSetup, the one that owns the container', () => {
    const globalSetup = callConfig(testDbPlugin()).test?.globalSetup
    expect(globalSetup).toHaveLength(1)
    expect(globalSetup?.[0]).toMatch(/global-setup\.(ts|js)$/)
  })
})
