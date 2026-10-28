import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'packages-version.mts')

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A repo with the given packages under packages/, each `[name, version, private?]`. */
function repo(packages: [string, string, boolean?][]): string {
  root = mkdtempSync(join(tmpdir(), 'lntt-versions-'))
  for (const [name, version, isPrivate] of packages) {
    const dir = join(root, 'packages', name.replace('@lntt/', ''))
    mkdirSync(dir, { recursive: true })
    const manifest = { name, version, ...(isPrivate ? { private: true } : {}), type: 'module' }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return root
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const version = (pkg: string) => JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')).version

test('list names the published packages, the CLI last, never a private one', () => {
  repo([
    ['@lntt/create', '1.0.0'],
    ['@lntt/test-utils', '1.0.0'],
    ['@lntt/biome-config', '1.0.0'],
    ['@lntt/internal', '0.0.0', true],
  ])
  const r = run('list')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(r.out.trim().split('\n'), ['packages/biome-config', 'packages/test-utils', 'packages/create'])
})

test('check passes when every published package has one version, and the tag matches it', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/biome-config', '1.2.0'],
    ['@lntt/internal', '0.0.0', true],
  ])
  assert.equal(run('check').status, 0)
  assert.equal(run('check', '1.2.0').status, 0)
})

test('check fails naming the packages off the shared version', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/biome-config', '1.1.0'],
  ])
  const r = run('check')
  assert.equal(r.status, 1)
  assert.match(r.out, /@lntt\/biome-config 1\.1\.0/)
})

test('check fails when the release tag is not the packages’ version', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/biome-config', '1.2.0'],
  ])
  const r = run('check', '1.3.0')
  assert.equal(r.status, 1)
  assert.match(r.out, /1\.3\.0/)
})

test('set writes one version into every published package and leaves private ones alone', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/biome-config', '1.1.0'],
    ['@lntt/internal', '0.0.0', true],
  ])
  const r = run('set', '1.3.0-rc.0')
  assert.equal(r.status, 0, r.out)
  assert.deepEqual(
    [version('create'), version('biome-config'), version('internal')],
    ['1.3.0-rc.0', '1.3.0-rc.0', '0.0.0'],
  )
  assert.equal(run('check', '1.3.0-rc.0').status, 0)
})

test('set refuses something that is not a version', () => {
  repo([['@lntt/create', '1.2.0']])
  assert.equal(run('set', 'v1.3.0').status, 1)
  assert.equal(version('create'), '1.2.0')
})

// A package's Claude Code plugin (packages/<pkg>/plugin/.claude-plugin/plugin.json) is
// shown at its version: it is the package's.
function plugin(pkg: string, version: string): void {
  const dir = join(root, 'packages', pkg, 'plugin', '.claude-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ name: 'lunette', version }, null, 2)}\n`)
}
const pluginVersion = (pkg: string) =>
  JSON.parse(readFileSync(join(root, 'packages', pkg, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version

test('check fails when a package’s plugin is not at the package’s version', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/lntt', '1.2.0'],
  ])
  plugin('lntt', '0.12.1')
  const r = run('check')
  assert.equal(r.status, 1)
  assert.match(r.out, /packages\/lntt\/plugin\/\.claude-plugin\/plugin\.json 0\.12\.1/)
})

test('set writes the version into each package’s plugin too', () => {
  repo([
    ['@lntt/create', '1.2.0'],
    ['@lntt/lntt', '1.2.0'],
  ])
  plugin('lntt', '0.12.1')
  assert.equal(run('set', '1.3.0').status, 0)
  assert.equal(pluginVersion('lntt'), '1.3.0')
  assert.equal(run('check').status, 0)
})
