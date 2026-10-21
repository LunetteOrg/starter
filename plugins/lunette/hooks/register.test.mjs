import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const PROGRESS = '/repo/.git/lntt-review.progress'
const roundOf = (session) =>
  [
    { t: 1_000, type: 'round', pid: 42, round: 1, session },
    { t: 1_001, type: 'phase', phase: 'reviewers', total: 1 },
    { t: 1_002, type: 'start', phase: 'reviewers', label: 'code · claude sonnet', optional: false },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n')

// The plugin registered on a fake engine, in a session whose id is `id` (an Error when
// the session cannot tell it), reading a progress file written by `session`'s round.
// Each load is a fresh copy of the module: its state is per session.
async function plugin({ id, session, ids }) {
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
      run: async (argv) =>
        argv[0] === 'git' ? { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    },
    fs: { exists: async (p) => p === PROGRESS, read: async () => roundOf(session) },
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
