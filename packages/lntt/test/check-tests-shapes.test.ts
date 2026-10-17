import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import jsonc from 'jsonc-parser'
import { levelsOf, testsConfig } from '../src/test-files.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const SHAPES = join(HERE, 'fixtures/tests/shapes')

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-shapes-')))
  mkdirSync(join(dir, '.agents'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// The levels of each project the starter was ported from, expressed in tests.levels:
// the shape must validate against the schema, and every typical test file must sit at
// exactly the level its record gives it.
const PROJECTS: Record<string, Record<string, string>> = {
  pelion: {
    'packages/test-utils/src/plugin.spec.ts': 'unit',
    'apps/community/app/lib/use-comment-pages.spec.ts': 'unit',
    'apps/community/app/root.spec.tsx': 'component',
    'packages/ui/src/utils/endsBelowViewport.test.tsx': 'component-browser',
    'packages/image-compress/src/compress.test.ts': 'component-browser',
    'apps/design-system/src/visual.test.tsx': 'screenshot',
    'apps/community/app/repos/posts.test.ts': 'integration',
    'apps/community/built-server/headers.test.ts': 'server',
    'apps/community/vite-deps.test.ts': 'server',
    'apps/community/e2e/language-switching.spec.ts': 'e2e',
  },
  wai: {
    'apps/admin/app/use-cases/grant.spec.ts': 'unit',
    'packages/ui/src/Dialog/Dialog.spec.tsx': 'component',
    'apps/admin/app/lib/db/repos/people.test.ts': 'integration',
    'apps/intranet/__tests__/session.e2e.ts': 'e2e',
  },
}

describe('tests.levels holds the shape of the projects it was ported from', () => {
  for (const [project, expected] of Object.entries(PROJECTS)) {
    test(`${project}: valid against the schema, each file at one level, the rules usable`, () => {
      const text = readFileSync(join(SHAPES, `${project}.jsonc`), 'utf8')
      writeFileSync(join(dir, '.agents/config.jsonc'), text)
      const valid = spawnSync(process.execPath, [BIN, 'validate'], { cwd: dir, encoding: 'utf8' })
      assert.equal(valid.status, 0, valid.stderr)
      const config = testsConfig(jsonc.parse(text))
      for (const [file, level] of Object.entries(expected)) {
        assert.deepEqual(
          levelsOf(config, file).map((l) => l.name),
          [level],
          file,
        )
      }
      for (const rule of config.rules) assert.doesNotThrow(() => new RegExp(rule.pattern), rule.name)
    })
  }

  test('the rule patterns match what their records forbid and let the rest through', () => {
    const pelion = testsConfig(jsonc.parse(readFileSync(join(SHAPES, 'pelion.jsonc'), 'utf8')))
    const wai = testsConfig(jsonc.parse(readFileSync(join(SHAPES, 'wai.jsonc'), 'utf8')))
    const hit = (config: typeof pelion, rule: string, line: string) =>
      new RegExp(config.rules.find((r) => r.name === rule)?.pattern as string).test(line)
    assert.ok(hit(pelion, 'module-mock', "vi.mock('./db')"))
    assert.ok(!hit(pelion, 'module-mock', "  const m = vi.fn() // not vi.mock('x')"))
    assert.ok(hit(pelion, 'bare-wait', 'await waitFor(() => x)'))
    assert.ok(hit(wai, 'no-db-mock', "vi.mock('../db/repo')"))
    assert.ok(!hit(wai, 'no-db-mock', "vi.mock('./clock')"))
    assert.ok(hit(wai, 'no-wait-for-timeout', 'await page.waitForTimeout(500)'))
  })
})
