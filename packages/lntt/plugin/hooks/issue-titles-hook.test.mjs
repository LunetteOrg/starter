import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { FAILURES, issueTitles, KEPT, KEYS_PER_RUN, LNTT_TIMEOUT_MS, SETTLE_MS } from './issue-titles-hook.js'
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

// What a drawn block reads as, one line per row of the box, as text.
const flatten = (node) => {
  if (typeof node === 'string') return node
  const kids = node.props.children
  if (node.props.flexDirection === 'column') return kids.map(flatten).join('\n')
  return kids.map(flatten).join('')
}

// A fake engine: lntt answers as fakeRefs, unless `lntt` replaces it (an Error to throw,
// or a function returning a run's result); `local` says whether the project has its own
// lntt. Every lntt run is recorded with its options. The clock's sleep ends at once.
// `draw(text)` is the hook's drawing of one AssistantMessage block (what Claude Code
// draws is the string 'BLOCK'); `flush` plays a message of deltas: the text is drawn when
// complete, left to settle, and drawn again, as what shows once lookups ended.
function engine({ gh = {}, cache = {}, home = 'o/r', local = true, lntt = null, auth = 0, version = '0.6.2', hold = false } = {}) {
  const runs = []
  const waits = []
  const auths = []
  const invalidated = []
  const gates = []
  const el = (type) => (props) => ({ type, props })
  const $ = {
    process: {
      run: async (argv, init) => {
        if (argv[0] === 'git') return { exitCode: 0, stdout: `${TOP}\n`, stderr: '' }
        // `gh auth status`, asked once when the titles cannot be found: `auth` is its exit
        // code, or an Error when gh cannot start.
        if (argv[0] === 'gh') {
          auths.push(argv)
          if (auth instanceof Error) throw auth
          return { exitCode: auth, stdout: '', stderr: '' }
        }
        runs.push({ argv, init })
        if (lntt instanceof Error) throw lntt
        if (lntt) return lntt(argv, init)
        const stdout = await fakeRefs({ args: argv.slice(2), stdin: init?.stdin, home, cache, gh })
        return { exitCode: 0, stdout, stderr: '' }
      },
    },
    fs: {
      exists: async (p) => local && p === LOCAL,
      read: async (p) => {
        if (local && p === `${TOP}/node_modules/@lntt/lntt/package.json`) return JSON.stringify({ version })
        throw new Error(`ENOENT: ${p}`)
      },
    },
    clock: {
      sleep: (ms) => {
        waits.push(ms)
        // `hold`: a sleep ends when `settle()` says, so that a block grows meanwhile.
        return hold ? new Promise((r) => gates.push(r)) : Promise.resolve()
      },
    },
    ui: { invalidate: (event) => invalidated.push(event), resolve: () => ({ Box: el('Box'), Text: el('Text') }) },
  }
  const hooks = {}
  const ended = []
  issueTitles(
    (event, matcher, hook) => {
      hooks[event] = { matcher, hook: hook ?? matcher }
      return {
        catch: (catcher) => {
          hooks[event].catcher = catcher
        },
      }
    },
    { ended: () => ended.push(true) },
  )
  const draw = (text) =>
    hooks['ui.render'].hook($, { surface: 'terminal', component: 'AssistantMessage', props: { text } }, async () => 'BLOCK')
  const texts = new Map()
  const flush = async (id, delta, final = false) => {
    texts.set(id, (texts.get(id) ?? '') + delta)
    if (!final) return {}
    const text = texts.get(id)
    texts.delete(id)
    await draw(text)
    for (let i = 0; i < 40; i += 1) await tick()
    const shown = await draw(text)
    return shown === 'BLOCK' ? {} : { displayContent: flatten(shown).replace(/^BLOCK/, delta) }
  }
  // The references each full lookup asked for.
  const lookups = () => runs.filter((r) => r.argv[2] !== '--cached').map((r) => r.argv.slice(2))
  const settle = async (count = gates.length, from = 0) => {
    for (const r of gates.splice(from, count)) r()
    for (let i = 0; i < 40; i += 1) await tick()
  }
  return { draw, flush, runs, waits, lookups, cache, auths, invalidated, hooks, $, ended, settle }
}

// Whether a message ends with its box of what it cited.
const boxed = (shown) => /╭─ cited/.test(shown?.displayContent ?? '')

const tick = () => new Promise((r) => setImmediate(r))

// What a notice reads, without the terminal's dim sequences.
const plain = (text) => (text ?? '').replaceAll(/\u001b\[\d+m/g, '')

describe('the issue titles hook', () => {
  test('the plugin registers it', () => {
    const events = []
    register((event) => {
      events.push(event)
      return { catch: () => {} }
    })
    assert.ok(events.includes('ui.render'))
    assert.ok(!events.includes('classic.MessageDisplay'))
  })

  test('the box comes under the block once lntt has read it: nothing before the text is whole', async () => {
    const { flush, runs } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    assert.deepEqual(await flush('m1', 'Do #138.\n'), {})
    assert.deepEqual(runs, [])
    const last = await flush('m1', 'Done.', true)
    assert.match(last.displayContent, /^Done\.\n.*╭─ cited/s)
    assert.match(plain(last.displayContent), /#138 Publish lntt/)
    assert.match(last.displayContent, /https:\/\/github\.com\/o\/r\/issues\/138/)
  })

  test('lntt refs --cached reads the whole message on stdin, then the missing titles are asked by ref', async () => {
    const { flush, runs } = engine({ gh: { 'o/r#1': 'One', 'o/r#2': 'Two' } })
    await flush('m1', 'one #1\n')
    await flush('m1', 'two #2\n', true)
    assert.deepEqual(
      runs.filter((r) => r.argv[2] === '--cached').map((r) => [r.argv, r.init.stdin]),
      [[[LOCAL, 'refs', '--cached'], 'one #1\ntwo #2\n']],
    )
    assert.deepEqual(
      runs.filter((r) => r.argv[2] !== '--cached').map((r) => r.argv),
      [[LOCAL, 'refs', 'o/r#1', 'o/r#2']],
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
    await flush('m1', `${many}\nm1\n`, true)
    assert.equal(runs.filter((r) => r.argv[2] !== '--cached').length, 3)
    for (const id of ['m2', 'm3']) await flush(id, `#1 again ${id}\n`, true)
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
        lntt: (argv, init) => {
        if (argv[2] === '--cached') return { exitCode: 0, stdout: JSON.stringify(cached(init.stdin)), stderr: '' }
        return new Promise((resolve) => held.push({ keys: argv.slice(2), resolve }))
      },
    })
    const many = Array.from({ length: KEYS_PER_RUN + 2 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${many}\nm1\n`, true)
    assert.equal(held.length, 2)
    await flush('m2', `${many}\nm2\n`, true)
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
    await flush('m3', `${many}\nm3\n`, true)
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
        lntt: (argv, init) => {
        if (argv[2] === '--cached') return { exitCode: 0, stdout: JSON.stringify(cached(init.stdin)), stderr: '' }
        return new Promise((resolve) => held.push({ keys: argv.slice(2), resolve }))
      },
    })
    const many = Array.from({ length: 2 * KEYS_PER_RUN + 1 }, (_, i) => `#${i + 1}`).join(' ')
    await flush('m1', `${many}\nm1\n`, true)
    assert.equal(held.length, 3)
    const out = {
      repository: 'o/r',
      mentions: [],
      refs: held[0].keys.map((ref) => ({ ref, title: `T ${ref}`, url: `https://x/${ref.split('#')[1]}` })),
    }
    held[0].resolve({ exitCode: 0, stdout: JSON.stringify(out), stderr: '' })
    for (let i = 0; i < 5; i++) await tick()
    await flush('m2', `${many}\nm2\n`, true)
    assert.equal(lookups().length, 3)
  })

  test("the project's lntt, else the lntt on PATH", async () => {
    const { flush, runs } = engine({ local: false, gh: { 'o/r#1': 'One' } })
    await flush('m1', '#1\n', true)
    assert.deepEqual(new Set(runs.map((r) => r.argv[0])), new Set(['lntt']))
  })

  test('a cached title shows with no lookup', async () => {
    const { flush, lookups } = engine({ cache: { 'o/r#5': 'Cached' } })
    assert.match(plain((await flush('m1', '#5\n', true)).displayContent), /#5 Cached/)
    assert.deepEqual(lookups(), [])
  })

  test('each message starts over: the next one, or the same id after its end, boxes the title again', async () => {
    const { flush } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    await flush('m1', '#138\n', true)
    assert.match((await flush('m2', '#138 again\n', true)).displayContent, /cited.*Publish lntt/s)
    assert.match((await flush('m1', '#138 again\n', true)).displayContent, /cited.*Publish lntt/s)
  })

  test('a number lntt says is unknown stays as written, and is not asked again', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#9': 'unknown' } })
    assert.deepEqual(await flush('m1', '#9 here\n', true), {})
    await flush('m2', '#9 again\n', true)
    assert.deepEqual(lookups(), [['o/r#9']])
  })

  test('a failed lookup is asked again in the next message', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#8': 'failed' } })
    assert.deepEqual(await flush('m1', '#8\n', true), {})
    await flush('m2', '#8 again\n', true)
    assert.deepEqual(lookups(), [['o/r#8'], ['o/r#8']])
  })

  test('lookups off (gh missing or logged out): none asked again, a cached title still shows', async () => {
    const { flush, lookups } = engine({ gh: { 'o/r#1': 'off', 'o/r#2': 'Two' }, cache: { 'o/r#5': 'Cached' } })
    await flush('m1', '#1\n', true)
    const shown = await flush('m2', '#2 and #5\n', true)
    assert.deepEqual(lookups(), [['o/r#1']])
    assert.match(plain(shown.displayContent), /#5 Cached/)
    assert.doesNotMatch(plain(shown.displayContent), /#2 Two/)
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
      assert.equal(boxed(await flush('m1', '#1\n', true)), false)
      fail = false
      assert.match(plain((await flush('m2', '#2\n', true)).displayContent), /#2 Two/)
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
    for (let i = 1; i <= 7; i += 1) await flush(`m${i}`, `#${i}\n`, true)
    assert.equal(FAILURES, 3)
    assert.equal(runs.length, 2 + 2 + FAILURES)
  })

  test(`a run with no session repository counts as failed: ${FAILURES} in a row turn the titles off; one with it starts the count again`, async () => {
    // Each run in turn: two find no repository, the third finds it (#3 cached), then none.
    const { flush, runs } = engine({
      lntt: (argv, init) => fakeRun(argv, init, { home: runs.length === 3 ? 'o/r' : null, cache: { 'o/r#3': 'Three' } }),
    })
    for (let i = 1; i <= 7; i += 1) await flush(`m${i}`, `#${i}\n`, true)
    assert.equal(runs.length, 2 + 1 + FAILURES)
  })

  test('lntt exiting 2 with anything else on stderr is a failed run, not an lntt with no refs', async () => {
    const { flush, runs } = engine({ lntt: async () => ({ exitCode: 2, stdout: '', stderr: 'boom' }) })
    for (let i = 1; i <= FAILURES + 2; i += 1) assert.equal(boxed(await flush(`m${i}`, `#${i}\n`, true)), false)
    assert.equal(runs.length, FAILURES)
  })

  for (const stdout of ['{}', '{"repository":"o/r"}']) {
    test(`lntt answering ${stdout}, with no mentions or refs: a failed run, ${FAILURES} in a row turn the titles off`, async () => {
      const { flush, runs } = engine({ lntt: async () => ({ exitCode: 0, stdout, stderr: '' }) })
      for (let i = 1; i <= FAILURES + 2; i += 1) assert.equal(boxed(await flush(`m${i}`, `#${i}\n`, true)), false)
      assert.equal(runs.length, FAILURES)
    })
  }

  for (const [what, stderr] of [
    ['an @lntt/lntt older than refs (its usage, exit 2)', 'usage: lntt path | validate | get <key>'],
    ['an unknown command', "lntt: unknown command 'refs'"],
  ]) {
    test(`lntt answering ${what}: off for the session at once`, async () => {
      const { flush, runs } = engine({ lntt: async () => ({ exitCode: 2, stdout: '', stderr }) })
      assert.equal(boxed(await flush('m1', '#1\n', true)), false)
      assert.equal(boxed(await flush('m2', '#2\n', true)), false)
      assert.equal(runs.length, 1)
    })
  }

  test('an lntt that cannot start: the message ends with what to run, once in the session', async () => {
    const { flush } = engine({ local: false, lntt: () => Promise.reject(new Error('spawn lntt ENOENT')) })
    await flush('m1', '#1\n')
    const end = await flush('m1', 'done', true)
    assert.match(plain(end.displayContent), /^done\nlntt · issue titles off: lntt is not installed in this project\. Run: pnpm install$/)
    await flush('m2', '#2\n')
    assert.deepEqual(await flush('m2', 'again', true), {})
  })

  test('an lntt the shell cannot find (exit 127): the same notice', async () => {
    const { flush } = engine({ local: false, lntt: async () => ({ exitCode: 127, stdout: '', stderr: 'lntt: not found' }) })
    const end = await flush('m1', '#1 done\n', true)
    assert.match(plain(end.displayContent), /lntt is not installed in this project\. Run: pnpm install$/)
  })

  test('an lntt with no refs: the notice names the version found and the update', async () => {
    const { flush } = engine({ lntt: async () => ({ exitCode: 2, stdout: '', stderr: 'usage: lntt path' }) })
    const end = await flush('m1', '#1 done\n', true)
    assert.match(plain(end.displayContent), /lntt 0\.6\.2 has no `lntt refs`.*Run: pnpm up @lntt\/lntt$/)
  })

  test('an lntt on PATH with no refs: the notice says so, and to install the project’s', async () => {
    const { flush } = engine({ local: false, lntt: async () => ({ exitCode: 2, stdout: '', stderr: 'usage: lntt path' }) })
    const end = await flush('m1', '#1 done\n', true)
    assert.match(plain(end.displayContent), /the lntt on PATH has no `lntt refs`.*Run: pnpm install$/)
  })

  for (const [what, auth, says] of [
    ['gh missing', new Error('spawn gh ENOENT'), /gh is not installed\. Install it \(https:\/\/cli\.github\.com\), then run: gh auth login$/],
    ['gh logged out', 1, /gh is not logged in\. Run: gh auth login$/],
  ]) {
    test(`no session repository, ${what}: gh auth status asked once, and the message ends with what to run`, async () => {
      const { flush, auths } = engine({ home: null, auth })
      await flush('m1', '#1\n')
      const end = await flush('m1', 'done', true)
      assert.match(plain(end.displayContent), says)
      await flush('m2', '#2 end\n', true)
      assert.equal(auths.length, 1)
    })
  }

  test('lookups off with gh logged out: the same notice', async () => {
    const { flush } = engine({ gh: { 'o/r#1': 'off' }, auth: 1 })
    const end = await flush('m1', '#1 done\n', true)
    assert.match(plain(end.displayContent), /gh is not logged in/)
  })

  test('no session repository with gh logged in (no GitHub remote): nothing to tell', async () => {
    const { flush } = engine({ home: null, auth: 0 })
    await flush('m1', '#1\n')
    assert.deepEqual(await flush('m1', 'done', true), {})
  })

  test('one lntt refs may ask the repository and then the titles: its timeout is two gh timeouts and two seconds', () => {
    assert.equal(LNTT_TIMEOUT_MS, 2 * 3000 + 2000)
  })

  test('a number at the end of the last delta is cited', async () => {
    const { flush } = engine({ gh: { 'o/r#5': 'Five' } })
    assert.match(plain((await flush('m1', 'See #5', true)).displayContent), /#5 Five/)
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
    const shown = await flush('m1', 'see x/pelion#3, and then #65\n', true)
    assert.deepEqual(lookups(), [['x/pelion#3']])
    assert.match(plain(shown.displayContent), /^see x\/pelion#3, and then #65\n\n.*x\/pelion#3 Pelion three/s)
    assert.doesNotMatch(shown.displayContent, /Ours/)
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
    const shown = await engine({ lntt }).flush('m1', '#1\n', true)
    assert.match(shown.displayContent, /ok\]0;pwned/)
    assert.doesNotMatch(shown.displayContent, /\u0007/)
  })

  test('the box labels a reference to the session repository as #N', async () => {
    const { flush } = engine({ gh: { 'o/r#4': 'Four' } })
    await flush('m1', '#4 here\n')
    const end = await flush('m1', 'end', true)
    assert.match(end.displayContent, /│ #4 Four/)
  })

  test('a message with no number runs nothing', async () => {
    const { flush, runs, waits } = engine()
    await flush('m1', 'no numbers here\n', true)
    assert.deepEqual(runs, [])
    assert.deepEqual(waits, [])
  })

  test('the same id after its end starts a new message: only its own text is read and boxed', async () => {
    const { flush, runs } = engine({ gh: { 'o/r#1': 'One', 'o/r#2': 'Two' } })
    await flush('m1', 'first #1\n', true)
    const end = await flush('m1', 'second #2\n', true)
    assert.equal(runs.filter((r) => r.argv[2] === '--cached')[1].init.stdin, 'second #2\n')
    assert.match(plain(end.displayContent), /#2 Two/)
    assert.doesNotMatch(plain(end.displayContent), /#1 One/)
  })

  test('a `#` that is no reference (a heading, #0) starts no lntt and no timer', async () => {
    const { flush, runs, waits } = engine()
    assert.deepEqual(await flush('m1', '# Heading\n\nissue #0\n', true), {})
    assert.deepEqual(runs, [])
    assert.deepEqual(waits, [])
  })

  test('a number missing after a failure is asked again on the last delta, for the box', async () => {
    let tries = 0
    const flaky = async () => {
      tries += 1
      return tries === 1 ? 'failed' : 'Second try'
    }
    const { flush } = engine({ gh: { 'o/r#2': flaky } })
    await flush('m1', '#2 here\n', true)
    assert.match((await flush('m2', '#2 again\n', true)).displayContent, /cited.*Second try/s)
  })


  test(`a block that grows is read once it settles (${SETTLE_MS} ms): only its last text is asked for`, async () => {
    const { draw, runs, waits, settle } = engine({ hold: true, gh: { 'o/r#138': 'Publish lntt' } })
    await draw('See #1')
    await draw('See #138 now.')
    await settle()
    assert.deepEqual(waits, [SETTLE_MS, SETTLE_MS])
    assert.deepEqual(
      runs.filter((r) => r.argv[2] === '--cached').map((r) => r.init.stdin),
      ['See #138 now.'],
    )
    assert.match(flatten(await draw('See #138 now.')), /#138 Publish lntt/)
  })

  test('a block drawn again (a scroll, an invalidate) asks lntt for nothing the session knows', async () => {
    const { draw, flush, runs } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    await flush('m1', 'See #138\n', true)
    const asked = runs.length
    for (let i = 0; i < 3; i += 1) assert.match(flatten(await draw('See #138\n')), /#138 Publish lntt/)
    await tick()
    assert.equal(runs.length, asked)
  })

  test('a title found after the block was drawn redraws it', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r('Slow one')))
    const { draw, flush, invalidated } = engine({ gh: { 'o/r#3': slow } })
    assert.deepEqual(await flush('m1', '#3 now\n', true), {})
    assert.deepEqual(invalidated, [])
    release()
    await tick()
    await tick()
    assert.deepEqual(invalidated, ['ui.render'])
    assert.match(flatten(await draw('#3 now\n')), /#3 Slow one/)
  })

  test('a title already cached shows from the first reading, with one redraw', async () => {
    const { flush, invalidated } = engine({ cache: { 'o/r#5': 'Cached' } })
    assert.match(plain((await flush('m1', '#5\n', true)).displayContent), /#5 Cached/)
    assert.deepEqual(invalidated, ['ui.render'])
  })

  test('the first draw of a block shows it as Claude Code draws it, and never waits for lntt', async () => {
    const { draw } = engine({ lntt: () => new Promise(() => {}) })
    assert.equal(await draw('See #1'), 'BLOCK')
  })

  test('the box is drawn with the elements of the surface, with no terminal sequence in a text', async () => {
    const { draw, flush } = engine({ gh: { 'o/r#138': 'Publish\u001b[2m lntt' } })
    await flush('m1', 'See #138\n', true)
    const tree = await draw('See #138\n')
    assert.equal(tree.type, 'Box')
    assert.equal(tree.props.children[0], 'BLOCK')
    assert.ok(flatten(tree).includes('Publish[2m lntt'))
    assert.ok(!flatten(tree).includes('\u001b'))
    const row = tree.props.children[2]
    assert.equal(row.type, 'Box')
    assert.deepEqual(
      row.props.children.map((t) => [t.props.children[0], t.props.dimColor]),
      [['│ ', true], ['#138 ', false], ['Publish[2m lntt', true]],
    )
  })

  test(`the session remembers the last ${KEPT} blocks: an older one is read again when drawn`, async () => {
    const { draw, runs } = engine({ gh: { 'o/r#1': 'One' } })
    const cachedRuns = () => runs.filter((r) => r.argv[2] === '--cached').length
    for (let i = 0; i <= KEPT; i += 1) {
      await draw(`block ${i} #1`)
      for (let t = 0; t < 10; t += 1) await tick()
    }
    assert.equal(cachedRuns(), KEPT + 1)
    await draw('block 0 #1')
    for (let t = 0; t < 10; t += 1) await tick()
    assert.equal(cachedRuns(), KEPT + 2)
  })

  test('the notice stays on its block when it is drawn again, and no other block carries it', async () => {
    const { draw, flush } = engine({ local: false, lntt: () => Promise.reject(new Error('spawn lntt ENOENT')) })
    await flush('m1', '#1 first\n', true)
    assert.match(plain(flatten(await draw('#1 first\n'))), /issue titles off: lntt is not installed/)
    assert.match(plain(flatten(await draw('#1 first\n'))), /issue titles off: lntt is not installed/)
    await flush('m2', '#2 second\n', true)
    assert.equal(await draw('#2 second\n'), 'BLOCK')
  })

  test('the end of a turn tells the plugin its first message ended, and goes on to the hooks beneath', async () => {
    const { hooks, $, ended } = engine()
    assert.equal(ended.length, 0)
    const result = await hooks['turn.complete'].hook($, {}, async () => ({ below: true }))
    assert.equal(ended.length, 1)
    assert.deepEqual(result, { below: true })
  })

  test('a failing `ended` never stops the end of a turn', async () => {
    const { $ } = engine()
    const on = []
    issueTitles((event, matcher, hook) => (on.push([event, hook ?? matcher]), { catch: () => {} }), {
      ended: () => {
        throw new Error('boom')
      },
    })
    const turn = on.find(([event]) => event === 'turn.complete')[1]
    assert.deepEqual(await turn($, {}, async () => ({ below: true })), { below: true })
  })

  test('the hook is registered for the AssistantMessage component alone', () => {
    const { hooks } = engine()
    assert.deepEqual(hooks['ui.render'].matcher, { component: 'AssistantMessage' })
  })

  test('a block with no text, or props with no text, is drawn as Claude Code draws it', async () => {
    const { hooks, $, runs } = engine()
    for (const props of [{}, { text: 42 }, { text: null }]) {
      const e = { surface: 'terminal', component: 'AssistantMessage', props }
      assert.equal(await hooks['ui.render'].hook($, e, async () => 'BLOCK'), 'BLOCK')
    }
    assert.deepEqual(runs, [])
  })

  test('a block that fails to be read is read once: drawn again it asks lntt for nothing', async () => {
    const { draw, flush, runs } = engine({ lntt: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) })
    await flush('m1', '#1 here\n', true)
    const asked = runs.length
    await draw('#1 here\n')
    await draw('#1 here\n')
    await tick()
    assert.equal(runs.length, asked)
  })

  test('a block asleep when the titles turn off is not read', async () => {
    const { draw, settle, runs } = engine({
      hold: true,
      lntt: async () => ({ exitCode: 2, stdout: '', stderr: 'usage: lntt path' }),
    })
    await draw('first #1')
    await draw('second #2')
    await settle(1)
    assert.equal(runs.length, 1)
    await settle()
    assert.equal(runs.length, 1)
  })

  test('a block that grows drops the shorter text it began with: that one is read again if drawn', async () => {
    const { draw, runs, settle } = engine({ gh: { 'o/r#138': 'Publish lntt' } })
    const cached = () => runs.filter((r) => r.argv[2] === '--cached').length
    await draw('See #1')
    await settle()
    assert.equal(cached(), 1)
    await draw('See #138 now.')
    await settle()
    assert.equal(cached(), 2)
    await draw('See #1')
    await settle()
    assert.equal(cached(), 3)
  })

  test('a block that does not begin with the one drawn before stays kept: drawn again, it is not read again', async () => {
    const { draw, runs, settle } = engine({ gh: { 'o/r#1': 'One', 'o/r#2': 'Two' } })
    const cached = () => runs.filter((r) => r.argv[2] === '--cached').length
    await draw('See #1')
    await settle()
    await draw('Other #2')
    await settle()
    assert.equal(cached(), 2)
    await draw('See #1')
    await draw('Other #2')
    await settle()
    assert.equal(cached(), 2)
  })

  test('a number cut at the end of a text is looked up only if the block did not grow', async () => {
    const { draw, lookups, settle } = engine({ hold: true, gh: { 'o/r#1': 'One', 'o/r#138': 'Publish lntt' } })
    await draw('See #1')
    await settle()
    await draw('See #138 and more')
    await settle()
    await settle()
    assert.deepEqual(lookups(), [['o/r#138']])
  })

  test('a number at the end of a block that does not grow is looked up after one more SETTLE_MS', async () => {
    const { draw, lookups, waits, settle } = engine({ hold: true, gh: { 'o/r#5': 'Five' } })
    await draw('See #5')
    await settle()
    assert.deepEqual(lookups(), [])
    await settle()
    assert.deepEqual(lookups(), [['o/r#5']])
    assert.deepEqual(waits, [SETTLE_MS, SETTLE_MS])
    assert.match(flatten(await draw('See #5')), /#5 Five/)
  })

  test('a block that grew while it was read leaves the notice to the next one', async () => {
    let release
    const slow = () => new Promise((r) => (release = () => r('off')))
    const { draw, settle } = engine({ hold: true, auth: 1, gh: { 'o/r#1': slow } })
    await draw('See #1 now')
    await settle()
    await draw('See #1 now, and more')
    release()
    await settle(0)
    await settle()
    await settle()
    assert.match(plain(flatten(await draw('See #1 now, and more'))), /gh is not logged in/)
  })

  test('a block asleep for its last number is not looked up when the titles turned off meanwhile', async () => {
    const lntt = (argv, init) =>
      init?.stdin?.startsWith('Other')
        ? { exitCode: 2, stdout: '', stderr: 'usage: lntt path' }
        : fakeRun(argv, init, { gh: { 'o/r#7': 'Seven' } })
    const { draw, settle, lookups } = engine({ hold: true, lntt })
    await draw('See #7')
    await settle()
    await draw('Other #9 now')
    // Only the second block wakes: its lntt has no refs, the titles are off.
    await settle(1, 1)
    await settle()
    assert.deepEqual(lookups(), [])
  })

  test('a failing hook draws the block as Claude Code does', async () => {
    const { hooks, $ } = engine()
    const e = { surface: 'terminal', component: 'AssistantMessage', props: {} }
    assert.equal(await hooks['ui.render'].catcher($, e, async () => 'BLOCK'), 'BLOCK')
  })

  test('a notice that only appears, with no box, redraws the block', async () => {
    const { flush, invalidated } = engine({ local: false, lntt: () => Promise.reject(new Error('spawn lntt ENOENT')) })
    await flush('m1', '#1 first\n', true)
    assert.deepEqual(invalidated, ['ui.render'])
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
  test('the box under the block, drawn again once lntt found the title', async () => {
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
      let changed
      const redrawn = new Promise((r) => (changed = r))
      const el = (type) => (props) => ({ type, props })
      const $ = {
        process: { run },
        fs: { exists: async (p) => existsSync(p) },
        clock: { sleep: () => Promise.resolve() },
        ui: { invalidate: () => changed(), resolve: () => ({ Box: el('Box'), Text: el('Text') }) },
      }
      let hook
      issueTitles((event, matcher, h) => {
        if (event === 'ui.render') hook = h ?? matcher
        return { catch: () => {} }
      })
      const draw = () =>
        hook($, { surface: 'terminal', component: 'AssistantMessage', props: { text: 'Do #1.\n' } }, async () => 'BLOCK')
      assert.equal(await draw(), 'BLOCK')
      await redrawn
      const end = flatten(await draw())
      assert.match(end, /^BLOCK\n╭─ cited\n│ #1 One\n│ {4}https:\/\/github\.com\/o\/r\/issues\/1\n╰─$/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
