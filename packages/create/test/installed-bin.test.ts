import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'lntt-installed-'))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

// The bin runs from INSIDE node_modules once installed — exactly what `npm create`
// / `npx` does. Node refuses to strip TypeScript types under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a raw `.ts` bin that works when
// run from the repo is dead on arrival as a dependency. pack.test.ts runs the bin
// from a plain temp dir and so cannot see this; this test packs, extracts into a
// real node_modules/@lntt/create, and runs the published `bin` entry from there.
test('the published bin runs from inside node_modules', () => {
  const packDir = mktmp()
  const tarball = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
    cwd: PKG_DIR,
    encoding: 'utf8',
  }).trim()

  const home = mktmp()
  const pkgRoot = join(home, 'node_modules', '@lntt', 'create')
  mkdirSync(pkgRoot, { recursive: true })
  // tar strips the leading `package/` dir so the tarball lands directly in pkgRoot.
  execFileSync('tar', ['-xzf', join(packDir, tarball), '-C', pkgRoot, '--strip-components=1'])

  const binRel = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).bin['create-lntt']
  const bin = join(pkgRoot, binRel)
  assert.ok(existsSync(bin), `bin entry ${binRel} exists in the package`)

  const out = mktmp()
  execFileSync('node', [bin, 'installed-app', '--template', 'react-router'], { cwd: out, stdio: 'ignore' })
  assert.ok(existsSync(join(out, 'installed-app', 'package.json')), 'scaffolded a project')
})
