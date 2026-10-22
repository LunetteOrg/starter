import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './global-setup.ts'

/**
 * The globalSetup given a server from outside (`TEST_DATABASE_URL` already set) starts
 * nothing and asks no Docker, so it runs here without one. It must leave Ryuk as the
 * user's shell set it: a value it wrote would reach every testcontainers process the
 * run starts after it.
 */
const RYUK = 'TESTCONTAINERS_RYUK_DISABLED'
const GIVEN = 'postgres://given:given@db.invalid:5432/given'

describe('setup() with TEST_DATABASE_URL set from outside', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = { [RYUK]: process.env[RYUK], TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }
    process.env.TEST_DATABASE_URL = GIVEN
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('leaves an unset TESTCONTAINERS_RYUK_DISABLED unset, and the given URL as it is', async () => {
    delete process.env[RYUK]
    await setup()
    expect(process.env).not.toHaveProperty(RYUK)
    expect(process.env.TEST_DATABASE_URL).toBe(GIVEN)
    await teardown()
    expect(process.env.TEST_DATABASE_URL).toBe(GIVEN)
  })

  it("leaves the shell's TESTCONTAINERS_RYUK_DISABLED as the shell set it", async () => {
    process.env[RYUK] = 'false'
    await setup()
    expect(process.env[RYUK]).toBe('false')
    await teardown()
  })
})
