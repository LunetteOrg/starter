import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/index.ts'

// One configuration per released version of @lntt/lntt, written with every field that
// version knew. The schema only grows (the compatibility rule in docs/adr/lntt-command.md):
// a newer lntt must read each of them. A release adds its fixture (docs/process/delivery.md).
const HERE = dirname(fileURLToPath(import.meta.url))
const RELEASED = resolve(HERE, 'fixtures/released')
// A dry run of a release (X.Y.Z-rc.N) carries the fixture of the release it rehearses.
const current = (
  JSON.parse(readFileSync(resolve(HERE, '../package.json'), 'utf8')) as { version: string }
).version.split('-')[0]

const versions = readdirSync(RELEASED)
  .filter((file) => file.endsWith('.jsonc'))
  .map((file) => file.slice(0, -'.jsonc'.length))

describe('the configuration of each released version', () => {
  test('the version in package.json has its fixture', () => {
    assert.ok(versions.includes(current), `add packages/lntt/test/fixtures/released/${current}.jsonc`)
  })

  for (const version of versions) {
    test(`${version} validates against the current schema`, () => {
      const root = mkdtempSync(join(tmpdir(), 'lntt-released-'))
      try {
        mkdirSync(join(root, '.agents'))
        copyFileSync(join(RELEASED, `${version}.jsonc`), join(root, '.agents/config.jsonc'))
        const { data } = loadConfig(root)
        assert.equal((data.lunette as { version: string }).version, version)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
