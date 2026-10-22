import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

function lntt(args: string[], { input, path }: { input?: string; path?: string } = {}) {
  return spawnSync(process.execPath, [BIN, 'refs', ...args], {
    cwd: repo,
    encoding: 'utf8',
    input: input ?? '',
    env: { ...process.env, GH_LOG: log, PATH: path ?? `${stubs}:${process.env.PATH}` },
  })
}
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

  test('an unknown option is a usage error', () => {
    const r = lntt(['--nope'])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /usage: lntt refs/)
  })
})
