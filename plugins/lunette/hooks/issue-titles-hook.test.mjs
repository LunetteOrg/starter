import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DAY, issueTitles, KEPT, WAIT_MS } from './issue-titles-hook.js'
import { register } from './register.js'

const GIT = '/repo/.git'
const CACHE = `${GIT}/lntt-issue-titles.json`
const NOW = 10 * DAY
const ok = (title, n, repo = 'o/r') => ({ exitCode: 0, stdout: `${title}\thttps://github.com/${repo}/issues/${n}\n`, stderr: '' })
const notFound = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }

// A fake engine: `gh` answers from `gh` (a result, an Error to throw, or a function
// returning a promise), the files are `files`, and each gh call is recorded. The
// clock's sleep never ends, so a delta waits for its lookups, unless `late` makes it
// end after a turn of the event loop: then a lookup still running is past its wait.
// `gh` answers by `N` for the session repository `o/r`, by `owner/repo#N` otherwise.
// `home` is what `gh repo view` answers: a repository, an exit code, an Error to throw
// or a function returning a promise.
function engine({ gh = {}, files = {}, git = 0, late = false, home = 'o/r', write = null } = {}) {
  const calls = []
  const waits = []
  const runs = [] // every command run, with its options
  const $ = {
    process: {
      run: async (argv, init) => {
        runs.push({ argv, init })
        if (argv[0] === 'git') return { exitCode: git, stdout: git ? '' : `${GIT}\n`, stderr: '' }
        if (argv[1] === 'repo') {
          if (home instanceof Error) throw home
          if (typeof home === 'function') return home()
          if (typeof home === 'number') return { exitCode: home, stdout: '', stderr: 'no git remotes found' }
          return { exitCode: 0, stdout: `${home}\n`, stderr: '' }
        }
        const [, repo, n] = argv[2].match(/^repos\/(.+)\/issues\/(\d+)$/)
        calls.push(repo === 'o/r' ? Number(n) : `${repo}#${n}`)
        const answer = (repo === 'o/r' ? gh[n] : gh[`${repo}#${n}`]) ?? notFound
        if (answer instanceof Error) throw answer
        return typeof answer === 'function' ? answer() : answer
      },
    },
    fs: {
      exists: async (p) => p in files,
      read: async (p) => files[p],
      write: async (p, t) => {
        files.__failOnce?.()
        if (write) await write()
        files[p] = t
      },
    },
    clock: {
      now: async () => NOW,
      sleep: (ms) => {
        waits.push(ms)
        return late ? new Promise((r) => setImmediate(r)) : new Promise(() => {})
      },
    },
  }
  const hooks = {}
  issueTitles((event, hook) => {
    hooks[event] = hook
    return { catch: () => {} }
  })
  const flush = (id, delta, final = false, below = {}) =>
    hooks['classic.MessageDisplay']($, { message_id: id, delta, final }, async () => below)
  return { flush, calls, files, waits, runs }
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
    const cached = JSON.parse(files[CACHE])['o/r#138']
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

  test('an answer whose URL is not plain https is not shown, and not asked again', async () => {
    const { flush, calls } = engine({ gh: { 4: { exitCode: 0, stdout: 'Title\thttp://x.org/4\n', stderr: '' } } })
    assert.deepEqual(await flush('m1', '#4 here\n'), {})
    await flush('m2', '#4 again\n')
    assert.deepEqual(calls, [4])
  })

  for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: This issue was deleted (HTTP 410)']) {
    test(`"${stderr}" means the number is not there: asked once`, async () => {
      const { flush, calls } = engine({ gh: { 7: { exitCode: 1, stdout: '', stderr } } })
      await flush('m1', '#7\n')
      await flush('m2', '#7\n')
      assert.deepEqual(calls, [7])
    })
  }

  for (const [label, stderr] of [
    ['gh auth login', 'To get started with GitHub CLI, please run:  gh auth login'],
    ['HTTP 401', 'gh: Bad credentials (HTTP 401)'],
  ]) {
    test(`gh not logged in (${label}) stops the lookups, and a cached title still shows`, async () => {
      const answer = { exitCode: 4, stdout: '', stderr }
      const files = { [CACHE]: JSON.stringify({ 'o/r#5': { title: 'Cached', url: 'https://github.com/o/r/issues/5', at: NOW } }) }
      const { flush, calls } = engine({ gh: { 1: answer, 2: answer }, files })
      await flush('m1', '#1\n')
      const shown = await flush('m2', '#2 and #5\n')
      assert.deepEqual(calls, [1])
      assert.match(shown.displayContent, /· Cached/)
    })
  }

  for (const [what, home] of [['missing', new Error('spawn gh ENOENT')], ['without a GitHub remote', 1]]) {
    test(`gh ${what}: the session's repository is unknown, so nothing is looked up or shown`, async () => {
      const files = { [CACHE]: JSON.stringify({ 'o/r#5': { title: 'Cached', url: 'https://github.com/o/r/issues/5', at: NOW } }) }
      const { flush, calls } = engine({ gh: { 1: ok('One', 1) }, home, files })
      assert.deepEqual(await flush('m1', '#1 and #5\n'), {})
      assert.deepEqual(calls, [])
    })
  }

  test('a reference to another repository is looked up there; a bare #N after it is not looked up', async () => {
    const { flush, calls } = engine({ gh: { 'x/pelion#3': ok('Pelion three', 3, 'x/pelion'), 65: ok('Ours', 65) } })
    const shown = await flush('m1', 'see x/pelion#3, and then #65\n')
    assert.deepEqual(calls, ['x/pelion#3'])
    assert.match(shown.displayContent, /x\/pelion#3 .*· Pelion three.*and then #65\n$/)
  })

  for (const home of ['', 'garbage', '../x']) {
    test(`gh repo view answering "${home}" is no repository: nothing is looked up`, async () => {
      const { flush, calls } = engine({ gh: { 1: ok('One', 1) }, home })
      assert.deepEqual(await flush('m1', '#1 and o/r#1\n'), {})
      assert.deepEqual(calls, [])
    })
  }

  test('without the session repository, even a cached reference written in full is shown as written', async () => {
    const files = { [CACHE]: JSON.stringify({ 'o/r#5': { title: 'Cached', url: 'https://github.com/o/r/issues/5', at: NOW } }) }
    const { flush } = engine({ home: 1, files })
    await flush('m1', 'warm up #9\n')
    assert.deepEqual(await flush('m2', 'see o/r#5\n'), {})
  })

  test('a reference to another repository in one delta keeps the next deltas bare', async () => {
    const { flush, calls } = engine({ gh: { 'x/pelion#3': ok('Pelion three', 3, 'x/pelion'), 7: ok('Seven', 7) } })
    await flush('m1', 'see x/pelion#3\n')
    assert.deepEqual(await flush('m1', 'then #7\n'), {})
    assert.deepEqual(calls, ['x/pelion#3'])
  })

  test('a reference that comes before the session repository is known keeps the rest of the message bare', async () => {
    let answer
    const home = () => new Promise((r) => (answer = () => r({ exitCode: 0, stdout: 'o/r\n', stderr: '' })))
    const { flush, calls } = engine({ gh: { 'x/pelion#3': ok('Pelion three', 3, 'x/pelion'), 7: ok('Seven', 7) }, home, late: true })
    await flush('m1', 'see x/pelion#3\n')
    answer()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(await flush('m1', 'then #7\n'), {})
    assert.deepEqual(calls, [])
  })

  test('the session repository is read in lower case', async () => {
    const { flush, calls } = engine({ gh: { 1: ok('One', 1) }, home: 'O/R' })
    assert.match((await flush('m1', '#1\n')).displayContent, /· One/)
    assert.deepEqual(calls, [1])
  })

  test('gh repo view exiting non-zero is no repository, whatever it prints', async () => {
    const home = () => Promise.resolve({ exitCode: 1, stdout: 'o/r\n', stderr: 'error' })
    const { flush, calls } = engine({ gh: { 1: ok('One', 1) }, home })
    assert.deepEqual(await flush('m1', '#1\n'), {})
    assert.deepEqual(calls, [])
  })

  test('a cache key that is not a lower-case owner/repo#N is skipped', async () => {
    const entry = (n) => ({ title: `Cached ${n}`, url: `https://github.com/o/r/issues/${n}`, at: NOW })
    const files = { [CACHE]: JSON.stringify({ 'O/R#5': entry(5), './x#6': entry(6), '../r#7': entry(7), 'r#8': entry(8) }) }
    const { flush } = engine({ files })
    const shown = await flush('m1', '#5 #6 #7 #8\n')
    assert.doesNotMatch(shown?.displayContent ?? '', /Cached/)
  })

  test('the box labels a reference to the session repository as #N', async () => {
    const { flush } = engine({ gh: { 4: ok('Four', 4) } })
    await flush('m1', '#4 here\n')
    const end = await flush('m1', 'end', true)
    assert.match(end.displayContent, /│\u001b\[22m #4 \u001b\[2mFour/)
  })

  test('every gh call has a timeout', async () => {
    const { flush, runs } = engine({ gh: { 1: ok('One', 1) } })
    await flush('m1', '#1\n')
    const gh = runs.filter((r) => r.argv[0] === 'gh')
    assert.deepEqual(gh.map((r) => r.argv[1]), ['repo', 'api'])
    for (const r of gh) assert.equal(r.init?.timeoutMs, 3000)
  })

  test('a message with no number runs nothing; a slow first look for the cache does not hold the text', async () => {
    const quiet = engine()
    await quiet.flush('m1', 'no numbers here\n', true)
    assert.deepEqual(quiet.runs, [])
    const slow = engine({ gh: { 1: ok('One', 1) }, home: () => new Promise(() => {}), late: true })
    assert.deepEqual(await slow.flush('m1', '#1\n'), {})
  })

  test('a later delta does not start the look for the cache again while gh repo view is slow', async () => {
    const { flush, runs } = engine({ gh: { 1: ok('One', 1) }, home: () => new Promise(() => {}), late: true })
    await flush('m1', '#1\n')
    await flush('m1', '#2\n')
    await flush('m2', '#3\n')
    assert.equal(runs.filter((r) => r.argv[1] === 'repo').length, 1)
    assert.equal(runs.filter((r) => r.argv[0] === 'git').length, 1)
  })

  test('a title found after its delta has moved on shows in the box of the same message', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r(ok('Late one', 4))))
    const { flush } = engine({ gh: { 4: slow }, late: true })
    await flush('m1', 'warm up #9\n')
    assert.deepEqual(await flush('m1', '#4 now\n'), {})
    release()
    await new Promise((r) => setImmediate(r))
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*#4.*Late one/s)
  })

  test('an HTTP status that only starts like 404 is not a missing issue', async () => {
    const { flush, calls } = engine({ gh: { 7: { exitCode: 1, stdout: '', stderr: 'gh: HTTP 4040' } } })
    await flush('m1', '#7\n')
    await flush('m2', '#7\n')
    assert.deepEqual(calls, [7, 7])
  })

  test('two titles found together are both in the cache, however slow the writes', async () => {
    const releases = []
    const write = () => new Promise((r) => releases.push(r))
    const { flush, files } = engine({ gh: { 1: ok('One', 1), 2: ok('Two', 2) }, write })
    await flush('m1', '#1 and #2\n')
    while (releases.length) {
      releases.pop()()
      await new Promise((r) => setImmediate(r))
    }
    const cached = JSON.parse(files[CACHE])
    assert.deepEqual([cached['o/r#1']?.title, cached['o/r#2']?.title], ['One', 'Two'])
  })

  test('a cache write that fails still shows the title, and later writes go on', async () => {
    const { flush, files } = engine({ gh: { 1: ok('One', 1), 2: ok('Two', 2) } })
    let failed = false
    files.__failOnce = () => {
      if (!failed) {
        failed = true
        throw new Error('disk full')
      }
    }
    assert.match((await flush('m1', '#1\n')).displayContent, /· One/)
    await flush('m2', '#2\n')
    await new Promise((r) => setImmediate(r))
    assert.ok(failed)
    assert.equal(JSON.parse(files[CACHE])['o/r#2'].title, 'Two')
  })

  test('one timer per delta for the cache and the titles together, and none when nothing waits', async () => {
    const { flush, waits } = engine({ gh: { 9: ok('Nine', 9), 1: () => new Promise(() => {}) }, late: true })
    await flush('m1', '#9\n')
    await new Promise((r) => setImmediate(r))
    await flush('m2', '#9 known\n')
    await new Promise((r) => setImmediate(r))
    const before = waits.length
    await flush('m3', '#9 known\n')
    assert.equal(waits.length, before, 'a known title starts no timer')
    await flush('m4', '#1 slow\n')
    assert.equal(waits.length, before + 1, 'a slow lookup waits on one timer')
  })

  test(`a delta waits for its lookups at most WAIT_MS (${WAIT_MS} ms)`, async () => {
    const { flush, waits } = engine({ gh: { 1: () => new Promise(() => {}) }, late: true })
    await flush('m1', '#1\n')
    assert.deepEqual(waits, [WAIT_MS])
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
        'o/r#1': { title: 'Fresh', url: 'https://github.com/o/r/issues/1', at: NOW - DAY + 1 },
        'o/r#2': { title: 'Stale', url: 'https://github.com/o/r/issues/2', at: NOW - DAY },
      }),
    }
    const { flush, calls } = engine({ gh: { 2: ok('Renamed', 2) }, files })
    const shown = await flush('m1', '#1 and #2\n')
    assert.deepEqual(calls, [2])
    assert.match(shown.displayContent, /· Fresh.*· Renamed/)
  })

  test('a cache entry of the wrong shape, a key that is no reference or a time in the future is skipped', async () => {
    const files = {
      [CACHE]: JSON.stringify({
        'o/r#1': null,
        '10': { title: 'Ten', url: 'https://github.com/o/r/issues/10', at: NOW },
        'o/r#1e1': { title: 'Ten', url: 'https://github.com/o/r/issues/10', at: NOW },
        'o/r#0x10': { title: 'Sixteen', url: 'https://github.com/o/r/issues/16', at: NOW },
        'o/r#0': { title: 'Zero', url: 'https://github.com/o/r/issues/0', at: NOW },
        'o/r#3': { title: 'Future', url: 'https://github.com/o/r/issues/3', at: NOW + 1 },
        'o/r#2': { title: 'Kept', url: 'https://github.com/o/r/issues/2', at: NOW },
      }),
    }
    const { flush, calls } = engine({ files })
    const shown = (await flush('m1', '#2, #10, #16, #0 and #3\n')).displayContent
    assert.match(shown, /· Kept/)
    assert.doesNotMatch(shown, /Ten|Sixteen|Zero|Future/)
    assert.deepEqual(calls, [10, 16, 3])
  })

  test('a corrupt cache, or an entry in it that is not safe to show, is ignored', async () => {
    const bad = { [CACHE]: JSON.stringify({ 'o/r#1': { title: 'Evil', url: 'https://x.org/1\u001b[2m', at: NOW } }) }
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
