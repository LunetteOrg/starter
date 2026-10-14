import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { definePlaywrightConfig } from '../src/index.ts'

const savedCI = process.env.CI
afterEach(() => {
  if (savedCI === undefined) delete process.env.CI
  else process.env.CI = savedCI
})

test('the app port becomes the base URL, and the tests live in __tests__/*.e2e.ts', () => {
  const config = definePlaywrightConfig({ port: 3100 })
  assert.equal(config.use?.baseURL, 'http://localhost:3100')
  assert.equal(config.testDir, './__tests__')
  assert.equal(config.testMatch, '**/*.e2e.ts')
})

test('there is no webServer: the globalSetup starts the app after its containers', () => {
  const config = definePlaywrightConfig({ port: 3000, globalSetup: './gs.ts', globalTeardown: './gt.ts' })
  assert.equal(config.webServer, undefined)
  assert.equal(config.globalSetup, './gs.ts')
  assert.equal(config.globalTeardown, './gt.ts')
})

test('one worker, no retries, and a clean storage state', () => {
  const config = definePlaywrightConfig({ port: 3000 })
  assert.equal(config.workers, 1)
  assert.equal(config.fullyParallel, false)
  assert.equal(config.retries, 0)
  assert.deepEqual(config.use?.storageState, { cookies: [], origins: [] })
})

test('test.only fails the run in CI and not locally', () => {
  delete process.env.CI
  assert.equal(definePlaywrightConfig({ port: 3000 }).forbidOnly, false)
  process.env.CI = 'true'
  assert.equal(definePlaywrightConfig({ port: 3000 }).forbidOnly, true)
})

test('a warmup file becomes a project chromium depends on', () => {
  const without = definePlaywrightConfig({ port: 3000 })
  assert.deepEqual(
    without.projects?.map((p) => p.name),
    ['chromium'],
  )

  const config = definePlaywrightConfig({ port: 3000, warmupSetup: '**/warmup.ts' })
  assert.deepEqual(
    config.projects?.map((p) => [p.name, p.dependencies ?? []]),
    [
      ['warmup', []],
      ['chromium', ['warmup']],
    ],
  )
})

test('locale and extra headers reach the browser context only when given', () => {
  const bare = definePlaywrightConfig({ port: 3000 })
  assert.equal(bare.use?.locale, undefined)
  const config = definePlaywrightConfig({ port: 3000, locale: 'it-IT', extraHTTPHeaders: { 'x-lang': 'it' } })
  assert.equal(config.use?.locale, 'it-IT')
  assert.deepEqual(config.use?.extraHTTPHeaders, { 'x-lang': 'it' })
})
