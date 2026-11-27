import { assert, describe, it } from '@effect/vitest'
import * as jsonc from 'jsonc-parser'
import { beforeEach } from 'vitest'
import { INSTALL_HOOK, MARKETPLACE, PLUGIN, settingsEntries, syncedSettings } from './claude-settings.ts'
import { ConfigError } from './files.ts'

// .claude/settings.json as the project holds it: null when there is none.
let file: string | null = null
const read = () => JSON.parse(file as string)
const write = (value: unknown) => {
  file = `${JSON.stringify(value, null, 2)}\n`
}
// What lntt sync writes, when it writes.
const sync = () => {
  file = syncedSettings(file) ?? file
}

// The Stop entry `lntt sync` wrote up to 0.6.4, told by its status message.
const OLD_TYPECHECK = {
  type: 'command',
  command: 'node_modules/.bin/lntt hook typecheck',
  asyncRewake: true,
  rewakeSummary: 'Typecheck failed',
  timeout: 900,
  statusMessage: 'lntt: typecheck',
}

const off = () => settingsEntries(file).filter((c) => c.state !== 'ok')

describe('the Claude Code settings lntt sync writes', () => {
  beforeEach(() => {
    file = null
  })

  it('a project with no settings gets the directory marketplace, the plugin and the install hook', () => {
    sync()
    const s = read()
    assert.deepStrictEqual(s.extraKnownMarketplaces.lunette, {
      source: { source: 'directory', path: './node_modules/@lntt/lntt' },
    })
    assert.strictEqual(s.enabledPlugins[PLUGIN], true)
    assert.strictEqual(s.hooks.SessionStart.length, 1)
    assert.strictEqual(s.hooks.SessionStart[0].hooks[0].command, INSTALL_HOOK.command)
    assert.deepStrictEqual(off(), [])
  })

  it('keeps whatever else the file holds, its comments and its formatting', () => {
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
    file = text
    sync()
    const after = file
    assert.match(after, /\/\/ the project’s own/)
    assert.match(after, /"permissions": \{ "deny": \["Bash\(rm:\*\)"\] \}/)
    assert.strictEqual(off().length, 0)
  })

  it('the project’s own hooks of the same event stay beside the install hook', () => {
    write({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ours' }] }] } })
    sync()
    const commands = read().hooks.SessionStart.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    )
    assert.deepStrictEqual(commands, ['echo ours', INSTALL_HOOK.command])
  })

  it('replaces the GitHub marketplace of the same name and an install hook an older lntt wrote', () => {
    write({
      extraKnownMarketplaces: { lunette: { source: { source: 'github', repo: 'LunetteOrg/starter' } } },
      enabledPlugins: { [PLUGIN]: false },
      hooks: { SessionStart: [{ hooks: [{ ...INSTALL_HOOK, command: 'an older line' }] }] },
    })
    assert.deepStrictEqual(
      off().map((c) => `${c.state} ${c.key}`),
      ['elsewhere extraKnownMarketplaces.lunette', 'off enabledPlugins.lunette@lunette', 'edited hooks.SessionStart'],
    )
    sync()
    assert.deepStrictEqual(read().extraKnownMarketplaces.lunette, MARKETPLACE)
    assert.strictEqual(read().hooks.SessionStart.length, 1)
    assert.deepStrictEqual(off(), [])
  })

  it('a second sync changes nothing', () => {
    sync()
    const first = file
    sync()
    assert.strictEqual(file, first)
  })

  it('two copies of the install hook are an edit; sync leaves one', () => {
    write({ hooks: { SessionStart: [{ hooks: [INSTALL_HOOK] }, { hooks: [INSTALL_HOOK] }] } })
    assert.deepStrictEqual(
      off().map((c) => `${c.state} ${c.key}`),
      ['missing extraKnownMarketplaces.lunette', 'missing enabledPlugins.lunette@lunette', 'edited hooks.SessionStart'],
    )
    sync()
    assert.strictEqual(read().hooks.SessionStart.length, 1)
    assert.deepStrictEqual(off(), [])
  })

  it('the install hook replaces an older one in SessionStart, and the project’s own entries and their comments stay', () => {
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
    file = text
    sync()
    const after = file
    assert.match(after, /\/\/ ours, before the install\n/)
    assert.deepStrictEqual(
      jsonc.parse(after).hooks.SessionStart.map((e: { hooks: { command: string }[] }) => e.hooks[0]?.command),
      ['echo ours', INSTALL_HOOK.command],
    )
    assert.notMatch(after, /an older line/)
    assert.deepStrictEqual(off(), [])
  })

  for (const [what, value] of [
    ['enabledPlugins a string', { enabledPlugins: 'x' }],
    ['extraKnownMarketplaces an array', { extraKnownMarketplaces: [] }],
    ['hooks.SessionStart an object', { hooks: { SessionStart: {} } }],
    ['a null entry in SessionStart', { hooks: { SessionStart: [null] } }],
    ['a null hook in an entry', { hooks: { SessionStart: [{ hooks: [null] }] } }],
  ]) {
    it(`${what}: the file is invalid for the check, and sync refuses it without a stack trace`, () => {
      write(value)
      assert.deepStrictEqual(off(), [{ key: '.claude/settings.json', state: 'invalid' }])
      const before = file
      assert.throws(() => sync(), ConfigError, /not the shape Claude Code reads/)
      assert.strictEqual(file, before)
    })
  }

  it('an install hook among the project’s own hooks of one entry is replaced, and theirs stay', () => {
    const own = { type: 'command', command: 'echo ours' }
    write({ hooks: { SessionStart: [{ hooks: [own, { ...INSTALL_HOOK, command: 'an older line' }] }] } })
    sync()
    assert.deepStrictEqual(read().hooks.SessionStart, [{ hooks: [own] }, { hooks: [INSTALL_HOOK] }])
  })

  it('entries holding only install hooks go, and the new one lands after the project’s', () => {
    const own = { hooks: [{ type: 'command', command: 'echo ours' }] }
    const old = { hooks: [{ ...INSTALL_HOOK, command: 'an older line' }] }
    write({ hooks: { SessionStart: [old, own, old] } })
    sync()
    assert.deepStrictEqual(read().hooks.SessionStart, [own, { hooks: [INSTALL_HOOK] }])
  })

  it('a byte order mark at the start is read past, and sync writes the file without it', () => {
    write({ permissions: { deny: [] } })
    file = `\uFEFF${file}`
    assert.strictEqual(off().length, 3)
    sync()
    assert.deepStrictEqual(read().permissions, { deny: [] })
    assert.deepStrictEqual(off(), [])
  })

  it('the install hook with its keys in another order is the same hook', () => {
    const reordered = Object.fromEntries(Object.entries(INSTALL_HOOK).reverse())
    write({ hooks: { SessionStart: [{ hooks: [reordered] }] } })
    assert.strictEqual(settingsEntries(file).find((e) => e.key === 'hooks.SessionStart')?.state, 'ok')
  })

  it('the install hook has a timeout of its own, long enough for a cold install', () => {
    assert.strictEqual(INSTALL_HOOK.timeout, 600)
  })

  it('the check names what is missing, with no settings file at all', () => {
    assert.deepStrictEqual(
      off().map((c) => `${c.state} ${c.key}`),
      [
        'missing extraKnownMarketplaces.lunette',
        'missing enabledPlugins.lunette@lunette',
        'missing hooks.SessionStart',
      ],
    )
  })

  it('no Stop hook is written, and the project’s own hooks are left as they are', () => {
    const own = { type: 'command', command: 'echo ours' }
    write({ hooks: { Stop: [{ hooks: [own] }], PostToolUse: [{ matcher: 'Bash', hooks: [own] }] } })
    sync()
    const s = read()
    assert.deepStrictEqual(s.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [own] }])
    assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [own] }])
    assert.deepStrictEqual(off(), [])
  })

  it('a project with no Stop hook gets none', () => {
    sync()
    assert.strictEqual(read().hooks.Stop, undefined)
  })

  it('the typecheck hook an earlier lntt wrote is removed, with its entry and an event left empty', () => {
    write({ hooks: { Stop: [{ hooks: [OLD_TYPECHECK] }] } })
    sync()
    assert.strictEqual(read().hooks.Stop, undefined)
    assert.deepStrictEqual(off(), [])
  })

  it('only its own hook goes: the project’s, in the same entry or beside it, stays', () => {
    const own = { type: 'command', command: 'echo ours' }
    write({ hooks: { Stop: [{ hooks: [own, OLD_TYPECHECK] }, { hooks: [OLD_TYPECHECK] }, { hooks: [own] }] } })
    sync()
    assert.deepStrictEqual(read().hooks.Stop, [{ hooks: [own] }, { hooks: [own] }])
  })

  it('an entry with no hooks stays, beside the one removed', () => {
    write({ hooks: { Stop: [{ matcher: 'x' }, { hooks: [OLD_TYPECHECK] }] } })
    sync()
    assert.deepStrictEqual(read().hooks.Stop, [{ matcher: 'x' }])
  })

  it('two entries that are both its own leave no Stop at all', () => {
    write({ hooks: { Stop: [{ hooks: [OLD_TYPECHECK] }, { hooks: [OLD_TYPECHECK] }] } })
    sync()
    assert.strictEqual(read().hooks.Stop, undefined)
  })

  it('a Stop with entries that are not the shape Claude Code reads is the whole file invalid, and sync refuses it', () => {
    for (const bad of [null, 'x', { hooks: 'x' }, { hooks: [null] }]) {
      write({ hooks: { Stop: [bad, { hooks: [OLD_TYPECHECK] }] } })
      assert.deepStrictEqual(
        off().map((c) => `${c.state} ${c.key}`),
        ['invalid .claude/settings.json'],
        JSON.stringify(bad),
      )
      assert.throws(() => sync(), /not JSON, or not the shape Claude Code reads/)
    }
  })

  it('only lntt: typecheck is removed: another lntt message, and an empty Stop of the project’s, stay', () => {
    write({ hooks: { Stop: [{ hooks: [{ ...INSTALL_HOOK, statusMessage: 'lntt: other' }, OLD_TYPECHECK] }] } })
    sync()
    assert.deepStrictEqual(read().hooks.Stop, [{ hooks: [{ ...INSTALL_HOOK, statusMessage: 'lntt: other' }] }])
    write({ hooks: { Stop: [] } })
    sync()
    assert.deepStrictEqual(read().hooks.Stop, [])
  })

  it('the hook of 0.6.4 left in place before the next sync is no problem for the check', () => {
    sync()
    const s = read()
    write({ ...s, hooks: { ...s.hooks, Stop: [{ hooks: [OLD_TYPECHECK] }] } })
    assert.deepStrictEqual(off(), [])
  })

  it('a second sync after the removal changes nothing', () => {
    write({ hooks: { Stop: [{ hooks: [OLD_TYPECHECK] }] } })
    sync()
    const first = file
    sync()
    assert.strictEqual(file, first)
  })

  it('a PostToolUse of the project’s own, even empty, is left as it is', () => {
    write({ hooks: { PostToolUse: [] } })
    sync()
    assert.deepStrictEqual(read().hooks.PostToolUse, [])
  })

  it('a Stop that is not a list is not the shape Claude Code reads', () => {
    write({ hooks: { Stop: {} } })
    assert.deepStrictEqual(
      off().map((c) => `${c.state} ${c.key}`),
      ['invalid .claude/settings.json'],
    )
  })

  it('a second sync writes nothing, and a project with no file gets one', () => {
    assert.isString(syncedSettings(null))
    const once = syncedSettings(null) as string
    assert.strictEqual(syncedSettings(once), null)
  })
})
