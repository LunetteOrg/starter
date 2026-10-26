import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/index.ts'

// One configuration per released version of @lntt/lntt, written with every field that
// version knew. The schema only grows ([the compatibility rule](../../../docs/adr/lntt-command.md)):
// a newer lntt must read each of them.
const RELEASED = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/released')
const versions = readdirSync(RELEASED)
  .filter((file) => file.endsWith('.jsonc'))
  .map((file) => file.slice(0, -'.jsonc'.length))

describe('the configuration of each released version', () => {
  test('there is a fixture for every supported version', () => {
    assert.ok(versions.length > 0)
  })

  for (const version of versions) {
    test(`${version} validates against the current schema`, () => {
      const root = mkdtempSync(join(tmpdir(), 'lntt-released-'))
      try {
        mkdirSync(join(root, '.agents'))
        copyFileSync(join(RELEASED, `${version}.jsonc`), join(root, '.agents/config.jsonc'))
        assert.doesNotThrow(() => loadConfig(root))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
