import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DAY, issueTitles } from './issue-titles-hook.js'
import { register } from './register.js'

const GIT = '/repo/.git'
const CACHE = `${GIT}/lntt-issue-titles.json`
const NOW = 10 * DAY
const ok = (title, n) => ({ exitCode: 0, stdout: `${title}\thttps://github.com/o/r/issues/${n}\n`, stderr: '' })

// A fake engine: `gh` answers from `gh`, the files are `files`, and each gh call is recorded.
function engine({ gh = {}, files = {} } = {}) {
  const calls = []
  const $ = {
    process: {
      run: async (argv) => {
        if (argv[0] === 'git') return { exitCode: 0, stdout: `${GIT}\n`, stderr: '' }
        const n = argv[2].split('/').pop()
        calls.push(Number(n))
        return gh[n] ?? { exitCode: 1, stdout: '', stderr: 'Not Found' }
      },
    },
    fs: {
      exists: async (p) => p in files,
      read: async (p) => files[p],
      write: async (p, t) => {
        files[p] = t
      },
    },
    clock: { now: async () => NOW },
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

  test('each message starts over: the next one shows the title again', async () => {
    const { flush } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    await flush('m1', '#138\n', true)
    const again = await flush('m2', '#138 again\n')
    assert.match(again.displayContent, /· Publish lntt/)
  })

  test('a number gh does not resolve stays as written, is not cached, and is not asked again', async () => {
    const { flush, calls, files } = engine({ gh: { 9: { exitCode: 1, stdout: 'junk\tjunk', stderr: '' } } })
    assert.deepEqual(await flush('m1', '#9 here\n'), {})
    await flush('m2', '#9 again\n')
    assert.deepEqual(calls, [9])
    assert.deepEqual(JSON.parse(files[CACHE] ?? '{}'), {})
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

  test('the text a hook below rewrote is the one annotated', async () => {
    const { flush } = engine({ gh: { 138: ok('Publish lntt', 138) } })
    const shown = await flush('m1', 'raw #138\n', false, { displayContent: 'rewritten #138\n' })
    assert.match(shown.displayContent, /^rewritten #138 .*· Publish lntt/)
  })

  test('nothing to change returns what came from below', async () => {
    const { flush } = engine()
    const below = { displayContent: 'no numbers\n' }
    assert.equal(await flush('m1', 'no numbers\n', false, below), below)
  })
})
