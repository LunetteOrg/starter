import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/index.mjs')

function scaffold(name, template) {
  const dir = mkdtempSync(join(tmpdir(), 'create-spike-'))
  execFileSync('node', [BIN, name, '--template', template], { cwd: dir, stdio: 'ignore' })
  return join(dir, name)
}

test('default template: renames placeholders and restores dotfiles', () => {
  const app = scaffold('my-app', 'default')
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'my-app', 'package name is renamed')
  assert.ok(pkg.dependencies['@my-app/ui'], '@starter scope rewritten to @my-app')
  assert.ok(!JSON.stringify(pkg).includes('@starter'), 'no @starter residue')
  assert.ok(existsSync(join(app, '.gitignore')), '_gitignore restored to .gitignore')
  assert.ok(!existsSync(join(app, '_gitignore')), 'no _gitignore leftover')
  assert.ok(existsSync(join(app, 'src/index.ts')), 'default ships src/')
  rmSync(dirname(app), { recursive: true, force: true })
})

test('minimal template: a variant is just another folder', () => {
  const app = scaffold('tiny', 'minimal')
  assert.equal(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).name, 'tiny')
  assert.ok(existsSync(join(app, '.gitignore')), 'dotfile restored')
  assert.ok(!existsSync(join(app, 'src')), 'minimal has no src/')
  rmSync(dirname(app), { recursive: true, force: true })
})

test('unknown template is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-spike-'))
  assert.throws(() =>
    execFileSync('node', [BIN, 'x', '--template', 'nope'], { cwd: dir, stdio: 'ignore' }),
  )
  rmSync(dir, { recursive: true, force: true })
})
