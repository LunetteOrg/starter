import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let repo: string
let worktree: string

function clean(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM|LNTT_|GIT_)/.test(k)),
  ) as Record<string, string>
}

function lntt(args: string[], cwd = repo) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: clean(), timeout: 30_000 })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-messages-cli-')))
  repo = join(tmp, 'repo')
  worktree = join(tmp, 'linked')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git('worktree', 'add', '-q', '-b', 'other', worktree)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const box = () => join(repo, '.git', 'lntt-messages')

// The branch `other` is checked out in `worktree`: a child that reports to a role with a marker
// on it is alive. Written long ago, as a started child's is: a marker younger than a minute is a
// start in progress, live and never cleared.
function marker(branch: string, to = 'orchestrator', extra: object = {}) {
  mkdirSync(join(box(), 'started'), { recursive: true })
  const file = join(box(), 'started', `${encodeURIComponent(branch)}.json`)
  writeFileSync(file, `${JSON.stringify({ branch, issue: 7, to, ...extra })}\n`)
  const hourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(file, hourAgo, hourAgo)
}
const markers = () => (existsSync(join(box(), 'started')) ? readdirSync(join(box(), 'started')) : [])
const removeWorktree = () => execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repo })

describe('lntt ask / inbox / answer', () => {
  test('a question from one worktree is in the inbox of another, and the answer reaches ask', async () => {
    const asking = spawn(
      process.execPath,
      [BIN, 'ask', '--to', 'coordinator', '--topic', 'order', '--interval', '0.05', 'Which PR first?'],
      { cwd: worktree, env: clean() },
    )
    let out = ''
    asking.stdout.on('data', (d) => {
      out += d
    })
    const done = new Promise<number | null>((ok) => asking.on('close', ok))

    // The coordinator waits in the main checkout; the question comes from a linked worktree.
    marker('other', 'coordinator', { theme: 'alpha' })
    const listed = lntt(['inbox', '--as', 'coordinator', '--wait', '--interval', '0.05', '--timeout', '20'])
    assert.equal(listed.status, 0, listed.stderr)
    const [first, ...others] = listed.stdout.trim().split('\n')
    assert.equal(others.length, 0)
    const message = JSON.parse(first as string)
    assert.equal(message.question, 'Which PR first?')
    assert.equal(message.topic, 'order')
    assert.equal(message.path, join(box(), 'to-coordinator', `${message.id}.md`))

    const replied = lntt(['answer', message.id, 'The CLI one.'])
    assert.equal(replied.status, 0, replied.stderr)
    assert.equal(replied.stdout.trim(), join(box(), 'to-coordinator', `${message.id}.answer.md`))

    assert.equal(await done, 0)
    assert.equal(out, 'The CLI one.\n')
    assert.equal(lntt(['inbox', '--as', 'coordinator']).stdout, '')
  })

  test('ask reads the question from stdin with -', () => {
    const asked = spawnSync(
      process.execPath,
      [BIN, 'ask', '--to', 'orchestrator', '--timeout', '0.1', '--interval', '0.05', '-'],
      {
        cwd: repo,
        encoding: 'utf8',
        env: clean(),
        input: 'A question\nover lines\n',
      },
    )
    assert.equal(asked.status, 1)
    assert.match(asked.stderr, /no answer to .* in 0\.1 s/)
    const [file] = readdirSync(join(box(), 'to-orchestrator'))
    assert.equal(readFileSync(join(box(), 'to-orchestrator', file as string), 'utf8'), 'A question\nover lines\n')
  })

  test('the role of the inbox may come from LNTT_ROLE', () => {
    mkdirSync(join(box(), 'to-orchestrator'), { recursive: true })
    writeFileSync(join(box(), 'to-orchestrator', '20261015-090000-q.md'), 'Q\n')
    const r = spawnSync(process.execPath, [BIN, 'inbox'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...clean(), LNTT_ROLE: 'orchestrator' },
    })
    assert.equal(JSON.parse(r.stdout).id, '20261015-090000-q')
    assert.equal(lntt(['inbox']).status, 2)
  })

  test('the environment’s address applies only to the role it fits', () => {
    mkdirSync(join(box(), 'to-orchestrator'), { recursive: true })
    writeFileSync(join(box(), 'to-orchestrator', '20261015-090000-q.md'), 'Q\n')
    const r = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'orchestrator'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...clean(), LNTT_ISSUE: '84', LNTT_THEME: 'alpha' },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).id, '20261015-090000-q')
  })

  test('each role reads its own address from the environment, and ignores the other’s', () => {
    const inbox = (role: string, vars: Record<string, string>) =>
      spawnSync(process.execPath, [BIN, 'inbox', '--as', role], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...clean(), ...vars },
      })
    mkdirSync(join(box(), 'to-child-84'), { recursive: true })
    writeFileSync(join(box(), 'to-child-84', '20261015-090000-c.md'), 'for the child\n')
    mkdirSync(join(box(), 'to-coordinator-alpha'), { recursive: true })
    writeFileSync(join(box(), 'to-coordinator-alpha', '20261015-090000-k.md'), 'for the coordinator\n')
    const both = { LNTT_ISSUE: '84', LNTT_THEME: 'alpha' }
    assert.equal(JSON.parse(inbox('child', both).stdout).question, 'for the child')
    assert.equal(JSON.parse(inbox('coordinator', both).stdout).question, 'for the coordinator')
    for (const [role, vars] of [
      ['child', { LNTT_THEME: 'alpha' }],
      ['coordinator', { LNTT_ISSUE: '84' }],
    ] as const) {
      const r = inbox(role, vars)
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, '')
    }
  })

  test('outside a git repository the reason is said, not a stack', () => {
    const outside = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'coordinator'], {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...clean(), GIT_CEILING_DIRECTORIES: dirname(tmp) },
    })
    assert.equal(outside.status, 1)
    assert.match(outside.stderr, /^lntt inbox: the mailbox lives in the git common directory/)
  })

  test('ask --wait takes no question and no address', () => {
    assert.equal(lntt(['ask', '--wait', '20261015-090000-q', 'question']).status, 2)
    for (const [flag, value] of [
      ['--to', 'orchestrator'],
      ['--issue', '84'],
      ['--theme', 'alpha'],
      ['--topic', 'q'],
    ]) {
      const r = lntt(['ask', '--wait', '20261015-090000-q', flag as string, value as string])
      assert.equal(r.status, 2, `${flag}: ${r.stderr}`)
      assert.match(r.stderr, new RegExp(`--wait takes no ${flag}`))
    }
  })

  test('usage errors exit 2, others exit 1 with one line', () => {
    assert.equal(lntt(['ask', 'Question without --to']).status, 2)
    assert.equal(lntt(['ask', '--to', 'coordinator', '--timeout', 'soon', 'q']).status, 2)
    const unknown = lntt(['answer', '20260101-000000-none', 'x'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /^lntt answer: no message 20260101-000000-none/)
    assert.equal(lntt(['ask', '--to', 'boss', 'q']).status, 1)
    assert.equal(lntt(['inbox', '--as', 'orchestrator', '--follow', '--wait']).status, 2)
  })
})

// The children that can write to a mailbox are the markers of `started/` whose branch is
// still checked out in a worktree that exists: `other` is, in `worktree`, from beforeEach.
describe('lntt inbox follows the children that report to it', () => {
  const ask = (text: string, topic = 'later') =>
    lntt(['ask', '--to', 'orchestrator', '--timeout', '0.1', '--interval', '0.05', '--topic', topic, text])

  test('--wait with no live writer exits 3 at once, and clears the markers of removed worktrees', () => {
    marker('feat/gone')
    marker('other')
    removeWorktree()
    const r = lntt(['inbox', '--as', 'orchestrator', '--wait', '--interval', '5'])
    assert.equal(r.status, 3, r.stderr)
    assert.match(r.stderr, /no child reports to the orchestrator/)
    assert.deepEqual(markers(), [])
  })

  test('a mailbox outside a git directory cannot tell who is alive: exit 1 with the reason', () => {
    const outside = join(tmp, 'plain')
    mkdirSync(join(outside, 'started'), { recursive: true })
    writeFileSync(
      join(outside, 'started', 'other.json'),
      `${JSON.stringify({ branch: 'other', issue: 7, to: 'orchestrator' })}\n`,
    )
    const r = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'orchestrator', '--wait', '--interval', '0.05'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...clean(), LNTT_MESSAGES_DIR: outside },
      timeout: 30_000,
    })
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /cannot list the worktrees/)
  })

  test('--follow prints the unanswered messages at start, not the answered ones, then ends with no writer', () => {
    ask('Answered', 'answered')
    lntt(['answer', JSON.parse(lntt(['inbox', '--as', 'orchestrator']).stdout).id, 'done'])
    ask('Early')
    const r = lntt(['inbox', '--as', 'orchestrator', '--follow', '--interval', '0.05'])
    assert.equal(r.status, 3)
    assert.deepEqual(
      r.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).question),
      ['Early'],
    )
  })
})
