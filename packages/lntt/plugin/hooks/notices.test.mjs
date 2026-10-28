import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FORMAT_HOOK, INSTALL_HOOK, MARKETPLACE, PLUGIN, TYPECHECK_HOOK } from '../../src/claude-settings.ts'
import { notice, settingsProblems } from './notices.mjs'

// The terminal's dim sequence, stripped: what the person reads.
const plain = (text) => text.replaceAll(/\u001b\[\d+m/g, '')

// What lntt sync writes: the plugin's check must agree with it.
const SYNCED = {
  extraKnownMarketplaces: { lunette: MARKETPLACE },
  enabledPlugins: { [PLUGIN]: true },
  hooks: {
    SessionStart: [{ hooks: [INSTALL_HOOK] }],
    PostToolUse: [{ matcher: 'Write|Edit', hooks: [FORMAT_HOOK] }],
    Stop: [{ hooks: [TYPECHECK_HOOK] }],
  },
}

describe('what a notice says', () => {
  test('each one names what is missing and the command that fixes it', () => {
    assert.equal(
      plain(notice({ kind: 'lntt-missing' })),
      'lntt · issue titles off: lntt is not installed in this project. Run: pnpm install',
    )
    assert.equal(
      plain(notice({ kind: 'no-refs', found: '0.6.2' })),
      'lntt · issue titles off: lntt 0.6.2 has no `lntt refs`, which came with @lntt/lntt 0.6.3. Run: pnpm up @lntt/lntt',
    )
    assert.equal(
      plain(notice({ kind: 'no-refs', found: null })),
      'lntt · issue titles off: the lntt on PATH has no `lntt refs`, which came with @lntt/lntt 0.6.3. Run: pnpm install',
    )
    assert.equal(
      plain(notice({ kind: 'gh-missing' })),
      'lntt · issue titles off: gh is not installed. Install it (https://cli.github.com), then run: gh auth login',
    )
    assert.equal(plain(notice({ kind: 'gh-auth' })), 'lntt · issue titles off: gh is not logged in. Run: gh auth login')
    assert.equal(
      plain(notice({ kind: 'settings', keys: ['.claude/settings.json'] })),
      'lntt · .claude/settings.json is not JSON, or not the shape Claude Code reads: fix it, then run: pnpm exec lntt sync',
    )
    assert.equal(
      plain(notice({ kind: 'settings', keys: ['enabledPlugins.lunette@lunette'] })),
      'lntt · .claude/settings.json: enabledPlugins.lunette@lunette is not as lntt sync writes it. Run: pnpm exec lntt sync',
    )
  })

  test('a notice is dimmed, like the titles', () => {
    assert.match(notice({ kind: 'gh-auth' }), /^\u001b\[2m.*\u001b\[22m$/)
  })
})

describe('the settings the plugin checks at session start', () => {
  test('nothing to say when lntt sync wrote them', () => {
    assert.deepEqual(settingsProblems(JSON.stringify(SYNCED)), [])
  })

  test('names each entry missing or pointing elsewhere', () => {
    const elsewhere = {
      ...SYNCED,
      extraKnownMarketplaces: { lunette: { source: { source: 'github', repo: 'LunetteOrg/starter' } } },
      hooks: {},
    }
    assert.deepEqual(settingsProblems(JSON.stringify(elsewhere)), [
      'extraKnownMarketplaces.lunette',
      'hooks.SessionStart',
      'hooks.PostToolUse',
      'hooks.Stop',
    ])
    assert.deepEqual(settingsProblems('{}'), [
      'extraKnownMarketplaces.lunette',
      'enabledPlugins.lunette@lunette',
      'hooks.SessionStart',
      'hooks.PostToolUse',
      'hooks.Stop',
    ])
  })

  test('a marketplace with a directory source at another path, and a disabled plugin, are named', () => {
    const other = {
      ...SYNCED,
      extraKnownMarketplaces: { lunette: { source: { source: 'directory', path: './plugins/lunette' } } },
      enabledPlugins: { [PLUGIN]: false },
    }
    assert.deepEqual(settingsProblems(JSON.stringify(other)), ['extraKnownMarketplaces.lunette', 'enabledPlugins.lunette@lunette'])
  })

  test('a key of the wrong shape names the whole file, as lntt check plugin does', () => {
    for (const value of [
      { hooks: { SessionStart: {} } },
      { hooks: { SessionStart: 'x' } },
      { hooks: { SessionStart: [null] } },
      { hooks: { SessionStart: [{ hooks: 'x' }] } },
      { hooks: { SessionStart: [{ hooks: [null] }] } },
      { hooks: { Stop: {} } },
      { hooks: { PostToolUse: [{ hooks: 'x' }] } },
      { enabledPlugins: 'x' },
      { extraKnownMarketplaces: 'x' },
      { hooks: 'x' },
    ])
      assert.deepEqual(settingsProblems(JSON.stringify(value)), ['.claude/settings.json'])
  })

  test('a byte order mark at the start is read past', () => {
    assert.deepEqual(settingsProblems(`\uFEFF${JSON.stringify(SYNCED)}`), [])
  })

  test('comments and trailing commas are read as lntt check reads them, inside strings left alone', () => {
    const text = JSON.stringify(SYNCED, null, 2).replace('{', '{\n  // the project’s own, with a URL: "https://x.org//y"\n').replace(/\n}$/, ',\n}')
    assert.deepEqual(settingsProblems(text), [])
    assert.deepEqual(settingsProblems('{ /* all of it */ }'), [
      'extraKnownMarketplaces.lunette',
      'enabledPlugins.lunette@lunette',
      'hooks.SessionStart',
      'hooks.PostToolUse',
      'hooks.Stop',
    ])
  })

  test('no file at all: each entry lntt sync writes is missing', () => {
    assert.deepEqual(settingsProblems(null), [
      'extraKnownMarketplaces.lunette',
      'enabledPlugins.lunette@lunette',
      'hooks.SessionStart',
      'hooks.PostToolUse',
      'hooks.Stop',
    ])
  })

  test('a file that is not JSON is named as the whole file', () => {
    assert.deepEqual(settingsProblems('{ "a": '), ['.claude/settings.json'])
    assert.deepEqual(settingsProblems('{ /* open'), ['.claude/settings.json'])
  })
})
