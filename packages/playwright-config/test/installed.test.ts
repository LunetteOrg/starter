import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLAYWRIGHT = dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json'))

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-playwright-')))
after(() => rmSync(dir, { recursive: true, force: true }))

// Node refuses to strip types under node_modules, so the package must ship
// JavaScript: pack it as it is published, install it, import it by name.
test('the packed package is importable by name from node_modules', () => {
  const tarball = execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: PKG_DIR, encoding: 'utf8' })
    .trim()
    .split('\n')
    .at(-1) as string
  const target = join(dir, 'node_modules/@lntt/playwright-config')
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-xzf', resolve(dir, tarball), '-C', target, '--strip-components=1'])
  mkdirSync(join(dir, 'node_modules/@playwright'))
  symlinkSync(PLAYWRIGHT, join(dir, 'node_modules/@playwright/test'), 'dir')
  writeFileSync(
    join(dir, 'probe.mjs'),
    "import { definePlaywrightConfig } from '@lntt/playwright-config'\n" +
      'console.log(definePlaywrightConfig({ port: 4321 }).use.baseURL)\n',
  )
  assert.equal(execFileSync('node', ['probe.mjs'], { cwd: dir, encoding: 'utf8' }).trim(), 'http://localhost:4321')
})
