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
import * as jsonc from 'jsonc-parser'
import { checkClaudeSettings, INSTALL_HOOK, MARKETPLACE, PLUGIN, syncClaudeSettings } from '../src/index.ts'

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

function write(value: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(settings(), `${JSON.stringify(value, null, 2)}\n`)
}

const off = () => checkClaudeSettings(root).filter((c) => c.state !== 'ok')

describe('the Claude Code settings lntt sync writes', () => {
  test('a project with no settings gets the directory marketplace, the plugin and the install hook', () => {
    syncClaudeSettings(root)
    const s = read()
    assert.deepEqual(s.extraKnownMarketplaces.lunette, {
      source: { source: 'directory', path: './node_modules/@lntt/lntt' },
    })
    assert.equal(s.enabledPlugins[PLUGIN], true)
    assert.equal(s.hooks.SessionStart.length, 1)
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, INSTALL_HOOK.command)
    assert.deepEqual(off(), [])
  })

  test('keeps whatever else the file holds, its comments and its formatting', () => {
    mkdirSync(join(root, '.claude'))
    const own = { type: 'command', command: 'echo ours' }
    const text = [
      '{',
      '  // the project’s own',
      '  "permissions": { "deny": ["Bash(rm:*)"] },',
      `  "hooks": { "SessionStart": [{ "hooks": [${JSON.stringify(own)}] }], "Stop": [] },`,
      '  "enabledPlugins": { "x@y": false },',
      '  "extraKnownMarketplaces": { "other": { "source": { "source": "github", "repo": "o/r" } } }',
      '}',
      '',
    ].join('\n')
    writeFileSync(settings(), text)
    syncClaudeSettings(root)
    const after = readFileSync(settings(), 'utf8')
    assert.match(after, /\/\/ the project’s own/)
    assert.match(after, /"permissions": \{ "deny": \["Bash\(rm:\*\)"\] \}/)
    assert.equal(off().length, 0)
  })

  test('the project’s own hooks of the same event stay beside the install hook', () => {
    write({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ours' }] }] } })
    syncClaudeSettings(root)
    const commands = read().hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    )
    assert.deepEqual(commands, ['echo ours', INSTALL_HOOK.command])
  })

  test('replaces the GitHub marketplace of the same name and an install hook an older lntt wrote', () => {
    write({
      extraKnownMarketplaces: { lunette: { source: { source: 'github', repo: 'LunetteOrg/starter' } } },
      enabledPlugins: { [PLUGIN]: false },
      hooks: { SessionStart: [{ hooks: [{ ...INSTALL_HOOK, command: 'an older line' }] }] },
    })
    assert.deepEqual(
      off().map((c) => `${c.state} ${c.key}`),
      ['elsewhere extraKnownMarketplaces.lunette', 'off enabledPlugins.lunette@lunette', 'edited hooks.SessionStart'],
    )
    syncClaudeSettings(root)
    assert.deepEqual(read().extraKnownMarketplaces.lunette, MARKETPLACE)
    assert.equal(read().hooks.SessionStart.length, 1)
    assert.deepEqual(off(), [])
  })

  test('a second sync changes nothing', () => {
    syncClaudeSettings(root)
    const first = readFileSync(settings(), 'utf8')
    syncClaudeSettings(root)
    assert.equal(readFileSync(settings(), 'utf8'), first)
  })

  test('two copies of the install hook are an edit; sync leaves one', () => {
    write({ hooks: { SessionStart: [{ hooks: [INSTALL_HOOK] }, { hooks: [INSTALL_HOOK] }] } })
    assert.deepEqual(
      off().map((c) => `${c.state} ${c.key}`),
      ['missing extraKnownMarketplaces.lunette', 'missing enabledPlugins.lunette@lunette', 'edited hooks.SessionStart'],
    )
    syncClaudeSettings(root)
    assert.equal(read().hooks.SessionStart.length, 1)
    assert.deepEqual(off(), [])
  })

  test('the install hook replaces an older one in SessionStart, and the project’s own entries and their comments stay', () => {
    mkdirSync(join(root, '.claude'))
    const text = [
      '{',
      '  "hooks": {',
      '    "SessionStart": [',
      '      // ours, before the install',
      '      { "hooks": [{ "type": "command", "command": "echo ours" }] },',
      `      { "hooks": [${JSON.stringify({ ...INSTALL_HOOK, command: 'an older line' })}] }`,
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n')
    writeFileSync(settings(), text)
    syncClaudeSettings(root)
    const after = readFileSync(settings(), 'utf8')
    assert.match(after, /\/\/ ours, before the install\n/)
    assert.deepEqual(
      jsonc.parse(after).hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0]?.command),
      ['echo ours', INSTALL_HOOK.command],
    )
    assert.doesNotMatch(after, /an older line/)
    assert.deepEqual(off(), [])
  })

  for (const [what, value] of [
    ['enabledPlugins a string', { enabledPlugins: 'x' }],
    ['extraKnownMarketplaces an array', { extraKnownMarketplaces: [] }],
    ['hooks.SessionStart an object', { hooks: { SessionStart: {} } }],
    ['a null entry in SessionStart', { hooks: { SessionStart: [null] } }],
    ['a null hook in an entry', { hooks: { SessionStart: [{ hooks: [null] }] } }],
  ]) {
    test(`${what}: the file is invalid for the check, and sync refuses it without a stack trace`, () => {
      write(value)
      assert.deepEqual(off(), [{ key: '.claude/settings.json', state: 'invalid' }])
      assert.throws(() => syncClaudeSettings(root), { name: 'ConfigError' })
    })
  }

  test('the install hook has a timeout of its own, long enough for a cold install', () => {
    assert.equal(INSTALL_HOOK.timeout, 600)
  })

  test('the check names what is missing, with no settings file at all', () => {
    assert.deepEqual(
      off().map((c) => `${c.state} ${c.key}`),
      [
        'missing extraKnownMarketplaces.lunette',
        'missing enabledPlugins.lunette@lunette',
        'missing hooks.SessionStart',
      ],
    )
  })

  for (const [state, value, says] of [
    [
      'elsewhere',
      { extraKnownMarketplaces: { lunette: { source: { source: 'github', repo: 'o/r' } } } },
      /extraKnownMarketplaces\.lunette points elsewhere than the marketplace @lntt\/lntt ships; run lntt sync/,
    ],
    ['off', { enabledPlugins: { [PLUGIN]: false } }, /enabledPlugins\.lunette@lunette is not enabled; run lntt sync/],
    [
      'edited',
      { hooks: { SessionStart: [{ hooks: [{ ...INSTALL_HOOK, command: 'x' }] }] } },
      /hooks\.SessionStart: the install hook differs from the one lntt sync writes; run lntt sync/,
    ],
    [
      'invalid',
      { enabledPlugins: 'x' },
      /\.claude\/settings\.json is not JSON, or not the shape Claude Code reads: fix it, then run lntt sync/,
    ],
  ] as const) {
    test(`lntt check plugin says what to do for ${state}`, () => {
      write(value)
      const r = spawnSync(process.execPath, [BIN, 'check', 'plugin'], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(r.stdout, says)
    })
  }

  test('lntt sync writes them, and lntt check plugin passes then', () => {
    const before = spawnSync(process.execPath, [BIN, 'check', 'plugin'], { cwd: root, encoding: 'utf8' })
    assert.equal(before.status, 1)
    assert.match(before.stdout, /FAIL\s+plugin\/settings\s+\.claude\/settings\.json .*run lntt sync/)
    assert.equal(spawnSync(process.execPath, [BIN, 'sync'], { cwd: root, encoding: 'utf8' }).status, 0)
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
