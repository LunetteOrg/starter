import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/index.ts')

function scaffold(name: string, template: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-create-'))
  execFileSync('node', [BIN, name, '--template', template], { cwd: dir, stdio: 'ignore' })
  return join(dir, name)
}

// Files under `dir` containing `needle`. `grep -rl` exits 1 (no throw here) when
// nothing matches, which we treat as "clean".
function filesContaining(dir: string, needle: string): string[] {
  try {
    return execFileSync('grep', ['-rl', needle, dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch (e) {
    if ((e as { status?: number }).status === 1) return []
    throw e
  }
}

test('default template scaffolds a complete, renamed starter', () => {
  const app = scaffold('my-app', 'react-router')
  try {
    assert.ok(existsSync(join(app, 'packages')), 'has packages/')
    assert.ok(existsSync(join(app, 'apps')), 'has apps/')
    const adrs = readdirSync(join(app, 'docs/adr')).filter((f) => /^\d{4}-.*\.md$/.test(f))
    assert.ok(adrs.length >= 6, `has the consolidated ADRs (${adrs.length})`)
    assert.ok(!existsSync(join(app, '.lunette-template')), '.lunette-template stripped')
    assert.ok(existsSync(join(app, '.gitignore')), '.gitignore present')
    assert.equal(JSON.parse(readFileSync(join(app, 'packages/ui/package.json'), 'utf8')).name, '@my-app/ui')
    assert.deepEqual(filesContaining(app, '@starter'), [], 'no @starter residue')
  } finally {
    rmSync(dirname(app), { recursive: true, force: true })
  }
})

test('unknown template is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-create-'))
  assert.throws(() => execFileSync('node', [BIN, 'x', '--template', 'nope'], { cwd: dir, stdio: 'ignore' }))
  rmSync(dir, { recursive: true, force: true })
})
