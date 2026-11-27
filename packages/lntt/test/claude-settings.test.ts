import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { INSTALL_HOOK, PLUGIN } from '../src/index.ts'

// The main path of the settings through the CLI, and the install hook run as the shell line it is;
// what sync writes and the check reads: src/claude-settings.spec.ts, src/check/areas.spec.ts.

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

let root: string
const settings = () => join(root, '.claude/settings.json')
const read = () => JSON.parse(readFileSync(settings(), 'utf8'))

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-claude-settings-')))
  mkdirSync(join(root, '.agents'))
  writeFileSync(join(root, '.agents/config.jsonc'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the Claude Code settings lntt sync writes', () => {
  test('lntt sync writes them, and lntt check plugin passes then', () => {
    const before = spawnSync(process.execPath, [BIN, 'check', 'plugin'], { cwd: root, encoding: 'utf8' })
    assert.equal(before.status, 1)
    assert.match(before.stdout, /FAIL\s+plugin\/settings\s+\.claude\/settings\.json .*run pnpm exec lntt sync/)
    assert.equal(spawnSync(process.execPath, [BIN, 'sync'], { cwd: root, encoding: 'utf8' }).status, 0)
    assert.equal(read().enabledPlugins[PLUGIN], true)
    assert.equal(read().hooks.SessionStart[0].hooks[0].command, INSTALL_HOOK.command)
    const after = spawnSync(process.execPath, [BIN, 'check', 'plugin'], { cwd: root, encoding: 'utf8' })
    assert.equal(after.status, 0, after.stdout)
  })
})

// The install hook runs before lntt can: a shell line, with no lntt and no jq.
describe('the install hook', () => {
  function run(files: Record<string, string>, path: string) {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
    return spawnSync('/bin/sh', ['-c', INSTALL_HOOK.command], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { PATH: path, CLAUDE_PROJECT_DIR: root },
    })
  }

  // A fake package manager on PATH that records its arguments, installs lntt or not, and
  // exits as told.
  function manager(name: string, status: number, installs = status === 0): string {
    const bin = join(root, 'fake-bin')
    mkdirSync(bin, { recursive: true })
    const install = installs
      ? 'mkdir -p node_modules/.bin && : > node_modules/.bin/lntt && chmod +x node_modules/.bin/lntt\n'
      : ''
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" > "${join(root, `${name}.args`)}"\n${install}exit ${status}\n`)
    chmodSync(join(bin, name), 0o755)
    return `${bin}:/usr/bin:/bin`
  }

  test('does nothing, and says nothing, when lntt is installed', () => {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules/.bin/lntt'), '#!/bin/sh\n')
    chmodSync(join(root, 'node_modules/.bin/lntt'), 0o755)
    const path = manager('pnpm', 0)
    const r = run({ 'pnpm-lock.yaml': '' }, path)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(existsSync(join(root, 'pnpm.args')), false)
  })

  test('installs with the lockfile’s manager, from the project directory, when lntt is missing', () => {
    const r = run({ 'pnpm-lock.yaml': '' }, manager('pnpm', 0))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(root, 'pnpm.args'), 'utf8').trim(), 'install --frozen-lockfile')
    assert.equal(JSON.parse(r.stdout).systemMessage.includes('installed'), true)
  })

  test('a failed install never fails the session: it says what to run, once', () => {
    const r = run({ 'pnpm-lock.yaml': '' }, manager('pnpm', 1))
    assert.equal(r.status, 0)
    assert.match(JSON.parse(r.stdout).systemMessage, /run pnpm install/)
  })

  test('an install that succeeds without installing lntt says what to run', () => {
    const r = run({ 'pnpm-lock.yaml': '' }, manager('pnpm', 0, false))
    assert.equal(r.status, 0)
    assert.match(JSON.parse(r.stdout).systemMessage, /run pnpm install/)
  })

  test('with no package manager on PATH it says what to run, and exits 0', () => {
    const r = run({ 'pnpm-lock.yaml': '' }, '/usr/bin:/bin')
    assert.equal(r.status, 0)
    assert.match(JSON.parse(r.stdout).systemMessage, /run pnpm install/)
  })

  test('a project with an npm lockfile installs with npm ci', () => {
    const r = run({ 'package-lock.json': '{}' }, manager('npm', 0))
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(root, 'npm.args'), 'utf8').trim(), 'ci')
  })
})
