import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, beforeEach, describe, it } from '@effect/vitest'
import {
  CACHE_FILE,
  DAY,
  entry,
  GH_TIMEOUT_MS,
  LOOKUPS_AT_ONCE,
  type Mention,
  mentions,
  type RefsRun,
  resolveRefs,
} from './refs.ts'

const HOME = 'o/r'
const url = (n: number, repo = HOME) => `https://github.com/${repo}/issues/${n}`
const k = (n: number, repo = HOME) => `${repo}#${n}`
// The library's resolveRefs (its Promise form, over a RefsRun and this machine's file system) and
// the plain logic of src/refs.ts. src/refs/resolve.spec.ts runs the Effect form on in-memory layers.

// The references a text cites, in order, once each: what a lookup is asked.
const refsIn = (text: string, repository: string | null = HOME) => [
  ...new Set(mentions(text, repository).flatMap((m) => (m.ref ? [m.ref] : []))),
]

describe('the numbers a message cites', () => {
  it('each #N outside code, once', () => {
    assert.deepStrictEqual(refsIn('do #138, then #134 and #138 again\n'), [k(138), k(134)])
  })

  it('#0 is not a reference: GitHub numbers from 1', () => {
    assert.deepStrictEqual(refsIn('#0 and #01 and #10\n'), [k(10)])
  })

  it('not inside a code span, a fence, a URL or an HTML entity', () => {
    const text = 'see `#12` and https://x.org/issues/9#13 and &#39;\n```\n#14\n```\n'
    assert.deepStrictEqual(mentions(text, HOME), [])
  })

  it('a fence opened earlier in the text keeps what follows as code, until it closes', () => {
    assert.deepStrictEqual(refsIn('```sh\ngh issue view #138\n```\nNow #134.\n'), [k(134)])
  })

  it('each mention says where the reference starts and where a title would go', () => {
    const text = 'Start with #138, then [#134](https://x.org/1) and o/r#7.'
    const at = (s: string) => text.indexOf(s)
    assert.deepStrictEqual(mentions(text, HOME), [
      { text: '#138', ref: k(138), index: at('#138'), after: at('#138') + 4 },
      { text: '#134', ref: k(134), index: at('#134'), after: at(') and') + 1 },
      { text: 'o/r#7', ref: k(7), index: at('o/r#7'), after: text.length - 1 },
    ])
  })

  it('positions count UTF-16 units of the whole text, across lines', () => {
    const text = 'é 👨‍👩‍👧\n`x` then #5'
    const [m] = mentions(text, HOME) as [Mention]
    assert.strictEqual(text.slice(m.index, m.after), '#5')
  })
})

describe('references to other repositories', () => {
  it('owner/repo#N is that repository; repo#N is a reference only for the session repository', () => {
    assert.deepStrictEqual(refsIn('r#5, x/pelion#3, starter#94 and #65\n'), [k(5), k(3, 'x/pelion')])
  })

  it('after a reference to another repository, a bare #N cannot be told: it may mean either', () => {
    const found = mentions('#65 first, then x/pelion#3, then #65 and #7 again.\n', HOME)
    assert.deepStrictEqual(
      found.map((m) => [m.text, m.ref]),
      [
        ['#65', k(65)],
        ['x/pelion#3', k(3, 'x/pelion')],
        ['#65', null],
        ['#7', null],
      ],
    )
  })

  it('a reference to another repository on an earlier line keeps the next lines bare', () => {
    assert.deepStrictEqual(refsIn('see x/pelion#3\nthen #7\n'), [k(3, 'x/pelion')])
  })

  it('a reference to the session repository written in full does not make the text foreign', () => {
    assert.deepStrictEqual(refsIn('o/r#7 then #8\n'), [k(7), k(8)])
  })

  it('without the session repository, only owner/repo#N is read', () => {
    assert.deepStrictEqual(refsIn('#5, r#6 and o/r#7\n', null), [k(7)])
  })

  it('without the session repository, a bare #N after any reference stays unknown', () => {
    assert.deepStrictEqual(refsIn('see x/pelion#3\nthen #8\n', null), [k(3, 'x/pelion')])
  })
})

describe('what is not a reference to another repository', () => {
  it('a short word before # makes no reference, and leaves the text as it was: C#5, F#1, PR#2', () => {
    assert.deepStrictEqual(refsIn('C#5, F#1, PR#2, ui#4, 3d-engine#6 and #7\n'), [k(7)])
  })

  it('a word#N that is no reference is still a mention, with no ref', () => {
    assert.deepStrictEqual(mentions('C#5 here', HOME), [{ text: 'C#5', ref: null, index: 0, after: 3 }])
  })

  it('a word that may be another repository makes no reference, and keeps later bare numbers bare', () => {
    assert.deepStrictEqual(refsIn('starter#94 and #7\n'), [])
  })

  for (const word of ['issue', 'fix', 'jira', 'v1.2', 'next.js', 'café', 'naïve']) {
    it(`${word}#3 makes no reference, and the #7 after it stays bare`, () => {
      assert.deepStrictEqual(refsIn(`${word}#3 and #7\n`), [])
    })
  }

  it('. and .. are never a name', () => {
    assert.deepStrictEqual(refsIn('x/..#5 and ../r#6 then #7\n'), [k(7)])
  })

  it('names are not case-sensitive: O/R#7 and R#9 are the session repository', () => {
    assert.deepStrictEqual(refsIn('O/R#7, R#9\n'), [k(7), k(9)])
  })
})

describe('references in Markdown links', () => {
  it('a reference just before a link: its title goes beside it', () => {
    const [m] = mentions('#138[a](u) end\n', HOME) as [Mention]
    assert.strictEqual(m.after, 4)
  })

  it('a link whose text holds code is still found, and the title goes after it', () => {
    const text = '[`x` #138](https://x.org/1) end\n'
    const [m] = mentions(text, HOME) as [Mention]
    assert.strictEqual(m.ref, k(138))
    assert.strictEqual(m.after, text.indexOf(' end'))
  })

  it("a link's URL is not read for references", () => {
    assert.deepStrictEqual(mentions('[here](https://x.org/a#134) and [docs](https://x.org/b/#138)\n', HOME), [])
  })
})

describe('what a lookup gave, made safe to show', () => {
  it('control characters in a title are dropped, so it cannot write to the terminal', () => {
    assert.deepStrictEqual(entry('ok\u001b]0;pwned\u0007 title', url(6)), { title: 'ok]0;pwned title', url: url(6) })
  })

  it('characters that reorder or hide text are dropped too, at both ends of each range', () => {
    const hidden = [
      0x0, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069,
      0xfe00, 0xfe0f, 0xfeff, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0xe01ef,
    ]
    for (const cp of hidden) {
      assert.deepStrictEqual(
        entry(`a${String.fromCodePoint(cp)}b`, url(6)),
        { title: 'ab', url: url(6) },
        cp.toString(16),
      )
      assert.strictEqual(entry('ok', `https://x.org/1${String.fromCodePoint(cp)}`), null, cp.toString(16))
    }
    for (const cp of [0x20, 0xa0, 0x200a, 0x2030, 0xfdff, 0xfe10, 0xe0200]) {
      assert.strictEqual(
        entry(`a${String.fromCodePoint(cp)}b`, url(6))?.title,
        `a${String.fromCodePoint(cp)}b`,
        cp.toString(16),
      )
    }
  })

  it('a title of control characters only, or a URL that is not plain https, gives nothing', () => {
    assert.strictEqual(entry('\u001b\u0007', url(6)), null)
    assert.strictEqual(entry('ok', 'http://x.org/1'), null)
    assert.strictEqual(entry('ok', 'https://x.org/1\u001b[2m'), null)
    assert.strictEqual(entry('ok', 'https://x.org/a b'), null)
    assert.strictEqual(entry('ok', undefined), null)
  })
})

// A fake machine: git answers the git directory (or fails) and the remotes gh resolves
// from (`remotes`: their config lines, an exit code or an Error to throw), gh answers
// `repo view` from `home` and each issue from `gh` (by owner/repo#N: a result, an Error
// to throw, or a function returning a promise). `now` is the clock. Every command run is
// recorded.
type Answer = { exitCode: number; stdout: string; stderr: string } | Error | (() => Promise<unknown>)
const ok = (title: string, n: number, repo = HOME) => ({
  exitCode: 0,
  stdout: `${title}\t${url(n, repo)}\n`,
  stderr: '',
})
const notFound = { exitCode: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
const missing = () => Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
const NOW = 10 * DAY
const REMOTES = 'remote.origin.url git@github.com:o/r.git\n'
const REMOTES_ARGS = ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']
// What the cache keeps of the remotes: the sha256 of what git prints, without its last newline,
// never the text.
const digest = (text: string) => createHash('sha256').update(text.trimEnd()).digest('hex')

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lntt-refs-'))
  file = join(dir, CACHE_FILE)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function machine({
  gh = {} as Record<string, Answer>,
  home = 'o/r' as string | number | Error,
  git = 0,
  remotes = REMOTES as string | number | Error,
  now = () => NOW,
}: {
  gh?: Record<string, Answer>
  home?: string | number | Error
  git?: number
  remotes?: string | number | Error
  now?: () => number
} = {}) {
  const runs: { command: string; args: string[]; timeoutMs: number }[] = []
  const run: RefsRun = async (command, args, timeoutMs) => {
    runs.push({ command, args, timeoutMs })
    if (command === 'git' && args[0] === 'config') {
      if (remotes instanceof Error) throw remotes
      if (typeof remotes === 'number') return { exitCode: remotes, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: remotes, stderr: '' }
    }
    if (command === 'git') return { exitCode: git, stdout: git ? '' : `${dir}\n`, stderr: '' }
    if (args[0] === 'repo') {
      if (home instanceof Error) throw home
      if (typeof home === 'number') return { exitCode: home, stdout: '', stderr: 'no git remotes found' }
      return { exitCode: 0, stdout: `${home}\n`, stderr: '' }
    }
    const [, repo, n] = (args[1] as string).match(/^repos\/(.+)\/issues\/(\d+)$/) as string[]
    const answer = gh[`${repo}#${n}`] ?? notFound
    if (answer instanceof Error) throw answer
    return (typeof answer === 'function' ? await answer() : answer) as Awaited<ReturnType<RefsRun>>
  }
  const lookups = () => runs.filter((r) => r.args[0] === 'api').map((r) => r.args[1])
  const resolve = (text: string, cached = false) => resolveRefs(text, { run, now, cached })
  return { resolve, runs, lookups }
}

const cache = (entries: Record<string, unknown>) => writeFileSync(file, JSON.stringify(entries))
const cachedEntry = (title: string, n: number, at = NOW) => ({ title, url: url(n), at })

describe('looking a reference up', () => {
  it('the title and URL gh gives, each reference once, in the order cited', async () => {
    const { resolve, lookups } = machine({
      gh: { [k(138)]: ok('Publish lntt', 138), [k(3, 'x/p')]: ok('Three', 3, 'x/p') },
    })
    const out = await resolve('#138 and x/p#3 and #138')
    assert.strictEqual(out.repository, HOME)
    assert.deepStrictEqual(out.refs, [
      { ref: k(138), title: 'Publish lntt', url: url(138) },
      { ref: k(3, 'x/p'), title: 'Three', url: url(3, 'x/p') },
    ])
    assert.deepStrictEqual(lookups(), ['repos/o/r/issues/138', 'repos/x/p/issues/3'])
    assert.strictEqual(out.mentions.length, 3)
  })

  it('the lookups of one call run together', async () => {
    let started = 0
    const both = () => {
      started += 1
      return new Promise((r) => setImmediate(() => r(started === 2 ? ok('Both', 1) : ok('Alone', 1))))
    }
    const { resolve } = machine({ gh: { [k(1)]: both, [k(2)]: both } })
    const out = await resolve('#1 #2')
    assert.deepStrictEqual(
      out.refs.map((r) => r.title),
      ['Both', 'Both'],
    )
  })

  it(`at most ${LOOKUPS_AT_ONCE} lookups run at once`, async () => {
    let running = 0
    let most = 0
    const slow = () => {
      running += 1
      most = Math.max(most, running)
      return new Promise((r) =>
        setImmediate(() => {
          running -= 1
          r(ok('Slow', 1))
        }),
      )
    }
    const ns = Array.from({ length: LOOKUPS_AT_ONCE * 2 + 1 }, (_, i) => i + 1)
    const { resolve, lookups } = machine({ gh: Object.fromEntries(ns.map((n) => [k(n), slow])) })
    const out = await resolve(ns.map((n) => `#${n}`).join(' '))
    assert.strictEqual(LOOKUPS_AT_ONCE, 6)
    assert.strictEqual(most, LOOKUPS_AT_ONCE)
    assert.strictEqual(lookups().length, ns.length)
    assert.deepStrictEqual(
      out.refs.map((r) => r.ref),
      ns.map((n) => k(n)),
    )
  })

  it('every gh call has the timeout', async () => {
    const { resolve, runs } = machine({ gh: { [k(1)]: ok('One', 1) } })
    await resolve('#1')
    const gh = runs.filter((r) => r.command === 'gh')
    assert.deepStrictEqual(
      gh.map((r) => r.args[0]),
      ['repo', 'api'],
    )
    for (const r of gh) assert.strictEqual(r.timeoutMs, GH_TIMEOUT_MS)
  })

  for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: This issue was deleted (HTTP 410)']) {
    it(`"${stderr}" means the number is not there: unknown, and not cached`, async () => {
      const { resolve } = machine({ gh: { [k(7)]: { exitCode: 1, stdout: '', stderr } } })
      assert.deepStrictEqual((await resolve('#7')).refs, [{ ref: k(7), title: null, url: null, why: 'unknown' }])
      assert.strictEqual(JSON.parse(readFileSync(file, 'utf8'))[k(7)], undefined)
    })
  }

  it('an answer that is not safe to show is unknown', async () => {
    const { resolve } = machine({ gh: { [k(4)]: { exitCode: 0, stdout: 'Title\thttp://x.org/4\n', stderr: '' } } })
    assert.deepStrictEqual((await resolve('#4')).refs[0], { ref: k(4), title: null, url: null, why: 'unknown' })
  })

  it('an HTTP status that only starts like 404 is a failure, not a missing issue', async () => {
    const { resolve } = machine({ gh: { [k(7)]: { exitCode: 1, stdout: '', stderr: 'gh: HTTP 4040' } } })
    assert.deepStrictEqual((await resolve('#7')).refs[0], { ref: k(7), title: null, url: null, why: 'failed' })
  })

  for (const [label, stderr] of [
    ['gh auth login', 'To get started with GitHub CLI, please run:  gh auth login'],
    ['HTTP 401', 'gh: Bad credentials (HTTP 401)'],
  ]) {
    it(`gh not logged in (${label}) turns the lookups off`, async () => {
      const { resolve } = machine({ gh: { [k(1)]: { exitCode: 4, stdout: '', stderr } } })
      assert.deepStrictEqual((await resolve('#1')).refs, [{ ref: k(1), title: null, url: null, why: 'off' }])
    })
  }

  it('a rate limit, a timeout or the network is a failure, asked again at the next call', async () => {
    const answer = { exitCode: 1, stdout: 'Title\thttps://github.com/o/r/issues/8', stderr: 'API rate limit exceeded' }
    const { resolve, lookups } = machine({ gh: { [k(8)]: answer, [k(9)]: new Error('timed out') } })
    assert.deepStrictEqual(
      (await resolve('#8 #9')).refs.map((r) => 'why' in r && r.why),
      ['failed', 'failed'],
    )
    await resolve('#8 #9')
    assert.strictEqual(lookups().length, 4)
  })

  it('gh missing: lookups off', async () => {
    const { resolve } = machine({ gh: { [k(1)]: missing() } })
    cache({ repository: { name: HOME, at: NOW } })
    assert.deepStrictEqual((await resolve('#1')).refs, [{ ref: k(1), title: null, url: null, why: 'off' }])
  })

  it('--cached asks gh for no issue: what the cache lacks is "cached"', async () => {
    cache({ [k(5)]: cachedEntry('Five', 5) })
    const { resolve, lookups } = machine({ gh: { [k(6)]: ok('Six', 6) } })
    const out = await resolve('#5 and #6', true)
    assert.deepStrictEqual(out.refs, [
      { ref: k(5), title: 'Five', url: url(5) },
      { ref: k(6), title: null, url: null, why: 'cached' },
    ])
    assert.deepStrictEqual(lookups(), [])
  })
})

describe("the session's repository", () => {
  for (const [what, home] of [
    ['missing', missing()],
    ['without a GitHub remote', 1],
    ['answering ""', ''],
    ['answering garbage', 'garbage'],
    ['answering ../x', '../x'],
  ] as const) {
    it(`gh repo view ${what}: no repository, nothing looked up, no cached title read`, async () => {
      cache({ [k(5)]: cachedEntry('Cached', 5) })
      const { resolve, lookups } = machine({ gh: { [k(1)]: ok('One', 1) }, home })
      const out = await resolve('#1 and o/r#5')
      assert.strictEqual(out.repository, null)
      assert.deepStrictEqual(out.refs, [{ ref: k(5), title: null, url: null, why: 'off' }])
      assert.deepStrictEqual(lookups(), [])
    })
  }

  it('read in lower case', async () => {
    const { resolve } = machine({ gh: { [k(1)]: ok('One', 1) }, home: 'O/R' })
    assert.strictEqual((await resolve('#1')).repository, HOME)
  })

  it('cached with the titles for a day: a call that hits the cache runs no gh at all', async () => {
    cache({ [k(5)]: cachedEntry('Five', 5) })
    const first = machine()
    await first.resolve('#5', true)
    const second = machine({ home: 1 })
    const out = await second.resolve('#5', true)
    assert.strictEqual(out.repository, HOME)
    assert.deepStrictEqual(out.refs, [{ ref: k(5), title: 'Five', url: url(5) }])
    assert.deepStrictEqual(
      second.runs.map((r) => r.command),
      ['git', 'git'],
    )
  })

  it('the cached repository is used only while the remotes gh resolves it from are unchanged', async () => {
    await machine().resolve('#5', true)
    const same = machine({ home: 1 })
    assert.strictEqual((await same.resolve('#5', true)).repository, HOME)
    assert.ok(same.runs.some((r) => r.command === 'git' && r.args.join(' ') === REMOTES_ARGS.join(' ')))
    for (const remotes of [
      'remote.origin.url git@github.com:x/fork.git\nremote.upstream.url git@github.com:o/r.git\n',
      `${REMOTES}remote.origin.gh-resolved base\n`,
      1,
    ]) {
      const changed = machine({ home: 'x/fork', remotes })
      assert.strictEqual((await changed.resolve('#5', true)).repository, 'x/fork')
      assert.ok(changed.runs.some((r) => r.args[0] === 'repo'))
    }
  })

  it('with no remote, an empty list is what the cached repository is kept with', async () => {
    await machine({ remotes: 1 }).resolve('#5', true)
    assert.strictEqual(JSON.parse(readFileSync(file, 'utf8')).repository.remotes, digest(''))
  })

  for (const [what, remotes] of [
    ['exits 128', 128],
    ['throws', new Error('timed out')],
  ] as const) {
    it(`git config that ${what}: a fresh cached repository is not used, and none is written`, async () => {
      cache({ repository: { name: HOME, at: NOW - 1, remotes: digest(REMOTES) } })
      const { resolve, runs } = machine({ home: 'x/fork', remotes, gh: { [k(1, 'x/fork')]: ok('One', 1, 'x/fork') } })
      assert.strictEqual((await resolve('#1')).repository, 'x/fork')
      assert.ok(runs.some((r) => r.args[0] === 'repo'))
      const written = JSON.parse(readFileSync(file, 'utf8'))
      assert.strictEqual(written[k(1, 'x/fork')]?.title, 'One')
      assert.deepStrictEqual(written.repository, { name: HOME, at: NOW - 1, remotes: digest(REMOTES) })
    })
  }

  it('the cache holds a digest of the remotes, never their text: a URL may carry a credential', async () => {
    const remotes = 'remote.origin.url https://user:secret@github.com/o/r.git\n'
    await machine({ remotes }).resolve('#5', true)
    const text = readFileSync(file, 'utf8')
    assert.notMatch(text, /secret/)
    assert.strictEqual(JSON.parse(text).repository.remotes, digest(remotes))
  })

  it('a cached repository whose remotes are text, not a digest, is dropped: its URL may carry a credential', async () => {
    const remotes = 'remote.origin.url https://user:secret@github.com/o/r.git\n'
    cache({ repository: { name: HOME, at: NOW - 1, remotes } })
    const { resolve } = machine({ remotes: 128, gh: { [k(1)]: ok('One', 1) } })
    await resolve('#1')
    const text = readFileSync(file, 'utf8')
    assert.strictEqual(JSON.parse(text)[k(1)]?.title, 'One')
    assert.notMatch(text, /secret/)
  })

  for (const [what, remotes] of [
    ['63 hexadecimal characters', 'a'.repeat(63)],
    ['an upper-case digest', digest(REMOTES).toUpperCase()],
  ] as const) {
    it(`a cached repository whose remotes are ${what}, not a digest, is not kept`, async () => {
      cache({ repository: { name: HOME, at: NOW - 1, remotes } })
      await machine({ remotes: 128, gh: { [k(1)]: ok('One', 1) } }).resolve('#1')
      const written = JSON.parse(readFileSync(file, 'utf8'))
      assert.strictEqual(written[k(1)]?.title, 'One')
      assert.strictEqual(written.repository, undefined)
    })
  }

  it('a cached repository older than a day, or not a repository, is asked again', async () => {
    for (const repository of [
      { name: HOME, at: NOW - DAY, remotes: digest(REMOTES) },
      { name: '../x', at: NOW, remotes: digest(REMOTES) },
      { name: HOME, at: NOW },
      'o/r',
    ]) {
      cache({ repository })
      const { resolve, runs } = machine()
      assert.strictEqual((await resolve('#5', true)).repository, HOME)
      assert.ok(runs.some((r) => r.args[0] === 'repo'))
    }
  })

  it('outside a repository: no cache, no repository, nothing looked up', async () => {
    const { resolve, runs } = machine({ git: 128, gh: { [k(1)]: ok('One', 1) } })
    const out = await resolve('#1 and o/r#2')
    assert.strictEqual(out.repository, null)
    assert.deepStrictEqual(
      out.refs.map((r) => 'why' in r && r.why),
      ['off'],
    )
    assert.deepStrictEqual(
      runs.map((r) => r.command),
      ['git'],
    )
  })
})

describe('the cache', () => {
  it('a title found is written with the time it was asked, next to the repository', async () => {
    const { resolve } = machine({ gh: { [k(138)]: ok('Publish lntt', 138) } })
    await resolve('#138')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepStrictEqual(written[k(138)], { title: 'Publish lntt', url: url(138), at: NOW })
    assert.deepStrictEqual(written.repository, { name: HOME, at: NOW, remotes: digest(REMOTES) })
  })

  it('a write merges with what the file holds when it is written, not when it was read', async () => {
    const slow = () =>
      new Promise((r) => {
        cache({ [k(2)]: cachedEntry('Two', 2) })
        r(ok('One', 1))
      })
    const { resolve } = machine({ gh: { [k(1)]: slow } })
    await resolve('#1')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepStrictEqual([written[k(1)]?.title, written[k(2)]?.title], ['One', 'Two'])
  })

  it('two calls at once keep the newest entry of each key', async () => {
    let t = NOW - 10
    // #1 answers at once; while #2 is asked, another call writes a newer #1 and the
    // repository.
    const other = () =>
      new Promise((r) =>
        setImmediate(() => {
          cache({
            repository: { name: 'o/r', at: NOW - 5, remotes: digest(REMOTES) },
            [k(1)]: cachedEntry('Newer', 1, NOW - 5),
          })
          t = NOW
          r(ok('Two', 2))
        }),
      )
    const { resolve } = machine({ gh: { [k(1)]: ok('Older', 1), [k(2)]: other }, now: () => t })
    await resolve('#1 #2')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepStrictEqual([written[k(1)]?.title, written[k(2)]?.title], ['Newer', 'Two'])
    assert.strictEqual(written.repository.at, NOW - 5)
  })

  it('a write that fails still answers', async () => {
    const { resolve } = machine({ gh: { [k(1)]: ok('One', 1) } })
    rmSync(dir, { recursive: true, force: true })
    assert.strictEqual((await resolve('#1')).refs[0]?.title, 'One')
  })

  it('a write that fails leaves no temporary file behind', async () => {
    mkdirSync(file)
    const { resolve } = machine({ gh: { [k(1)]: ok('One', 1) } })
    assert.strictEqual((await resolve('#1')).refs[0]?.title, 'One')
    assert.deepStrictEqual(readdirSync(dir), [CACHE_FILE])
  })

  it('a cached title younger than a day is used; an older one is asked again', async () => {
    cache({ [k(1)]: cachedEntry('Fresh', 1, NOW - DAY + 1), [k(2)]: cachedEntry('Stale', 2, NOW - DAY) })
    const { resolve, lookups } = machine({ gh: { [k(2)]: ok('Renamed', 2) } })
    const out = await resolve('#1 and #2')
    assert.deepStrictEqual(lookups(), ['repos/o/r/issues/2'])
    assert.deepStrictEqual(
      out.refs.map((r) => r.title),
      ['Fresh', 'Renamed'],
    )
  })

  it('a key that is not a lower-case owner/repo#N, a wrong shape or a time in the future is skipped', async () => {
    cache({
      'O/R#5': cachedEntry('Cached 5', 5),
      './x#6': cachedEntry('Cached 6', 6),
      '../r#7': cachedEntry('Cached 7', 7),
      'r#8': cachedEntry('Cached 8', 8),
      [k(1)]: null,
      '10': cachedEntry('Ten', 10),
      'o/r#1e1': cachedEntry('Ten', 10),
      'o/r#0x10': cachedEntry('Sixteen', 16),
      'o/r#0': cachedEntry('Zero', 0),
      [k(3)]: cachedEntry('Future', 3, NOW + 1),
      [k(4)]: { title: 'Text time', url: url(4), at: String(NOW) },
      [k(2)]: cachedEntry('Kept', 2),
    })
    const { resolve } = machine()
    const out = await resolve('#5 #6 #7 #8 #1 #10 #16 #0 #3 #4 #2', true)
    assert.deepStrictEqual(
      out.refs.filter((r) => r.title).map((r) => r.title),
      ['Kept'],
    )
  })

  it('a corrupt cache, or an entry in it that is not safe to show, reads as empty', async () => {
    cache({ [k(1)]: { title: 'Evil', url: 'https://x.org/1\u001b[2m', at: NOW } })
    assert.strictEqual((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
    writeFileSync(file, '{not json')
    assert.strictEqual((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
    writeFileSync(file, '[1, 2]')
    assert.strictEqual((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
  })
})
