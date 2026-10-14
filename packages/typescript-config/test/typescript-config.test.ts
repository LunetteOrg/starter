import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc')

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// A project that installed the package: it reaches the configs through
// node_modules/@lntt/typescript-config, by the package name, as a consumer does.
function project(tsconfig: object, files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-tsconfig-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@lntt'), { recursive: true })
  symlinkSync(PKG_DIR, join(dir, 'node_modules/@lntt/typescript-config'), 'dir')
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ ...tsconfig, include: ['src'] }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'src', path)), { recursive: true })
    writeFileSync(join(dir, 'src', path), content)
  }
  return dir
}

function typecheck(dir: string): { ok: boolean; output: string } {
  const r = spawnSync('node', [TSC, '-p', dir, '--noEmit'], { encoding: 'utf8' })
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` }
}

const base = { extends: '@lntt/typescript-config/base.json' }
const browser = { extends: '@lntt/typescript-config/browser.json' }

test('base.json compiles clean code', () => {
  const r = typecheck(project(base, { 'a.ts': 'export const n: number = [1, 2].length\n' }))
  assert.ok(r.ok, r.output)
})

test('base.json types an indexed access as possibly undefined', () => {
  const r = typecheck(project(base, { 'a.ts': 'const xs: number[] = []\nexport const n: number = xs[0]\n' }))
  assert.equal(r.ok, false)
  assert.match(r.output, /TS2322/)
})

test('base.json keeps an optional property apart from an explicit undefined', () => {
  const src = 'type T = { a?: string }\nexport const t: T = { a: undefined }\n'
  const r = typecheck(project(base, { 'a.ts': src }))
  assert.equal(r.ok, false)
  assert.match(r.output, /TS2375/)
})

test('browser.json accepts explicit .ts specifiers and the DOM', () => {
  const r = typecheck(
    project(browser, {
      'x.ts': 'export const x = 1\n',
      'a.ts': "import { x } from './x.ts'\nexport const title: string = document.title + x\n",
    }),
  )
  assert.ok(r.ok, r.output)
})

test('base.json refuses explicit .ts specifiers, which only a non-emitting package may use', () => {
  const r = typecheck(project(base, { 'x.ts': 'export const x = 1\n', 'a.ts': "export { x } from './x.ts'\n" }))
  assert.equal(r.ok, false)
  assert.match(r.output, /TS5097/)
})
