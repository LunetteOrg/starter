import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import stylelint from 'stylelint'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A project that installed the package: the config is extended by package name,
// resolved from the project's node_modules, as a consumer's .stylelintrc does.
let dir: string
before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-stylelint-')))
  mkdirSync(join(dir, 'node_modules/@lntt'), { recursive: true })
  symlinkSync(PKG_DIR, join(dir, 'node_modules/@lntt/stylelint-config'), 'dir')
})
after(() => rmSync(dir, { recursive: true, force: true }))

async function lint(code: string): Promise<string[]> {
  const { results } = await stylelint.lint({
    code,
    codeFilename: join(dir, 'a.module.css'),
    config: { extends: ['@lntt/stylelint-config'] },
    configBasedir: dir,
  })
  return (results[0]?.warnings ?? []).filter((w) => w.severity === 'error').map((w) => w.rule)
}

test('a camelCase CSS Modules class passes', async () => {
  assert.deepEqual(await lint('.primaryButton {\n  color: red;\n}\n'), [])
})

test('a kebab-case class is refused', async () => {
  assert.deepEqual(await lint('.primary-button {\n  color: red;\n}\n'), ['selector-class-pattern'])
})

test('CSS Modules syntax is understood', async () => {
  assert.deepEqual(await lint(':global(.dark) .card {\n  composes: base from "./base.module.css";\n}\n'), [])
})

test('media queries use the prefix notation, not the range one', async () => {
  assert.deepEqual(await lint('@media (width >= 600px) {\n  .card {\n    color: red;\n  }\n}\n'), [
    'media-feature-range-notation',
  ])
})
