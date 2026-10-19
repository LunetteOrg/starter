import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DAY, issueTitles, KEPT } from './issue-titles-hook.js'
import { register } from './register.js'

const GIT = '/repo/.git'
const CACHE = `${GIT}/lntt-issue-titles.json`
const NOW = 10 * DAY
const ok = (title, n) => ({ exitCode: 0, stdout: `${title}\thttps://github.com/o/r/issues/${n}\n`, stderr: '' })
const notFound = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }

// A fake engine: `gh` answers from `gh` (a result, an Error to throw, or a function
// returning a promise), the files are `files`, and each gh call is recorded. The
// clock's sleep never ends, so a delta waits for its lookups, unless `late` makes it
// end at once: then a lookup still running is past its wait.
function engine({ gh = {}, files = {}, git = 0, late = false } = {}) {
  const calls = []
  const $ = {
    process: {
      run: async (argv) => {
        if (argv[0] === 'git') return { exitCode: git, stdout: git ? '' : `${GIT}\n`, stderr: '' }
        const n = argv[2].split('/').pop()
        calls.push(Number(n))
        const answer = gh[n] ?? notFound
        if (answer instanceof Error) throw answer
        return typeof answer === 'function' ? answer() : answer
      },
    },
    fs: {
      exists: async (p) => p in files,
      read: async (p) => files[p],
      write: async (p, t) => {
        files[p] = t
      },
    },
    clock: { now: async () => NOW, sleep: () => (late ? Promise.resolve() : new Promise(() => {})) },
  }
  const hooks = {}
  issueTitles((event, hook) => {
    hooks[event] = hook
    return { catch: () => {} }
  })
  const flush = (id, delta, final = false, below = {}) =>
    hooks['classic.MessageDisplay']($, { message_id: id, delta, final }, async () => below)
  return { flush, calls, files }
}

describe('the issue titles hook', () => {
  test('the plugin registers it', () => {
    const events = []
    register((event) => {
      events.push(event)
      return { catch: () => {} }
    })
    assert.ok(events.includes('classic.MessageDisplay'))
  })

  test('a title beside the number, and the box once, on the last delta', async () => {
    const { flush } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    const first = await flush('m1', 'Do #138.\n')
    assert.match(first.displayContent, /#138 .*· Publish lntt/)
    assert.doesNotMatch(first.displayContent, /cited/)
    const last = await flush('m1', 'Done.', true)
    assert.match(last.displayContent, /^Done\.\n.*╭─ cited/s)
    assert.match(last.displayContent, /https:\/\/github\.com\/o\/r\/issues\/138/)
  })

  test('each message starts over: the next one, or the same id after its end, shows the title again', async () => {
    const { flush } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    await flush('m1', '#138\n', true)
    assert.match((await flush('m2', '#138 again\n')).displayContent, /· Publish lntt/)
    assert.match((await flush('m1', '#138 again\n')).displayContent, /· Publish lntt/)
  })

  test('a resolved title is written to the cache, with the time it was asked', async () => {
    const { flush, files } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    await flush('m1', '#138\n')
    const cached = JSON.parse(files[CACHE])[138]
    assert.equal(cached.title, 'Publish lntt')
    assert.equal(cached.at, NOW)
  })

  test('a number gh answers it does not know stays as written, is not cached, and is not asked again', async () => {
    const answer = { exitCode: 1, stdout: 'Title\thttps://github.com/o/r/issues/9', stderr: 'gh: Not Found (HTTP 404)' }
    const { flush, calls, files } = engine({ gh: { 9: answer } })
    assert.deepEqual(await flush('m1', '#9 here\n'), {})
    await flush('m2', '#9 again\n')
    assert.deepEqual(calls, [9])
    assert.equal(files[CACHE], undefined)
  })

  test('an answer whose URL is not plain https is not shown', async () => {
    const { flush } = engine({ gh: { 4: { exitCode: 0, stdout: 'Title\thttp://x.org/4\n', stderr: '' } } })
    assert.deepEqual(await flush('m1', '#4 here\n'), {})
  })

  test('any other failure of gh (a rate limit) is not shown, and is tried again', async () => {
    const answer = { exitCode: 1, stdout: 'Title\thttps://github.com/o/r/issues/8', stderr: 'API rate limit exceeded' }
    const { flush, calls } = engine({ gh: { 8: answer } })
    assert.deepEqual(await flush('m1', '#8\n'), {})
    await flush('m2', '#8\n')
    assert.deepEqual(calls, [8, 8])
  })

  test('a number missing after a failure is asked again on the last delta, for the box', async () => {
    let tries = 0
    const flaky = () => {
      tries += 1
      if (tries === 1) throw new Error('timed out')
      return ok('Second try', 2)
    }
    const { flush } = engine({ gh: { 2: flaky } })
    await flush('m1', '#2 here\n')
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*Second try/s)
  })

  test('a gh that throws or times out is tried again in the next message', async () => {
    const { flush, calls } = engine({ gh: { 5: new Error('timed out') } })
    await flush('m1', '#5\n')
    await flush('m2', '#5\n')
    assert.deepEqual(calls, [5, 5])
  })

  test('a slow gh does not hold the text: it shows as written, and the title comes later', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r(ok('Slow one', 3))))
    const { flush, calls } = engine({ gh: { 3: slow }, late: true })
    assert.deepEqual(await flush('m1', '#3 now\n'), {})
    await flush('m2', '#3 meanwhile\n')
    assert.deepEqual(calls, [3])
    release()
    await new Promise((r) => setImmediate(r))
    assert.match((await flush('m3', '#3 later\n')).displayContent, /· Slow one/)
  })

  test('outside a repository nothing is looked up', async () => {
    const { flush, calls } = engine({ git: 128, gh: { 138: ok('Publish lntt', 138) } })
    assert.deepEqual(await flush('m1', '#138\n'), {})
    assert.deepEqual(calls, [])
  })

  test('a cached title younger than a day is used; an older one is asked again', async () => {
    const files = {
      [CACHE]: JSON.stringify({
        1: { title: 'Fresh', url: 'https://github.com/o/r/issues/1', at: NOW - DAY + 1 },
        2: { title: 'Stale', url: 'https://github.com/o/r/issues/2', at: NOW - DAY },
      }),
    }
    const { flush, calls } = engine({ gh: { 2: ok('Renamed', 2) }, files })
    const shown = await flush('m1', '#1 and #2\n')
    assert.deepEqual(calls, [2])
    assert.match(shown.displayContent, /· Fresh.*· Renamed/)
  })

  test('a cache entry of the wrong shape is skipped, and the others still read', async () => {
    const files = { [CACHE]: JSON.stringify({ 1: null, 2: { title: 'Kept', url: 'https://github.com/o/r/issues/2', at: NOW } }) }
    const { flush, calls } = engine({ files })
    assert.match((await flush('m1', '#2\n')).displayContent, /· Kept/)
    assert.deepEqual(calls, [])
  })

  test('a corrupt cache, or an entry in it that is not safe to show, is ignored', async () => {
    const bad = { [CACHE]: JSON.stringify({ 1: { title: 'Evil', url: 'https://x.org/1\u001b[2m', at: NOW } }) }
    const a = engine({ gh: { 1: ok('Good', 1) }, files: bad })
    assert.match((await a.flush('m1', '#1\n')).displayContent, /· Good/)
    const b = engine({ gh: { 1: ok('Good', 1) }, files: { [CACHE]: '{not json' } })
    assert.match((await b.flush('m1', '#1\n')).displayContent, /· Good/)
  })

  test(`at most ${KEPT} unfinished messages are kept: the oldest is forgotten`, async () => {
    const { flush } = engine({ gh: { 1: ok('One', 1) } })
    await flush('m0', '#1\n')
    for (let i = 1; i <= KEPT; i += 1) await flush(`m${i}`, 'text\n')
    const end = await flush('m0', 'end', true)
    assert.doesNotMatch(end?.displayContent ?? '', /cited/)
  })

  test('the text a hook below rewrote is the one annotated', async () => {
    const { flush } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    const shown = await flush('m1', 'raw #138\n', false, { displayContent: 'rewritten #138\n' })
    assert.match(shown.displayContent, /^rewritten #138 .*· Publish lntt/)
  })

  test('nothing to change returns what came from below, as it came', async () => {
    const { flush } = engine()
    const below = { displayContent: 'rewritten, no numbers\n' }
    assert.equal(await flush('m1', 'raw\n', false, below), below)
  })
})
