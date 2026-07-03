import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'lntt-pack-'))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

// Pack the package exactly as `npm publish` would, then scaffold from the packed
// files. This catches packing regressions (npm mangling dotfiles, `files` missing
// something) that the source-based scaffold test cannot see.
test('the packed tarball scaffolds a clean project', () => {
  const packDir = mktmp()
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
    cwd: PKG_DIR,
    encoding: 'utf8',
  }).trim()
  const extract = mktmp()
  execFileSync('tar', ['-xzf', join(packDir, tarball), '-C', extract])
  const bin = join(extract, 'package/bin/index.ts')
  assert.ok(existsSync(bin), 'tarball ships bin/index.ts')

  const out = mktmp()
  execFileSync('node', [bin, 'packed-app', '--template', 'react-router'], { cwd: out, stdio: 'ignore' })
  const app = join(out, 'packed-app')

  assert.ok(existsSync(join(app, '.gitignore')), '_gitignore restored to .gitignore')
  assert.ok(existsSync(join(app, '.npmrc')), '_npmrc restored to .npmrc')
  assert.ok(!existsSync(join(app, '.lunette-template')), 'marker stripped')
  assert.ok(existsSync(join(app, 'packages')), 'full monorepo shipped')
  assert.equal(readdirSync(app).filter((f) => f === '_gitignore' || f === '_npmrc').length, 0, 'no `_` residue')
  const residue = execFileSync('bash', ['-c', `grep -rl '@starter' ${app} || true`], { encoding: 'utf8' }).trim()
  assert.equal(residue, '', 'no @starter residue in the packed scaffold')
})
