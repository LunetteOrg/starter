import { describe, expect, it } from 'vitest'
import { testDbAction } from './docker.ts'

describe('what the globalSetup does about the test database', () => {
  it('uses a server it is given and starts nothing', () => {
    const env = { TEST_DATABASE_URL: 'postgresql://x@h/db' }
    expect(testDbAction({ env, docker: false })).toBe('external')
    expect(testDbAction({ env: { ...env, CI: 'true' }, docker: true })).toBe('external')
  })

  it('starts one Postgres when Docker answers', () => {
    expect(testDbAction({ env: {}, docker: true })).toBe('start')
  })

  it('skips the database locally without Docker, so unit tests still run', () => {
    expect(testDbAction({ env: {}, docker: false })).toBe('skip')
  })

  it('fails in CI without Docker: a skipped integration tier there is a false green', () => {
    expect(() => testDbAction({ env: { CI: 'true' }, docker: false })).toThrow(/Docker/)
  })
})
