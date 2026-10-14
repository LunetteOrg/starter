import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/index.ts')

function scaffold(name: string, template: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-create-'))
  // gc.auto=0: the initial commit is large enough to start a background `git gc`,
  // which would still be writing .git/objects/pack when the test removes the dir.
  // An identity, because CI has none and the CLI skips the commit without one.
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'gc.auto',
    GIT_CONFIG_VALUE_0: '0',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.org',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.org',
  }
  execFileSync('node', [BIN, name, '--template', template], { cwd: dir, stdio: 'ignore', env })
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
    const adrs = readdirSync(join(app, 'docs/adr')).filter((f) => !['README.md', 'template.md'].includes(f))
    assert.ok(adrs.length >= 6, `has the thematic ADRs (${adrs.length})`)
    assert.deepEqual(
      adrs.filter((f) => /^\d/.test(f)),
      [],
      'ADR files are named after their subject, not numbered or dated',
    )
    assert.ok(existsSync(join(app, '.gitignore')), '.gitignore present')
    assert.equal(JSON.parse(readFileSync(join(app, 'packages/ui/package.json'), 'utf8')).name, '@my-app/ui')
    assert.deepEqual(filesContaining(app, '@starter'), [], 'no @starter residue')
    assert.deepEqual(filesContaining(app, '__LNTT_'), [], 'no provenance placeholder residue')
  } finally {
    rmSync(dirname(app), { recursive: true, force: true })
  }
})

test('unknown template is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-create-'))
  assert.throws(() => execFileSync('node', [BIN, 'x', '--template', 'nope'], { cwd: dir, stdio: 'ignore' }))
  rmSync(dir, { recursive: true, force: true })
})

test('a scaffolded project records the template and the CLI version it came from', () => {
  const app = scaffold('my-app', 'react-router')
  try {
    const version = JSON.parse(readFileSync(resolve(dirname(BIN), '../package.json'), 'utf8')).version
    const config = readFileSync(join(app, '.agents/config.jsonc'), 'utf8')
    const lunette = JSON.parse(config.replace(/^\s*\/\/.*$/gm, '')).lunette
    assert.deepEqual(lunette, { template: 'react-router', version })
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: app, encoding: 'utf8' }).trim()
    assert.equal(subject, `chore: scaffold my-app from @lntt/create ${version} (template react-router)`)
  } finally {
    rmSync(dirname(app), { recursive: true, force: true })
  }
})

// The CLI rewrites only `@starter`. Packages published from this repo (`@lntt/*`) are
// consumed by version and keep their names in every generated project
// (docs/adr/scaffolding-contract.md). A fixture template beside a copy of the bin
// asserts it independently of what today's templates happen to reference.
test('the @lntt scope survives scaffolding; @starter is rewritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'lntt-create-'))
  try {
    mkdirSync(join(root, 'bin'))
    cpSync(BIN, join(root, 'bin/index.ts'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.0.0-test' }))
    const fixture = join(root, 'templates/fixture')
    mkdirSync(fixture, { recursive: true })
    const manifest = {
      name: 'starter',
      devDependencies: { '@starter/ui': 'workspace:*', '@lntt/biome-config': '^1.0.0', '@lntt/test-utils': '^1.0.0' },
    }
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(fixture, 'biome.json'), JSON.stringify({ extends: ['@lntt/biome-config/biome'] }))
    writeFileSync(
      join(fixture, 'vitest.config.ts'),
      "import { testDbPlugin } from '@lntt/test-utils/plugin'\nimport { ui } from '@starter/ui'\n",
    )
    execFileSync('node', [join(root, 'bin/index.ts'), 'demo', '--template', 'fixture'], { cwd: root, stdio: 'ignore' })

    const app = join(root, 'demo')
    assert.deepEqual(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).devDependencies, {
      '@demo/ui': 'workspace:*',
      '@lntt/biome-config': '^1.0.0',
      '@lntt/test-utils': '^1.0.0',
    })
    assert.deepEqual(JSON.parse(readFileSync(join(app, 'biome.json'), 'utf8')).extends, ['@lntt/biome-config/biome'])
    assert.equal(
      readFileSync(join(app, 'vitest.config.ts'), 'utf8'),
      "import { testDbPlugin } from '@lntt/test-utils/plugin'\nimport { ui } from '@demo/ui'\n",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the react-router template keeps naming @lntt/create after scaffolding', () => {
  const app = scaffold('my-app', 'react-router')
  try {
    assert.match(readFileSync(join(app, 'README.md'), 'utf8'), /@lntt\/create/)
    assert.deepEqual(filesContaining(app, '@my-app/create'), [], 'no @lntt rewritten to the project scope')
  } finally {
    rmSync(dirname(app), { recursive: true, force: true })
  }
})
