import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The package as a project installs it: packed, extracted into a real
// node_modules/@lntt/lntt, run from there. Node refuses to strip TypeScript types under
// node_modules, so what runs from source in this repo must ship compiled. The pack is
// `pnpm pack`, as in release.yml: only pnpm applies the publishConfig overrides that
// point `bin` and `exports` at dist/; `npm pack` would ship the source entries.
let tarball: string
let files: string[]
let project: string
let pkgRoot: string
let bin: string

before(() => {
  const packDir = mkdtempSync(join(tmpdir(), 'lntt-pack-'))
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: PKG_DIR, stdio: 'ignore' })
  tarball = join(packDir, `lntt-lntt-${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version}.tgz`)
  files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')

  project = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-installed-')))
  pkgRoot = join(project, 'node_modules', '@lntt', 'lntt')
  mkdirSync(pkgRoot, { recursive: true })
  // tar strips the leading `package/` dir so the tarball lands directly in pkgRoot.
  execFileSync('tar', ['-xzf', tarball, '-C', pkgRoot, '--strip-components=1'])
  // The run-time dependencies, from this package's own install: no network.
  symlinkSync(join(PKG_DIR, 'node_modules'), join(pkgRoot, 'node_modules'), 'dir')
  rmSync(packDir, { recursive: true, force: true })

  mkdirSync(join(project, '.agents'))
  writeFileSync(
    join(project, '.agents/config.jsonc'),
    '{\n  // a comment\n  "recording": { "language": "en", "logs": {} }\n}\n',
  )
  bin = join(pkgRoot, JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).bin.lntt)
})

after(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('the installed package', () => {
  test('ships JavaScript, with no TypeScript source besides declarations', () => {
    const sources = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    assert.deepEqual(sources, [])
    assert.ok(files.includes('package/schema/config.schema.json'), 'the schema a project points $schema at')
  })

  test('its bin points into dist and exists', () => {
    assert.match(bin, /\/dist\/bin\/lntt\.js$/)
    assert.ok(existsSync(bin))
  })

  test('lntt --help runs from inside node_modules', () => {
    assert.match(execFileSync('node', [bin, '--help'], { cwd: project, encoding: 'utf8' }), /^usage: lntt /)
  })

  test('lntt get reads the project configuration', () => {
    const out = execFileSync('node', [bin, 'get', 'recording.language'], { cwd: project, encoding: 'utf8' })
    assert.equal(JSON.parse(out), 'en')
  })

  test('lntt sync writes the managed block from the agents/ files the package ships', () => {
    execFileSync('node', [bin, 'sync'], { cwd: project })
    const agents = readFileSync(join(project, 'AGENTS.md'), 'utf8')
    const source = readFileSync(join(PKG_DIR, 'agents/block.md'), 'utf8').trimEnd()
    assert.ok(agents.includes(source), 'AGENTS.md holds agents/block.md')
  })

  test('a project imports the package and its schema by name', () => {
    const script = [
      "import { commitlintConfig } from '@lntt/lntt'",
      "import { createRequire } from 'node:module'",
      'const config = commitlintConfig(process.cwd())',
      "const schema = createRequire(import.meta.url)('@lntt/lntt/schema.json')",
      'console.log(JSON.stringify({ extends: config.extends, title: typeof schema.properties }))',
    ].join('\n')
    const out = execFileSync('node', ['--input-type=module', '-e', script], { cwd: project, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(out), { extends: ['@commitlint/config-conventional'], title: 'object' })
  })
})
