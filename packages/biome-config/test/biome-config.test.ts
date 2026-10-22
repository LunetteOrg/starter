import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIOME = join(
  dirname(createRequire(import.meta.url).resolve('@biomejs/biome/package.json')),
  'bin/biome',
)
const PLUGINS = './node_modules/@lntt/biome-config'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// A project that installed the package: its biome.json extends the shared config by
// package name and mounts the GritQL plugins from node_modules, as a consumer does.
function project(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-biome-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@lntt'), { recursive: true })
  symlinkSync(PKG_DIR, join(dir, 'node_modules/@lntt/biome-config'), 'dir')
  const config = {
    extends: ['@lntt/biome-config/biome'],
    vcs: { enabled: false },
    overrides: [
      { includes: ['src/app/**'], plugins: [`${PLUGINS}/no-throw-new-error.grit`] },
      { includes: ['src/routes/**'], plugins: [`${PLUGINS}/no-entity-spread-in-loader.grit`] },
      {
        includes: ['src/e2e/**'],
        plugins: [
          `${PLUGINS}/no-implicit-e2e-sync.grit`,
          `${PLUGINS}/no-react-internals.grit`,
          `${PLUGINS}/e2e-test-from-helper.grit`,
        ],
      },
    ],
  }
  writeFileSync(join(dir, 'biome.json'), JSON.stringify(config))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'src', path)), { recursive: true })
    writeFileSync(join(dir, 'src', path), content)
  }
  return dir
}

function check(dir: string): { ok: boolean; output: string } {
  const r = spawnSync('node', [BIOME, 'check', '--colors=off', '--max-diagnostics=1000', 'src'], {
    cwd: dir,
    encoding: 'utf8',
  })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

test('code in the shared style passes', () => {
  const r = check(project({ 'app/ok.ts': "export const greeting = 'hi'\n" }))
  assert.ok(r.ok, r.output)
})

test('the formatter wants single quotes and no semicolons', () => {
  const r = check(project({ 'app/style.ts': 'export const greeting = "hi";\n' }))
  assert.equal(r.ok, false)
  assert.match(r.output, /format/i)
})

test('no-throw-new-error flags a thrown Error and leaves framework signals alone', () => {
  const thrown = check(
    project({ 'app/fail.ts': "export function f() {\n  throw new Error('x')\n}\n" }),
  )
  assert.equal(thrown.ok, false)
  assert.match(thrown.output, /errore/)

  const redirect = 'declare function redirect(to: string): Response\n'
  const signal = check(
    project({ 'app/signal.ts': `${redirect}export function f() {\n  throw redirect('/')\n}\n` }),
  )
  assert.ok(signal.ok, signal.output)
})

test('no-entity-spread-in-loader flags an object spread in a return, not an array spread', () => {
  const entity = check(
    project({
      'routes/leak.ts': 'export function loader(user: object) {\n  return { ...user }\n}\n',
    }),
  )
  assert.equal(entity.ok, false)
  assert.match(entity.output, /over-serializes/)

  const array = check(
    project({ 'routes/list.ts': 'export function loader(xs: number[]) {\n  return [...xs]\n}\n' }),
  )
  assert.ok(array.ok, array.output)
})

test('no-implicit-e2e-sync flags waitForTimeout', () => {
  const src =
    'export async function t(page: { waitForTimeout(ms: number): Promise<void> }) {\n  await page.waitForTimeout(100)\n}\n'
  const r = check(project({ 'e2e/wait.e2e.ts': src }))
  assert.equal(r.ok, false)
  assert.match(r.output, /waitForTimeout/)
})

test('no-react-internals flags a React internal key', () => {
  const r = check(project({ 'e2e/internals.e2e.ts': "export const key = '__reactProps$'\n" }))
  assert.equal(r.ok, false)
  assert.match(r.output, /React internals/)
})

test('e2e-test-from-helper flags `test` taken from @playwright/test in every import and re-export form', () => {
  const forms = {
    'named.e2e.ts': "import { test } from '@playwright/test'\n",
    'renamed.e2e.ts': "import { expect, test as base } from '@playwright/test'\n",
    'multiline.e2e.ts': "import {\n  expect,\n  test,\n} from '@playwright/test'\n",
    'default.e2e.ts': "import playwright from '@playwright/test'\n",
    'default-renamed.e2e.ts': "import { default as base } from '@playwright/test'\n",
    'combined.e2e.ts': "import base, { expect } from '@playwright/test'\n",
    'combined-namespace.e2e.ts': "import base, * as playwright from '@playwright/test'\n",
    'namespace.e2e.ts': "import * as playwright from '@playwright/test'\n",
    'fixtures-named.ts': "export { expect, test } from '@playwright/test'\n",
    'fixtures-renamed.ts': "export { test as base } from '@playwright/test'\n",
    'fixtures-default.ts': "export { default } from '@playwright/test'\n",
    'fixtures-star.ts': "export * from '@playwright/test'\n",
    'fixtures-namespace.ts': "export * as playwright from '@playwright/test'\n",
    'dynamic.e2e.ts': "export const { test } = await import('@playwright/test')\n",
    'require.e2e.ts': "export const { test } = require('@playwright/test')\n",
    'import-equals.e2e.ts':
      "import playwright = require('@playwright/test')\n\nexport const { test } = playwright\n",
  }
  const r = check(
    project(Object.fromEntries(Object.entries(forms).map(([f, src]) => [`e2e/${f}`, src]))),
  )
  assert.equal(r.ok, false)
  assert.match(r.output, /@lntt\/test-utils\/playwright/)
  for (const file of Object.keys(forms))
    assert.match(r.output, new RegExp(`e2e/${file}:1:\\d+ plugin`))
})

test('e2e-test-from-helper leaves `test` from the helper, and expect, devices and types from @playwright/test', () => {
  const src = [
    "import { test } from '@lntt/test-utils/playwright'",
    "import type { TestInfo } from '@playwright/test'",
    "import { expect as check, devices, expect, type Page } from '@playwright/test'",
    '',
    'export const use = [test, devices, expect, check] as const',
    'export type Used = [Page, TestInfo]',
    '',
  ].join('\n')
  const r = check(
    project({
      'e2e/ok.e2e.ts': src,
      'e2e/names.e2e.ts':
        "import { contest, latest, testing } from '@playwright/test'\n\nexport const names = [contest, latest, testing]\n",
      'e2e/dynamic.e2e.ts': [
        "import { readFileSync } from 'node:fs'",
        "import { createRequire } from 'node:module'",
        '',
        "export const helper = await import('@lntt/test-utils/playwright')",
        "export const path = createRequire(import.meta.url).resolve('@lntt/test-utils/playwright')",
        "export const text = readFileSync(path, 'utf8')",
        '',
      ].join('\n'),
      'e2e/fixtures.ts': [
        "export { test } from '@lntt/test-utils/playwright'",
        "export type { Page, TestInfo } from '@playwright/test'",
        "export { devices, expect } from '@playwright/test'",
        '',
      ].join('\n'),
    }),
  )
  assert.ok(r.ok, r.output)
})
