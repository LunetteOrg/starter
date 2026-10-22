import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  CACHE_FILE,
  DAY,
  entry,
  GH_TIMEOUT_MS,
  type Mention,
  mentions,
  type RefsRun,
  resolveRefs,
} from '../src/refs.ts'

const HOME = 'o/r'
const url = (n: number, repo = HOME) => `https://github.com/${repo}/issues/${n}`
const k = (n: number, repo = HOME) => `${repo}#${n}`
// The references a text cites, in order, once each: what a lookup is asked.
const refsIn = (text: string, repository: string | null = HOME) => [
  ...new Set(mentions(text, repository).flatMap((m) => (m.ref ? [m.ref] : []))),
]

describe('the numbers a message cites', () => {
  test('each #N outside code, once', () => {
    assert.deepEqual(refsIn('do #138, then #134 and #138 again\n'), [k(138), k(134)])
  })

  test('#0 is not a reference: GitHub numbers from 1', () => {
    assert.deepEqual(refsIn('#0 and #01 and #10\n'), [k(10)])
  })

  test('not inside a code span, a fence, a URL or an HTML entity', () => {
    const text = 'see `#12` and https://x.org/issues/9#13 and &#39;\n```\n#14\n```\n'
    assert.deepEqual(mentions(text, HOME), [])
  })

  test('a fence opened earlier in the text keeps what follows as code, until it closes', () => {
    assert.deepEqual(refsIn('```sh\ngh issue view #138\n```\nNow #134.\n'), [k(134)])
  })

  test('each mention says where the reference starts and where a title would go', () => {
    const text = 'Start with #138, then [#134](https://x.org/1) and o/r#7.'
    const at = (s: string) => text.indexOf(s)
    assert.deepEqual(mentions(text, HOME), [
      { text: '#138', ref: k(138), index: at('#138'), after: at('#138') + 4 },
      { text: '#134', ref: k(134), index: at('#134'), after: at(') and') + 1 },
      { text: 'o/r#7', ref: k(7), index: at('o/r#7'), after: text.length - 1 },
    ])
  })

  test('positions count UTF-16 units of the whole text, across lines', () => {
    const text = 'é 👨‍👩‍👧\n`x` then #5'
    const [m] = mentions(text, HOME) as [Mention]
    assert.equal(text.slice(m.index, m.after), '#5')
  })
})

describe('references to other repositories', () => {
  test('owner/repo#N is that repository; repo#N is a reference only for the session repository', () => {
    assert.deepEqual(refsIn('r#5, x/pelion#3, starter#94 and #65\n'), [k(5), k(3, 'x/pelion')])
  })

  test('after a reference to another repository, a bare #N cannot be told: it may mean either', () => {
    const found = mentions('#65 first, then x/pelion#3, then #65 and #7 again.\n', HOME)
    assert.deepEqual(
      found.map((m) => [m.text, m.ref]),
      [
        ['#65', k(65)],
        ['x/pelion#3', k(3, 'x/pelion')],
        ['#65', null],
        ['#7', null],
      ],
    )
  })

  test('a reference to another repository on an earlier line keeps the next lines bare', () => {
    assert.deepEqual(refsIn('see x/pelion#3\nthen #7\n'), [k(3, 'x/pelion')])
  })

  test('a reference to the session repository written in full does not make the text foreign', () => {
    assert.deepEqual(refsIn('o/r#7 then #8\n'), [k(7), k(8)])
  })

  test('without the session repository, only owner/repo#N is read', () => {
    assert.deepEqual(refsIn('#5, r#6 and o/r#7\n', null), [k(7)])
  })

  test('without the session repository, a bare #N after any reference stays unknown', () => {
    assert.deepEqual(refsIn('see x/pelion#3\nthen #8\n', null), [k(3, 'x/pelion')])
  })
})

describe('what is not a reference to another repository', () => {
  test('a short word before # makes no reference, and leaves the text as it was: C#5, F#1, PR#2', () => {
    assert.deepEqual(refsIn('C#5, F#1, PR#2, ui#4, 3d-engine#6 and #7\n'), [k(7)])
  })

  test('a word#N that is no reference is still a mention, with no ref', () => {
    assert.deepEqual(mentions('C#5 here', HOME), [{ text: 'C#5', ref: null, index: 0, after: 3 }])
  })

  test('a word that may be another repository makes no reference, and keeps later bare numbers bare', () => {
    assert.deepEqual(refsIn('starter#94 and #7\n'), [])
  })

  for (const word of ['issue', 'fix', 'jira', 'v1.2', 'next.js', 'café', 'naïve']) {
    test(`${word}#3 makes no reference, and the #7 after it stays bare`, () => {
      assert.deepEqual(refsIn(`${word}#3 and #7\n`), [])
    })
  }

  test('. and .. are never a name', () => {
    assert.deepEqual(refsIn('x/..#5 and ../r#6 then #7\n'), [k(7)])
  })

  test('names are not case-sensitive: O/R#7 and R#9 are the session repository', () => {
    assert.deepEqual(refsIn('O/R#7, R#9\n'), [k(7), k(9)])
  })
})

describe('references in Markdown links', () => {
  test('a reference just before a link: its title goes beside it', () => {
    const [m] = mentions('#138[a](u) end\n', HOME) as [Mention]
    assert.equal(m.after, 4)
  })

  test('a link whose text holds code is still found, and the title goes after it', () => {
    const text = '[`x` #138](https://x.org/1) end\n'
    const [m] = mentions(text, HOME) as [Mention]
    assert.equal(m.ref, k(138))
    assert.equal(m.after, text.indexOf(' end'))
  })

  test("a link's URL is not read for references", () => {
    assert.deepEqual(mentions('[here](https://x.org/a#134) and [docs](https://x.org/b/#138)\n', HOME), [])
  })
})

describe('what a lookup gave, made safe to show', () => {
  test('control characters in a title are dropped, so it cannot write to the terminal', () => {
    assert.deepEqual(entry('ok\u001b]0;pwned\u0007 title', url(6)), { title: 'ok]0;pwned title', url: url(6) })
  })

  test('characters that reorder or hide text are dropped too, at both ends of each range', () => {
    const hidden = [
      0x0, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069,
      0xfe00, 0xfe0f, 0xfeff, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0xe01ef,
    ]
    for (const cp of hidden) {
      assert.deepEqual(entry(`a${String.fromCodePoint(cp)}b`, url(6)), { title: 'ab', url: url(6) }, cp.toString(16))
      assert.equal(entry('ok', `https://x.org/1${String.fromCodePoint(cp)}`), null, cp.toString(16))
    }
    for (const cp of [0x20, 0xa0, 0x200a, 0x2030, 0xfdff, 0xfe10, 0xe0200]) {
      assert.equal(
        entry(`a${String.fromCodePoint(cp)}b`, url(6))?.title,
        `a${String.fromCodePoint(cp)}b`,
        cp.toString(16),
      )
    }
  })

  test('a title of control characters only, or a URL that is not plain https, gives nothing', () => {
    assert.equal(entry('\u001b\u0007', url(6)), null)
    assert.equal(entry('ok', 'http://x.org/1'), null)
    assert.equal(entry('ok', 'https://x.org/1\u001b[2m'), null)
    assert.equal(entry('ok', 'https://x.org/a b'), null)
    assert.equal(entry('ok', undefined), null)
  })
})

// A fake machine: git answers the git directory (or fails) and the remotes gh resolves
// from (`remotes`: their config lines, or an exit code), gh answers `repo view` from
// `home` and each issue from `gh` (by owner/repo#N: a result, an Error to throw, or a
// function returning a promise). `now` is the clock. Every command run is recorded.
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
  remotes = REMOTES as string | number,
  now = () => NOW,
}: {
  gh?: Record<string, Answer>
  home?: string | number | Error
  git?: number
  remotes?: string | number
  now?: () => number
} = {}) {
  const runs: { command: string; args: string[]; timeoutMs: number }[] = []
  const run: RefsRun = async (command, args, timeoutMs) => {
    runs.push({ command, args, timeoutMs })
    if (command === 'git' && args[0] === 'config') {
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
  test('the title and URL gh gives, each reference once, in the order cited', async () => {
    const { resolve, lookups } = machine({
      gh: { [k(138)]: ok('Publish lntt', 138), [k(3, 'x/p')]: ok('Three', 3, 'x/p') },
    })
    const out = await resolve('#138 and x/p#3 and #138')
    assert.equal(out.repository, HOME)
    assert.deepEqual(out.refs, [
      { ref: k(138), title: 'Publish lntt', url: url(138) },
      { ref: k(3, 'x/p'), title: 'Three', url: url(3, 'x/p') },
    ])
    assert.deepEqual(lookups(), ['repos/o/r/issues/138', 'repos/x/p/issues/3'])
    assert.equal(out.mentions.length, 3)
  })

  test('the lookups of one call run together', async () => {
    let started = 0
    const both = () => {
      started += 1
      return new Promise((r) => setImmediate(() => r(started === 2 ? ok('Both', 1) : ok('Alone', 1))))
    }
    const { resolve } = machine({ gh: { [k(1)]: both, [k(2)]: both } })
    const out = await resolve('#1 #2')
    assert.deepEqual(
      out.refs.map((r) => r.title),
      ['Both', 'Both'],
    )
  })

  test('every gh call has the timeout', async () => {
    const { resolve, runs } = machine({ gh: { [k(1)]: ok('One', 1) } })
    await resolve('#1')
    const gh = runs.filter((r) => r.command === 'gh')
    assert.deepEqual(
      gh.map((r) => r.args[0]),
      ['repo', 'api'],
    )
    for (const r of gh) assert.equal(r.timeoutMs, GH_TIMEOUT_MS)
  })

  for (const stderr of ['gh: Not Found (HTTP 404)', 'gh: This issue was deleted (HTTP 410)']) {
    test(`"${stderr}" means the number is not there: unknown, and not cached`, async () => {
      const { resolve } = machine({ gh: { [k(7)]: { exitCode: 1, stdout: '', stderr } } })
      assert.deepEqual((await resolve('#7')).refs, [{ ref: k(7), title: null, url: null, why: 'unknown' }])
      assert.equal(JSON.parse(readFileSync(file, 'utf8'))[k(7)], undefined)
    })
  }

  test('an answer that is not safe to show is unknown', async () => {
    const { resolve } = machine({ gh: { [k(4)]: { exitCode: 0, stdout: 'Title\thttp://x.org/4\n', stderr: '' } } })
    assert.deepEqual((await resolve('#4')).refs[0], { ref: k(4), title: null, url: null, why: 'unknown' })
  })

  test('an HTTP status that only starts like 404 is a failure, not a missing issue', async () => {
    const { resolve } = machine({ gh: { [k(7)]: { exitCode: 1, stdout: '', stderr: 'gh: HTTP 4040' } } })
    assert.deepEqual((await resolve('#7')).refs[0], { ref: k(7), title: null, url: null, why: 'failed' })
  })

  for (const [label, stderr] of [
    ['gh auth login', 'To get started with GitHub CLI, please run:  gh auth login'],
    ['HTTP 401', 'gh: Bad credentials (HTTP 401)'],
  ]) {
    test(`gh not logged in (${label}) turns the lookups off`, async () => {
      const { resolve } = machine({ gh: { [k(1)]: { exitCode: 4, stdout: '', stderr } } })
      assert.deepEqual((await resolve('#1')).refs, [{ ref: k(1), title: null, url: null, why: 'off' }])
    })
  }

  test('a rate limit, a timeout or the network is a failure, asked again at the next call', async () => {
    const answer = { exitCode: 1, stdout: 'Title\thttps://github.com/o/r/issues/8', stderr: 'API rate limit exceeded' }
    const { resolve, lookups } = machine({ gh: { [k(8)]: answer, [k(9)]: new Error('timed out') } })
    assert.deepEqual(
      (await resolve('#8 #9')).refs.map((r) => 'why' in r && r.why),
      ['failed', 'failed'],
    )
    await resolve('#8 #9')
    assert.equal(lookups().length, 4)
  })

  test('gh missing: lookups off', async () => {
    const { resolve } = machine({ gh: { [k(1)]: missing() } })
    cache({ repository: { name: HOME, at: NOW } })
    assert.deepEqual((await resolve('#1')).refs, [{ ref: k(1), title: null, url: null, why: 'off' }])
  })

  test('--cached asks gh for no issue: what the cache lacks is "cached"', async () => {
    cache({ [k(5)]: cachedEntry('Five', 5) })
    const { resolve, lookups } = machine({ gh: { [k(6)]: ok('Six', 6) } })
    const out = await resolve('#5 and #6', true)
    assert.deepEqual(out.refs, [
      { ref: k(5), title: 'Five', url: url(5) },
      { ref: k(6), title: null, url: null, why: 'cached' },
    ])
    assert.deepEqual(lookups(), [])
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
    test(`gh repo view ${what}: no repository, nothing looked up, no cached title read`, async () => {
      cache({ [k(5)]: cachedEntry('Cached', 5) })
      const { resolve, lookups } = machine({ gh: { [k(1)]: ok('One', 1) }, home })
      const out = await resolve('#1 and o/r#5')
      assert.equal(out.repository, null)
      assert.deepEqual(out.refs, [{ ref: k(5), title: null, url: null, why: 'off' }])
      assert.deepEqual(lookups(), [])
    })
  }

  test('read in lower case', async () => {
    const { resolve } = machine({ gh: { [k(1)]: ok('One', 1) }, home: 'O/R' })
    assert.equal((await resolve('#1')).repository, HOME)
  })

  test('cached with the titles for a day: a call that hits the cache runs no gh at all', async () => {
    cache({ [k(5)]: cachedEntry('Five', 5) })
    const first = machine()
    await first.resolve('#5', true)
    const second = machine({ home: 1 })
    const out = await second.resolve('#5', true)
    assert.equal(out.repository, HOME)
    assert.deepEqual(out.refs, [{ ref: k(5), title: 'Five', url: url(5) }])
    assert.deepEqual(
      second.runs.map((r) => r.command),
      ['git', 'git'],
    )
  })

  test('the cached repository is used only while the remotes gh resolves it from are unchanged', async () => {
    await machine().resolve('#5', true)
    const same = machine({ home: 1 })
    assert.equal((await same.resolve('#5', true)).repository, HOME)
    assert.ok(same.runs.some((r) => r.command === 'git' && r.args.join(' ') === REMOTES_ARGS.join(' ')))
    for (const remotes of [
      'remote.origin.url git@github.com:x/fork.git\nremote.upstream.url git@github.com:o/r.git\n',
      `${REMOTES}remote.origin.gh-resolved base\n`,
      1,
    ]) {
      const changed = machine({ home: 'x/fork', remotes })
      assert.equal((await changed.resolve('#5', true)).repository, 'x/fork')
      assert.ok(changed.runs.some((r) => r.args[0] === 'repo'))
    }
  })

  test('with no remote, an empty list is what the cached repository is kept with', async () => {
    await machine({ remotes: 1 }).resolve('#5', true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).repository.remotes, '')
  })

  test('a cached repository older than a day, or not a repository, is asked again', async () => {
    for (const repository of [
      { name: HOME, at: NOW - DAY, remotes: REMOTES },
      { name: '../x', at: NOW, remotes: REMOTES },
      { name: HOME, at: NOW },
      'o/r',
    ]) {
      cache({ repository })
      const { resolve, runs } = machine()
      assert.equal((await resolve('#5', true)).repository, HOME)
      assert.ok(runs.some((r) => r.args[0] === 'repo'))
    }
  })

  test('outside a repository: no cache, no repository, nothing looked up', async () => {
    const { resolve, runs } = machine({ git: 128, gh: { [k(1)]: ok('One', 1) } })
    const out = await resolve('#1 and o/r#2')
    assert.equal(out.repository, null)
    assert.deepEqual(
      out.refs.map((r) => 'why' in r && r.why),
      ['off'],
    )
    assert.deepEqual(
      runs.map((r) => r.command),
      ['git'],
    )
  })
})

describe('the cache', () => {
  test('a title found is written with the time it was asked, next to the repository', async () => {
    const { resolve } = machine({ gh: { [k(138)]: ok('Publish lntt', 138) } })
    await resolve('#138')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(written[k(138)], { title: 'Publish lntt', url: url(138), at: NOW })
    assert.deepEqual(written.repository, { name: HOME, at: NOW, remotes: REMOTES })
  })

  test('a write merges with what the file holds when it is written, not when it was read', async () => {
    const slow = () =>
      new Promise((r) => {
        cache({ [k(2)]: cachedEntry('Two', 2) })
        r(ok('One', 1))
      })
    const { resolve } = machine({ gh: { [k(1)]: slow } })
    await resolve('#1')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual([written[k(1)]?.title, written[k(2)]?.title], ['One', 'Two'])
  })

  test('two calls at once keep the newest entry of each key', async () => {
    let t = NOW - 10
    // #1 answers at once; while #2 is asked, another call writes a newer #1 and the
    // repository.
    const other = () =>
      new Promise((r) =>
        setImmediate(() => {
          cache({
            repository: { name: 'o/r', at: NOW - 5, remotes: REMOTES },
            [k(1)]: cachedEntry('Newer', 1, NOW - 5),
          })
          t = NOW
          r(ok('Two', 2))
        }),
      )
    const { resolve } = machine({ gh: { [k(1)]: ok('Older', 1), [k(2)]: other }, now: () => t })
    await resolve('#1 #2')
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual([written[k(1)]?.title, written[k(2)]?.title], ['Newer', 'Two'])
    assert.equal(written.repository.at, NOW - 5)
  })

  test('a write that fails still answers', async () => {
    const { resolve } = machine({ gh: { [k(1)]: ok('One', 1) } })
    rmSync(dir, { recursive: true, force: true })
    assert.equal((await resolve('#1')).refs[0]?.title, 'One')
  })

  test('a cached title younger than a day is used; an older one is asked again', async () => {
    cache({ [k(1)]: cachedEntry('Fresh', 1, NOW - DAY + 1), [k(2)]: cachedEntry('Stale', 2, NOW - DAY) })
    const { resolve, lookups } = machine({ gh: { [k(2)]: ok('Renamed', 2) } })
    const out = await resolve('#1 and #2')
    assert.deepEqual(lookups(), ['repos/o/r/issues/2'])
    assert.deepEqual(
      out.refs.map((r) => r.title),
      ['Fresh', 'Renamed'],
    )
  })

  test('a key that is not a lower-case owner/repo#N, a wrong shape or a time in the future is skipped', async () => {
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
    assert.deepEqual(
      out.refs.filter((r) => r.title).map((r) => r.title),
      ['Kept'],
    )
  })

  test('a corrupt cache, or an entry in it that is not safe to show, reads as empty', async () => {
    cache({ [k(1)]: { title: 'Evil', url: 'https://x.org/1\u001b[2m', at: NOW } })
    assert.equal((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
    writeFileSync(file, '{not json')
    assert.equal((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
    writeFileSync(file, '[1, 2]')
    assert.equal((await machine({ gh: { [k(1)]: ok('Good', 1) } }).resolve('#1')).refs[0]?.title, 'Good')
  })
})
