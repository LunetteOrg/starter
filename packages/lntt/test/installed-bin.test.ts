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

const tmps: string[] = []
const mktmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tmps.push(d)
  return d
}

before(() => {
  const packDir = mktmp('lntt-pack-')
  // Piped, not ignored: a failing build shows its output in the thrown error.
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: PKG_DIR, stdio: 'pipe' })
  tarball = join(packDir, `lntt-lntt-${JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version}.tgz`)
  files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')

  project = mktmp('lntt-installed-')
  pkgRoot = join(project, 'node_modules', '@lntt', 'lntt')
  mkdirSync(pkgRoot, { recursive: true })
  // tar strips the leading `package/` dir so the tarball lands directly in pkgRoot.
  execFileSync('tar', ['-xzf', tarball, '-C', pkgRoot, '--strip-components=1'])
  // The run-time dependencies, from this package's own install: no network.
  symlinkSync(join(PKG_DIR, 'node_modules'), join(pkgRoot, 'node_modules'), 'dir')

  mkdirSync(join(project, '.agents'))
  writeFileSync(
    join(project, '.agents/config.jsonc'),
    '{\n  // a comment\n  "recording": { "language": "en", "logs": {} }\n}\n',
  )
  bin = join(pkgRoot, JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).bin.lntt)
})

after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

describe('the installed package', () => {
  test('ships JavaScript, with no TypeScript source besides declarations', () => {
    const sources = files.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    assert.deepEqual(sources, [])
    assert.ok(files.includes('package/schema/config.schema.json'), 'the schema a project points $schema at')
    assert.ok(files.includes('package/schema/operator.schema.json'), 'the operator schema')
    assert.ok(files.includes('package/dist/agents/block.md'), 'the agents/ files the code reads from dist/')
  })

  test('its bin points into dist and exists', () => {
    assert.match(bin, /\/dist\/bin\/lntt\.js$/)
    assert.ok(existsSync(bin))
  })

  test('every bin and exports target of the packed manifest is in the package', () => {
    const targets = (entry: unknown): string[] =>
      typeof entry === 'string' ? [entry] : Object.values(entry as object).flatMap(targets)
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    const all = [...targets(manifest.bin), ...targets(manifest.exports)]
    for (const entry of ['.', './ci']) {
      assert.match(manifest.exports[entry].types, /\.d\.ts$/, `${entry} has its types condition`)
    }
    for (const target of all) assert.ok(existsSync(join(pkgRoot, target)), `${target} is packed`)
  })

  test('the commitlint peer is optional: lntt alone needs nothing more', () => {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    assert.ok(manifest.peerDependencies['@commitlint/config-conventional'])
    assert.equal(manifest.peerDependenciesMeta['@commitlint/config-conventional'].optional, true)
  })

  for (const ask of ['--help', '-h', 'help']) {
    test(`lntt ${ask} runs from inside node_modules`, () => {
      assert.match(execFileSync('node', [bin, ask], { cwd: project, encoding: 'utf8' }), /^usage: lntt /)
    })
  }

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

  test('a project imports the package, its ci entry and its schemas by name', () => {
    const script = [
      "import { commitlintConfig } from '@lntt/lntt'",
      "import { localAction } from '@lntt/lntt/ci'",
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      'console.log(JSON.stringify({',
      '  extends: commitlintConfig(process.cwd()).extends,',
      '  ci: typeof localAction,',
      "  config: require('@lntt/lntt/schema.json').$id,",
      "  operator: require('@lntt/lntt/operator-schema.json').$id,",
      '}))',
    ].join('\n')
    const out = execFileSync('node', ['--input-type=module', '-e', script], { cwd: project, encoding: 'utf8' })
    const id = (name: string): string => JSON.parse(readFileSync(join(PKG_DIR, 'schema', name), 'utf8')).$id
    assert.deepEqual(JSON.parse(out), {
      extends: ['@commitlint/config-conventional'],
      ci: 'function',
      config: id('config.schema.json'),
      operator: id('operator.schema.json'),
    })
  })
})
