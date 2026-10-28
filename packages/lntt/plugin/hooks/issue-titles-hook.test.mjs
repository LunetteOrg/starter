import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { FAILURES, issueTitles, KEPT, KEYS_PER_RUN, LNTT_TIMEOUT_MS, WAIT_MS } from './issue-titles-hook.js'
import { LOOKUPS_AT_ONCE } from '../../src/refs.ts'
import { register } from './register.js'

const TOP = '/repo'
const LOCAL = `${TOP}/node_modules/.bin/lntt`
const url = (ref) => {
  const [, repo, n] = ref.match(/^(.+)#(\d+)$/)
  return `https://github.com/${repo}/issues/${n}`
}

// A fake `lntt refs`: `#N` is the session repository's (`home`), `owner/repo#N` that
// repository's, a bare `#N` after another repository has no ref, a title goes after
// the whole link whose text holds the number (lntt's rules, tested in packages/lntt). `cache` holds the titles found (`ref -> title`); a full lookup
// answers from `gh` (`ref -> a title, "unknown", "failed", "off", or a function
// returning a promise of one`) and caches each title.
function fakeRefs({ args, stdin, home, cache, gh }) {
  const cached = args[0] === '--cached'
  const text = cached ? stdin : args.join('\n')
  let foreign = false
  const links = [...text.matchAll(/\[([^\]\n]*)\]\(([^)\s]*)\)/g)].map((l) => ({ from: l.index, to: l.index + l[0].length }))
  const mentions = [...text.matchAll(/(?:([a-z]+\/[a-z]+))?#([1-9]\d*)/g)].map((x) => {
    const full = x[1] ?? (foreign || !home ? null : home)
    if (x[1] && x[1] !== home) foreign = true
    const end = x.index + x[0].length
    const link = links.find((l) => l.from <= x.index && end <= l.to)
    return { text: x[0], ref: full && `${full}#${x[2]}`, index: x.index, after: link ? link.to : end }
  })
  const refs = async (ref) => {
    if (!home) return { ref, title: null, url: null, why: 'off' }
    if (cache[ref]) return { ref, title: cache[ref], url: url(ref) }
    if (cached) return { ref, title: null, url: null, why: 'cached' }
    const answer = await (typeof gh[ref] === 'function' ? gh[ref]() : (gh[ref] ?? 'unknown'))
    if (['unknown', 'failed', 'off'].includes(answer)) return { ref, title: null, url: null, why: answer }
    cache[ref] = answer
    return { ref, title: answer, url: url(ref) }
  }
  const keys = [...new Set(mentions.flatMap((m) => (m.ref ? [m.ref] : [])))]
  return Promise.all(keys.map(refs)).then((r) => JSON.stringify({ repository: home, mentions, refs: r }))
}

// One run of the fake lntt.
const fakeRun = async (argv, init, { gh = {}, cache = {}, home = 'o/r' }) => ({
  exitCode: 0,
  stdout: await fakeRefs({ args: argv.slice(2), stdin: init?.stdin, home, cache, gh }),
  stderr: '',
})

// A fake engine: lntt answers as fakeRefs, unless `lntt` replaces it (an Error to throw,
// or a function returning a run's result); `local` says whether the project has its own
// lntt. Every lntt run is recorded with its options. The clock's sleep never ends, so
// a delta waits for lntt, unless `late` makes it end after a turn of the event loop:
// then a call still running is past its wait.
function engine({ gh = {}, cache = {}, home = 'o/r', local = true, late = false, lntt = null } = {}) {
  const runs = []
  const waits = []
  const $ = {
    process: {
      run: async (argv, init) => {
        if (argv[0] === 'git') return { exitCode: 0, stdout: `${TOP}\n`, stderr: '' }
        runs.push({ argv, init })
        if (lntt instanceof Error) throw lntt
        if (lntt) return lntt(argv, init)
        const stdout = await fakeRefs({ args: argv.slice(2), stdin: init?.stdin, home, cache, gh })
        return { exitCode: 0, stdout, stderr: '' }
      },
    },
    fs: { exists: async (p) => local && p === LOCAL },
    clock: {
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
  // The references each full lookup asked for.
  const lookups = () => runs.filter((r) => r.argv[2] !== '--cached').map((r) => r.argv.slice(2))
  return { flush, runs, waits, lookups, cache }
}

const tick = () => new Promise((r) => setImmediate(r))

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
    const { flush } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    const first = await flush('m1', 'Do #138.\n')
    assert.match(first.displayContent, /#138 .*· Publish lntt/)
    assert.doesNotMatch(first.displayContent, /cited/)
    const last = await flush('m1', 'Done.', true)
    assert.match(last.displayContent, /^Done\.\n.*╭─ cited/s)
    assert.match(last.displayContent, /https:\/\/github\.com\/o\/r\/issues\/138/)
  })

  test('lntt refs --cached reads the message so far on stdin, then the missing titles are asked by ref', async () => {
    const { flush, runs } = engine({ gh: { 'o/r#2': 'Two' } })
    await flush('m1', 'one #1\n')
    await flush('m1', 'two #2\n')
    const cachedRuns = runs.filter((r) => r.argv[2] === '--cached')
    assert.deepEqual(
      cachedRuns.map((r) => [r.argv, r.init.stdin]),
      [
        [[LOCAL, 'refs', '--cached'], 'one #1\n'],
        [[LOCAL, 'refs', '--cached'], 'one #1\ntwo #2\n'],
      ],
    )
    assert.deepEqual(
      runs.filter((r) => r.argv[2] !== '--cached').map((r) => r.argv),
      [
        [LOCAL, 'refs', 'o/r#1'],
        [LOCAL, 'refs', 'o/r#2'],
      ],
    )
    for (const r of runs) assert.equal(r.init.timeoutMs, LNTT_TIMEOUT_MS)
  })

  test('a lookup asks lntt refs for at most KEYS_PER_RUN references, the rest in runs of their own', async () => {
    const { flush, lookups } = engine()
    const text = Array.from({ length: 2 * KEYS_PER_RUN + 1 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${text}\n`, true)
    const asked = lookups()
    assert.equal(asked.length, 3)
    for (const keys of asked) assert.ok(keys.length <= KEYS_PER_RUN)
    assert.equal(asked.flat().length, 2 * KEYS_PER_RUN + 1)
  })

  test('the runs of one lookup that fail together count as one failure', async () => {
    // lntt knows the repository and no title; every full lookup fails.
    const cached = (text) => ({
      repository: 'o/r',
      mentions: [...text.matchAll(/#(\d+)/g)].map((x) => ({
        text: x[0],
        ref: `o/r#${x[1]}`,
        index: x.index,
        after: x.index + x[0].length,
      })),
      refs: [],
    })
    const { flush, runs } = engine({
      lntt: (argv, init) =>
        argv[2] === '--cached'
          ? { exitCode: 0, stdout: JSON.stringify(cached(init.stdin)), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'boom' },
    })
    const many = Array.from({ length: 2 * KEYS_PER_RUN + 1 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${many}\n`, true)
    assert.equal(runs.filter((r) => r.argv[2] !== '--cached').length, 3)
    for (const id of ['m2', 'm3']) await flush(id, '#1 again\n')
    assert.equal(runs.filter((r) => r.argv[2] === '--cached').length, 3)
  })

  test('each run of a lookup keeps its own references pending, and a failed run frees its own', async () => {
    const cached = (text) => ({
      repository: 'o/r',
      mentions: [...text.matchAll(/#(\d+)/g)].map((x) => ({
        text: x[0],
        ref: `o/r#${x[1]}`,
        index: x.index,
        after: x.index + x[0].length,
      })),
      refs: [],
    })
    const held = []
    const { flush, lookups } = engine({
      late: true,
      lntt: (argv, init) => {
        if (argv[2] === '--cached') return { exitCode: 0, stdout: JSON.stringify(cached(init.stdin)), stderr: '' }
        return new Promise((resolve) => held.push({ keys: argv.slice(2), resolve }))
      },
    })
    const many = Array.from({ length: KEYS_PER_RUN + 2 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${many}\n`)
    assert.equal(held.length, 2)
    await flush('m2', `${many}\n`)
    assert.equal(lookups().length, 2)
    const [first, second] = held
    const ok = {
      repository: 'o/r',
      mentions: [],
      refs: first.keys.map((ref) => ({ ref, title: `T ${ref}`, url: `https://x/${ref.split('#')[1]}` })),
    }
    first.resolve({ exitCode: 0, stdout: JSON.stringify(ok), stderr: '' })
    second.resolve({ exitCode: 1, stdout: '', stderr: 'boom' })
    for (let i = 0; i < 5; i++) await tick()
    await flush('m3', `${many}\n`)
    assert.deepEqual(lookups().slice(2), [second.keys])
  })

  test('KEYS_PER_RUN is what lntt refs looks up at once, so one run fits LNTT_TIMEOUT_MS', () => {
    assert.equal(KEYS_PER_RUN, LOOKUPS_AT_ONCE)
  })

  test('a run that ends frees only its own references: the others stay pending', async () => {
    const cached = (text) => ({
      repository: 'o/r',
      mentions: [...text.matchAll(/#(\d+)/g)].map((x) => ({
        text: x[0],
        ref: `o/r#${x[1]}`,
        index: x.index,
        after: x.index + x[0].length,
      })),
      refs: [],
    })
    const held = []
    const { flush, lookups } = engine({
      late: true,
      lntt: (argv, init) => {
        if (argv[2] === '--cached') return { exitCode: 0, stdout: JSON.stringify(cached(init.stdin)), stderr: '' }
        return new Promise((resolve) => held.push({ keys: argv.slice(2), resolve }))
      },
    })
    const many = Array.from({ length: 2 * KEYS_PER_RUN + 1 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${many}\n`)
    assert.equal(held.length, 3)
    const out = {
      repository: 'o/r',
      mentions: [],
      refs: held[0].keys.map((ref) => ({ ref, title: `T ${ref}`, url: `https://x/${ref.split('#')[1]}` })),
    }
    held[0].resolve({ exitCode: 0, stdout: JSON.stringify(out), stderr: '' })
    for (let i = 0; i < 5; i++) await tick()
    await flush('m2', `${many}\n`)
    assert.equal(lookups().length, 3)
  })

  test("the project's lntt, else the lntt on PATH", async () => {
    const { flush, runs } = engine({ local: false, gh: { 'o/r#1': 'One' } })
    await flush('m1', '#1\n')
    assert.deepEqual(new Set(runs.map((r) => r.argv[0])), new Set(['lntt']))
  })

  test('a cached title shows with no lookup', async () => {
    const { flush, lookups } = engine({ cache: { 'o/r#5': 'Cached' } })
    assert.match((await flush('m1', '#5\n')).displayContent, /· Cached/)
    assert.deepEqual(lookups(), [])
  })

  test('each message starts over: the next one, or the same id after its end, shows the title again', async () => {
    const { flush } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    await flush('m1', '#138\n', true)
    assert.match((await flush('m2', '#138 again\n')).displayContent, /· Publish lntt/)
    assert.match((await flush('m1', '#138 again\n')).displayContent, /· Publish lntt/)
  })

  test('a number lntt says is unknown stays as written, and is not asked again', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#9': 'unknown' } })
    assert.deepEqual(await flush('m1', '#9 here\n'), {})
    await flush('m2', '#9 again\n')
    assert.deepEqual(lookups(), [['o/r#9']])
  })

  test('a failed lookup is asked again in the next message', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#8': 'failed' } })
    assert.deepEqual(await flush('m1', '#8\n'), {})
    await flush('m2', '#8\n')
    assert.deepEqual(lookups(), [['o/r#8'], ['o/r#8']])
  })

  test('lookups off (gh missing or logged out): none asked again, a cached title still shows', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#1': 'off', 'o/r#2': 'Two' }, cache: { 'o/r#5': 'Cached' } })
    await flush('m1', '#1\n')
    const shown = await flush('m2', '#2 and #5\n')
    assert.deepEqual(lookups(), [['o/r#1']])
    assert.match(shown.displayContent, /· Cached/)
  })

  test("without the session's repository, the message is shown as written", async () => {
    const { flush, lookups } = engine({ home: null, cache: { 'o/r#5': 'Cached' } })
    assert.deepEqual(await flush('m1', 'see o/r#5 and #5\n'), {})
    assert.deepEqual(await flush('m1', 'end', true), {})
    assert.deepEqual(lookups(), [])
  })

  for (const [what, failing] of [
    ['cannot start', () => Promise.reject(new Error('spawn lntt ENOENT'))],
    ['runs past its timeout', () => Promise.reject(new Error('timed out'))],
    ['fails', async () => ({ exitCode: 1, stdout: '', stderr: 'lntt refs: EACCES' })],
    ['answers garbage', async () => ({ exitCode: 0, stdout: 'not json', stderr: '' })],
  ]) {
    test(`lntt that ${what}: shown as written, and run again at the next lookup`, async () => {
      let fail = true
      const { flush, runs } = engine({
        lntt: (argv, init) => (fail ? failing() : fakeRun(argv, init, { gh: { 'o/r#2': 'Two' } })),
      })
      assert.deepEqual(await flush('m1', '#1\n'), {})
      fail = false
      assert.match((await flush('m2', '#2\n')).displayContent, /· Two/)
      assert.ok(runs.length > 1)
    })
  }

  test(`${FAILURES} failed runs in a row turn the titles off for the session; a success in between starts the count again`, async () => {
    // Each run in turn: two fail, then --cached and its lookup answer, then every run fails.
    const ok = new Set([3, 4])
    const { flush, runs } = engine({
      lntt: (argv, init) =>
        ok.has(runs.length) ? fakeRun(argv, init, { gh: { 'o/r#3': 'Three' } }) : Promise.reject(new Error('timed out')),
    })
    for (let i = 1; i <= 7; i += 1) await flush(`m${i}`, `#${i}\n`)
    assert.equal(FAILURES, 3)
    assert.equal(runs.length, 2 + 2 + FAILURES)
  })

  test(`a run with no session repository counts as failed: ${FAILURES} in a row turn the titles off; one with it starts the count again`, async () => {
    // Each run in turn: two find no repository, the third finds it (#3 cached), then none.
    const { flush, runs } = engine({
      lntt: (argv, init) => fakeRun(argv, init, { home: runs.length === 3 ? 'o/r' : null, cache: { 'o/r#3': 'Three' } }),
    })
    for (let i = 1; i <= 7; i += 1) await flush(`m${i}`, `#${i}\n`)
    assert.equal(runs.length, 2 + 1 + FAILURES)
  })

  test('lntt exiting 2 with anything else on stderr is a failed run, not an lntt with no refs', async () => {
    const { flush, runs } = engine({ lntt: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }) })
    for (let i = 1; i <= FAILURES + 2; i += 1) assert.deepEqual(await flush(`m${i}`, `#${i}\n`), {})
    assert.equal(runs.length, FAILURES)
  })

  for (const stdout of ['{}', '{"repository":"o/r"}']) {
    test(`lntt answering ${stdout}, with no mentions or refs: a failed run, ${FAILURES} in a row turn the titles off`, async () => {
      const { flush, runs } = engine({ lntt: async () => ({ exitCode: 0, stdout, stderr: '' }) })
      for (let i = 1; i <= FAILURES + 2; i += 1) assert.deepEqual(await flush(`m${i}`, `#${i}\n`), {})
      assert.equal(runs.length, FAILURES)
    })
  }

  for (const [what, stderr] of [
    ['an @lntt/lntt older than refs (its usage, exit 2)', 'usage: lntt path | validate | get <key>'],
    ['an unknown command', "lntt: unknown command 'refs'"],
  ]) {
    test(`lntt answering ${what}: off for the session at once`, async () => {
      const { flush, runs } = engine({ lntt: async () => ({ exitCode: 2, stdout: '', stderr }) })
      assert.deepEqual(await flush('m1', '#1\n'), {})
      assert.deepEqual(await flush('m2', '#2\n'), {})
      assert.equal(runs.length, 1)
    })
  }

  test('one lntt refs may ask the repository and then the titles: its timeout is two gh timeouts and two seconds', () => {
    assert.equal(LNTT_TIMEOUT_MS, 2 * 3000 + 2000)
  })

  test('a number split across deltas is the one cited: its title in the delta where it ends', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#1': 'Issue one', 'o/r#138': 'Publish lntt' } })
    assert.deepEqual(await flush('m1', 'See #1'), {})
    assert.match((await flush('m1', '38 now.')).displayContent, /^38 .*· Publish lntt.* now\.$/)
    const end = await flush('m1', ' end', true)
    assert.doesNotMatch(end.displayContent, /Issue one|\/1\b/)
    assert.match(end.displayContent, /cited.*#138/s)
    assert.deepEqual(lookups(), [['o/r#138']])
  })

  test('a delta that goes on a number of the text so far runs lntt: # | 138', async () => {
    const { flush } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    await flush('m1', 'See #')
    assert.match((await flush('m1', '138 now.')).displayContent, /^138 .*· Publish lntt.* now\.$/)
  })

  test('a number at the end of a delta gets its title at the start of the next, with no number in it', async () => {
    const { flush } = engine({ gh: { 'o/r#5': 'Five' } })
    assert.deepEqual(await flush('m1', 'See #5'), {})
    assert.match((await flush('m1', ' now.\n')).displayContent, /^ .*· Five.* now\.\n$/)
  })

  test('a ref lntt gives that is not a lower-case owner/repo#N is ignored', async () => {
    const evil = 'o/r\u001b]0;pwned\u0007#5'
    const lntt = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        repository: 'o/r',
        mentions: [{ text: '#5', ref: evil, index: 0, after: 2 }],
        refs: [{ ref: evil, title: 'T', url: 'https://x/y' }],
      }),
      stderr: '',
    })
    const { flush } = engine({ lntt })
    assert.deepEqual(await flush('m1', '#5 x'), {})
    assert.deepEqual(await flush('m1', 'y', true), {})
  })

  test('a reference to another repository is looked up there; a bare #N after it is not', async () => {
    const { flush, lookups } = engine({ gh: { 'x/pelion#3': 'Pelion three', 'o/r#65': 'Ours' } })
    const shown = await flush('m1', 'see x/pelion#3, and then #65\n')
    assert.deepEqual(lookups(), [['x/pelion#3']])
    assert.match(shown.displayContent, /x\/pelion#3 .*· Pelion three.*and then #65\n$/)
  })

  test('a title lntt gives is checked again before it is shown', async () => {
    const lntt = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        repository: 'o/r',
        mentions: [{ text: '#1', ref: 'o/r#1', index: 0, after: 2 }],
        refs: [{ ref: 'o/r#1', title: 'ok\u001b]0;pwned\u0007', url: 'https://github.com/o/r/issues/1' }],
      }),
      stderr: '',
    })
    const shown = await engine({ lntt }).flush('m1', '#1\n')
    assert.match(shown.displayContent, /· ok\]0;pwned/)
  })

  test('the box labels a reference to the session repository as #N', async () => {
    const { flush } = engine({ gh: { 'o/r#4': 'Four' } })
    await flush('m1', '#4 here\n')
    const end = await flush('m1', 'end', true)
    assert.match(end.displayContent, /│\u001b\[22m #4 \u001b\[2mFour/)
  })

  test('a message with no number runs nothing', async () => {
    const { flush, runs, waits } = engine()
    await flush('m1', 'no numbers here\n', true)
    assert.deepEqual(runs, [])
    assert.deepEqual(waits, [])
  })

  test('a slow lntt refs --cached does not hold the text, and its titles serve the next delta', async () => {
    let release
    const lntt = (argv, init) =>
      argv[2] === '--cached'
        ? new Promise((r) => {
            release = () =>
              r({
                exitCode: 0,
                stdout: JSON.stringify({
                  repository: 'o/r',
                  mentions: [{ text: '#1', ref: 'o/r#1', index: init.stdin.indexOf('#1'), after: init.stdin.indexOf('#1') + 2 }],
                  refs: [{ ref: 'o/r#1', title: 'One', url: 'https://github.com/o/r/issues/1' }],
                }),
                stderr: '',
              })
          })
        : Promise.resolve({ exitCode: 0, stdout: '{"repository":"o/r","mentions":[],"refs":[]}', stderr: '' })
    const { flush } = engine({ lntt, late: true })
    assert.deepEqual(await flush('m1', '#1\n'), {})
    release()
    await tick()
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*#1.*One/s)
  })

  test('a title found after its delta has moved on shows in the box of the same message', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r('Late one')))
    const { flush } = engine({ gh: { 'o/r#4': slow }, late: true })
    assert.deepEqual(await flush('m1', '#4 now\n'), {})
    release()
    await tick()
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*#4.*Late one/s)
  })

  test('a slow lookup does not hold the text: it shows as written, and the title comes later', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r('Slow one')))
    const { flush, lookups } = engine({ gh: { 'o/r#3': slow }, late: true })
    assert.deepEqual(await flush('m1', '#3 now\n'), {})
    await flush('m2', '#3 meanwhile\n')
    assert.deepEqual(lookups(), [['o/r#3']])
    release()
    await tick()
    assert.match((await flush('m3', '#3 later\n')).displayContent, /· Slow one/)
  })

  test('a number missing after a failure is asked again on the last delta, for the box', async () => {
    let tries = 0
    const flaky = async () => {
      tries += 1
      return tries === 1 ? 'failed' : 'Second try'
    }
    const { flush } = engine({ gh: { 'o/r#2': flaky } })
    await flush('m1', '#2 here\n')
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*Second try/s)
  })

  test('a reference of an earlier delta whose lookup failed is asked again on the last delta, not before', async () => {
    let tries = 0
    const flaky = async () => {
      tries += 1
      return tries === 1 ? 'failed' : 'Second try'
    }
    const { flush, lookups } = engine({ gh: { 'o/r#2': flaky, 'o/r#3': 'Three' } })
    await flush('m1', '#2 here\n')
    await flush('m1', 'and #3\n')
    assert.deepEqual(lookups(), [['o/r#2'], ['o/r#3']])
    assert.match((await flush('m1', 'end', true)).displayContent, /cited.*Second try/s)
    assert.deepEqual(lookups(), [['o/r#2'], ['o/r#3'], ['o/r#2']])
  })

  test('a link split across deltas runs lntt again with the next delta: the title goes after the link', async () => {
    const { flush } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    assert.deepEqual(await flush('m1', 'see [#138](http'), {})
    assert.match((await flush('m1', 's://x.org/1) now\n')).displayContent, /^s:\/\/x\.org\/1\) .*· Publish lntt.* now\n$/)
  })

  test('one timer per delta for lntt and the lookups together, and none when nothing waits', async () => {
    const { flush, waits } = engine({ gh: { 'o/r#9': 'Nine', 'o/r#1': () => new Promise(() => {}) }, late: true })
    await flush('m1', '#9\n')
    assert.equal(waits.length, 1)
    await tick()
    await flush('m2', 'no number\n')
    assert.equal(waits.length, 1, 'a delta with no number starts no timer')
    await flush('m3', '#1 slow\n')
    assert.equal(waits.length, 2, 'a slow lookup waits on the same timer as lntt')
  })

  test(`a delta waits for its lookups at most WAIT_MS (${WAIT_MS} ms)`, async () => {
    const { flush, waits } = engine({ gh: { 'o/r#1': () => new Promise(() => {}) }, late: true })
    await flush('m1', '#1\n')
    assert.deepEqual(waits, [WAIT_MS])
  })

  test(`at most ${KEPT} unfinished messages are kept: the oldest is forgotten`, async () => {
    const { flush } = engine({ gh: { 'o/r#1': 'One' } })
    await flush('m0', '#1\n')
    for (let i = 1; i <= KEPT; i += 1) await flush(`m${i}`, 'text\n')
    const end = await flush('m0', 'end', true)
    assert.doesNotMatch(end?.displayContent ?? '', /cited/)
  })

  test('the text a hook below rewrote is the one annotated', async () => {
    const { flush, runs } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    const shown = await flush('m1', 'raw #138\n', false, { displayContent: 'rewritten #138\n' })
    assert.match(shown.displayContent, /^rewritten #138 .*· Publish lntt/)
    assert.equal(runs[0].init.stdin, 'rewritten #138\n')
  })

  test('nothing to change returns what came from below, as it came', async () => {
    const { flush } = engine()
    const below = { displayContent: 'rewritten, no numbers\n' }
    assert.equal(await flush('m1', 'raw\n', false, below), below)
  })
})

// The real lntt refs (packages/lntt/bin/lntt.ts), run in a git repository of its own with
// a gh on PATH that knows o/r#1: the fake lntt above answers as it does.
const LNTT_BIN = new URL('../../bin/lntt.ts', import.meta.url).pathname
const GH = `#!/bin/sh
case "$*" in
  "repo view"*) echo o/r ;;
  "api repos/o/r/issues/1 "*) printf 'One\\thttps://github.com/o/r/issues/1\\n' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`

describe('the issue titles hook with the real lntt refs', () => {
  test('a title beside the number, and the box on the last delta', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'issue-titles-')))
    try {
      const stubs = join(tmp, 'bin')
      const repo = join(tmp, 'repo')
      mkdirSync(stubs)
      mkdirSync(repo)
      writeFileSync(join(stubs, 'gh'), GH)
      chmodSync(join(stubs, 'gh'), 0o755)
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
      const env = { ...process.env, PATH: `${stubs}:${process.env.PATH}` }
      // The engine's process.run: a command to its end, its exit code an answer.
      const run = (argv, init = {}) =>
        new Promise((resolve, reject) => {
          const [command, ...args] = argv[0] === 'lntt' ? [process.execPath, LNTT_BIN, ...argv.slice(1)] : argv
          const child = execFile(command, args, { cwd: repo, env, encoding: 'utf8', timeout: init.timeoutMs }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') reject(error)
            else resolve({ exitCode: error ? error.code : 0, stdout, stderr })
          })
          // A command may exit before reading its stdin: the write then fails with EPIPE,
          // which says nothing about the hook.
          child.stdin.on('error', () => {})
          child.stdin.end(init.stdin ?? '')
        })
      const $ = {
        process: { run },
        fs: { exists: async (p) => existsSync(p) },
        clock: { sleep: () => new Promise(() => {}) },
      }
      let hook
      issueTitles((_, h) => {
        hook = h
        return { catch: () => {} }
      })
      const flush = (delta, final = false) => hook($, { message_id: 'm1', delta, final }, async () => ({}))
      assert.match((await flush('Do #1.\n')).displayContent, /^Do #1 .*· One.*\.\n$/)
      const end = (await flush('Done.', true)).displayContent
      assert.match(end, /^Done\.\n.*╭─ cited.*#1 .*One.*https:\/\/github\.com\/o\/r\/issues\/1/s)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
