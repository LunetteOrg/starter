import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let stubs: string
let repo: string
let log: string

// A fake gh: the session's repository is o/r, #1 is "One", any other issue is not
// found. Each call is logged, one line of arguments.
const GH = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
  "repo view"*) echo o/r ;;
  "api repos/o/r/issues/1 "*) printf 'One\\thttps://github.com/o/r/issues/1\\n' ;;
  *) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
esac
`

// `node`: options for node before the bin (a preload); `stdin`: a file descriptor in
// place of `input`.
function lntt(
  args: string[],
  { input, path, node = [], stdin }: { input?: string; path?: string; node?: string[]; stdin?: number } = {},
) {
  return spawnSync(process.execPath, [...node, BIN, 'refs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    input: input ?? '',
    ...(stdin === undefined ? {} : { stdio: [stdin, 'pipe', 'pipe'] }),
    env: { ...process.env, GH_LOG: log, PATH: path ?? `${stubs}:${process.env.PATH}` },
  })
}
// A fake gh in place of GH: the repository is o/r, every issue answered by `issue`.
const ghWith = (issue: string) =>
  writeFileSync(
    join(stubs, 'gh'),
    `#!/bin/sh\necho "$*" >> "$GH_LOG"\ncase "$*" in\n  "repo view"*) echo o/r ;;\n  *) ${issue} ;;\nesac\n`,
  )
const json = (r: ReturnType<typeof lntt>) => {
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}
const ghCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-refs-')))
  stubs = join(tmp, 'bin')
  repo = join(tmp, 'repo')
  log = join(tmp, 'gh.log')
  mkdirSync(stubs)
  mkdirSync(repo)
  writeFileSync(join(stubs, 'gh'), GH)
  chmodSync(join(stubs, 'gh'), 0o755)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('lntt refs', () => {
  test('references as arguments: each with its title and URL, or why it has none', () => {
    const out = json(lntt(['#1', 'o/r#9']))
    assert.equal(out.repository, 'o/r')
    assert.deepEqual(out.refs, [
      { ref: 'o/r#1', title: 'One', url: 'https://github.com/o/r/issues/1' },
      { ref: 'o/r#9', title: null, url: null, why: 'unknown' },
    ])
    assert.deepEqual(
      out.mentions.map((m: { text: string; index: number }) => [m.text, m.index]),
      [
        ['#1', 0],
        ['o/r#9', 3],
      ],
    )
  })

  test('text on stdin, with where each reference sits in it', () => {
    const input = 'Fix `#2` then [#1](https://x.org) and C#5.\n'
    const out = json(lntt([], { input }))
    assert.deepEqual(out.mentions, [
      { text: '#1', ref: 'o/r#1', index: 15, after: 33 },
      { text: 'C#5', ref: null, index: 38, after: 41 },
    ])
    assert.deepEqual(
      out.refs.map((r: { ref: string }) => r.ref),
      ['o/r#1'],
    )
  })

  test('what it found is cached in the git directory: --cached then runs no gh at all', () => {
    json(lntt(['#1']))
    assert.ok(existsSync(join(repo, '.git/lntt-issue-titles.json')))
    rmSync(log)
    const out = json(lntt(['--cached', '#1', '#9']))
    assert.deepEqual(out.refs, [
      { ref: 'o/r#1', title: 'One', url: 'https://github.com/o/r/issues/1' },
      { ref: 'o/r#9', title: null, url: null, why: 'cached' },
    ])
    assert.deepEqual(ghCalls(), [])
  })

  test('--cached with nothing cached asks gh for the repository only', () => {
    json(lntt(['--cached', '#1']))
    assert.deepEqual(
      ghCalls().map((c) => c.split(' ').slice(0, 2).join(' ')),
      ['repo view'],
    )
  })

  test('without gh: no repository, nothing looked up', () => {
    // A PATH with git alone: the directory of the real git may hold a gh too.
    rmSync(join(stubs, 'gh'))
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(stubs, 'git'))
    const out = json(lntt(['#1', 'o/r#1'], { path: stubs }))
    assert.equal(out.repository, null)
    assert.deepEqual(out.refs, [{ ref: 'o/r#1', title: null, url: null, why: 'off' }])
  })

  test('a gh lookup past its timeout failed, and its gh is killed', () => {
    ghWith('exec sleep 10')
    const started = Date.now()
    const out = json(lntt(['#1']))
    assert.ok(Date.now() - started < 8000)
    assert.deepEqual(out.refs, [{ ref: 'o/r#1', title: null, url: null, why: 'failed' }])
  })

  test('a gh lookup that exits non-zero with anything but a 404 or a login failed', () => {
    ghWith("echo 'gh: API rate limit exceeded (HTTP 403)' >&2; exit 1")
    assert.deepEqual(json(lntt(['#1'])).refs, [{ ref: 'o/r#1', title: null, url: null, why: 'failed' }])
  })

  test('the repository is asked again once remote.origin.url changes', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: repo })
    json(lntt(['--cached', '#1']))
    rmSync(log)
    json(lntt(['--cached', '#1']))
    assert.deepEqual(ghCalls(), [])
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:o/other.git'], { cwd: repo })
    json(lntt(['--cached', '#1']))
    assert.deepEqual(
      ghCalls().map((c) => c.split(' ').slice(0, 2).join(' ')),
      ['repo view'],
    )
  })

  test('no text and a terminal on stdin: a usage error, nothing read', () => {
    const r = lntt([], { node: ['--import', 'data:text/javascript,process.stdin.isTTY=true'] })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /give the text, or pipe it on stdin/)
    assert.deepEqual(ghCalls(), [])
  })

  test('a text that cannot be read: one line on stderr, exit 1', () => {
    const fd = openSync(repo, 'r')
    try {
      const r = lntt([], { stdin: fd })
      assert.equal(r.status, 1)
      assert.match(r.stderr, /^lntt refs: EISDIR\b.*\n$/)
      assert.equal(r.stdout, '')
    } finally {
      closeSync(fd)
    }
  })

  test('a text that starts with - goes after --', () => {
    const out = json(lntt(['--', '-see #1']))
    assert.deepEqual(
      out.mentions.map((m: { text: string }) => m.text),
      ['#1'],
    )
  })

  test('an unknown option is a usage error', () => {
    const r = lntt(['--nope'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /usage: lntt refs/)
  })
})
