import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { INSTALL_HOOK, MARKETPLACE, PLUGIN } from '../../src/claude-settings.ts'

const PROGRESS = '/repo/.git/lntt-review.progress'
const SETTINGS = '/repo/.claude/settings.json'
// The settings lntt sync writes.
const SYNCED = JSON.stringify({
  extraKnownMarketplaces: { lunette: MARKETPLACE },
  enabledPlugins: { [PLUGIN]: true },
  hooks: { SessionStart: [{ hooks: [INSTALL_HOOK] }] },
})
const roundOf = (session) =>
  [
    { t: 1_000, type: 'round', pid: 42, round: 1, session },
    { t: 1_001, type: 'phase', phase: 'reviewers', total: 1 },
    { t: 1_002, type: 'start', phase: 'reviewers', label: 'code · claude sonnet', optional: false },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')

// The plugin registered on a fake engine, in a session whose id is `id` (an Error when
// the session cannot tell it), reading a progress file written by `session`'s round (none
// when `session` is undefined) and the project's `settings` (null: no file).
// Each load is a fresh copy of the module: its state is per session.
async function plugin({ id, session, ids, settings = SYNCED, git = 0, unreadable = false }) {
  const { register } = await import(`./register.js?case=${Math.random()}`)
  const hooks = {}
  register((event, matcher, hook) => {
    hooks[event] = hook ?? matcher
    return { catch: () => {} }
  })
  const timers = []
  const el = (type) => (props) => ({ type, props })
  const $ = {
    session: {
      id: async () => {
        const now = ids ? ids.shift() : id
        return now instanceof Error ? Promise.reject(now) : now
      },
    },
    process: {
      run: async (argv) => {
        if (argv[0] !== 'git') return { exitCode: 0, stdout: '', stderr: '' }
        if (git !== 0) return { exitCode: git, stdout: '', stderr: 'fatal: not a git repository' }
        return { exitCode: 0, stdout: argv.includes('--show-toplevel') ? '/repo\n' : '/repo/.git\n', stderr: '' }
      },
    },
    fs: {
      exists: async (p) => (p === PROGRESS && session !== undefined) || (p === SETTINGS && (settings !== null || unreadable)),
      read: async (p) => {
        if (p === PROGRESS && session !== undefined) return roundOf(session)
        if (p === SETTINGS && unreadable) throw new Error(`EACCES: ${p}`)
        if (p === SETTINGS && settings !== null) return settings
        throw new Error(`ENOENT: ${p}`)
      },
    },
    clock: { now: async () => 2_000, every: (ms, fn) => timers.push(fn) },
    command: { register: async () => {} },
    ui: { invalidate: () => {}, resolve: () => ({ Text: el('Text'), Box: el('Box') }) },
  }
  await hooks['session.start']($, {}, async () => {})
  await timers[0]() // the first refresh reads the progress file
  return {
    refresh: () => timers[0](),
    band: () => hooks['ui.render']($, { surface: 'terminal' }, async () => 'below'),
    status: async () => (await hooks['command.run']($, {})).text,
    // A message's last delta, through the issue titles hook.
    end: () => hooks['classic.MessageDisplay']($, { message_id: 'm', delta: 'done', final: true }, async () => ({})),
  }
}

describe('the band in a session of the checkout', () => {
  test('the session that started the round draws it', async () => {
    const p = await plugin({ id: 's1', session: 's1' })
    const band = await p.band()
    assert.equal(band.type, 'Box')
    assert.match(JSON.stringify(band), /lntt review · round 1/)
    assert.match(await p.status(), /lntt review · round 1/)
  })

  test('another session draws nothing, and /review-status says where the round runs', async () => {
    const p = await plugin({ id: 's2', session: 's1' })
    assert.equal(await p.band(), 'below')
    assert.equal(await p.status(), 'An lntt review round runs in another session of this worktree.')
  })

  test('a round started outside a session is drawn in every session', async () => {
    const p = await plugin({ id: 's2', session: null })
    assert.equal((await p.band()).type, 'Box')
  })

  test("a session that cannot tell its id does not draw another session's round", async () => {
    const p = await plugin({ id: new Error('no id'), session: 's1' })
    assert.equal(await p.band(), 'below')
  })

  test('a /clear gives the session a new id: the round of its old id leaves the band', async () => {
    const p = await plugin({ ids: ['s1', 's1-after-clear'], session: 's1' })
    assert.equal((await p.band()).type, 'Box')
    await p.refresh()
    assert.equal(await p.band(), 'below')
  })

  test('an id that can no longer be read leaves none, not the last one', async () => {
    const p = await plugin({ ids: ['s1', new Error('gone')], session: 's1' })
    assert.equal((await p.band()).type, 'Box')
    await p.refresh()
    assert.equal(await p.band(), 'below')
  })
})

describe('the settings lntt sync writes, checked at session start', () => {
  test('as lntt sync writes them: nothing in the band', async () => {
    const p = await plugin({ id: 's1' })
    assert.equal(await p.band(), 'below')
  })

  for (const [what, settings] of [
    ['missing', null],
    ['with the GitHub marketplace', JSON.stringify({ extraKnownMarketplaces: { lunette: { source: { source: 'github', repo: 'LunetteOrg/starter' } } } })],
  ]) {
    test(`${what}: the band says to run lntt sync until the first message ends; /review-status says it too`, async () => {
      const p = await plugin({ id: 's1', settings })
      const band = await p.band()
      assert.equal(band.type, 'Box')
      assert.match(JSON.stringify(band), /\.claude\/settings\.json.*Run: pnpm exec lntt sync/)
      assert.match(await p.status(), /Run: pnpm exec lntt sync/)
      await p.end()
      assert.equal(await p.band(), 'below')
    })
  }

  for (const settings of ['{ "a": ', JSON.stringify({ hooks: { SessionStart: {} } })]) {
    test(`a file lntt sync refuses (${settings}): the band says to fix it by hand, then run lntt sync`, async () => {
      const p = await plugin({ id: 's1', settings })
      const band = JSON.stringify(await p.band())
      assert.match(band, /\.claude\/settings\.json is not JSON, or not the shape Claude Code reads: fix it, then run: pnpm exec lntt sync/)
      assert.doesNotMatch(band, /is not as lntt sync writes it/)
    })
  }

  test('a file that exists and cannot be read: nothing in the band', async () => {
    const p = await plugin({ id: 's1', settings: null, unreadable: true })
    assert.equal(await p.band(), 'below')
  })

  test('outside a git repository there is no project to check: nothing in the band', async () => {
    const p = await plugin({ id: 's1', settings: null, git: 128 })
    assert.equal(await p.band(), 'below')
  })
})
