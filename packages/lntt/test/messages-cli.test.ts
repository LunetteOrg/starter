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
    Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM|LNTT_)/.test(k)),
  ) as Record<string, string>
}

function lntt(args: string[], cwd = repo) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: clean() })
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

  test('works on the files already in use: a hand-written question and its .answer.md', () => {
    mkdirSync(join(box(), 'to-coordinator'), { recursive: true })
    writeFileSync(join(box(), 'to-coordinator', '20261015-090000-adr-level.md'), 'Which ADR level?\n')
    writeFileSync(join(box(), 'to-coordinator', '20261015-090000-adr-level.answer.md'), 'Level 2.\n')
    // An answered question is not listed.
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

  test('a child is addressed by its issue', () => {
    const asked = lntt([
      'ask',
      '--to',
      'child',
      '--issue',
      '84',
      '--topic',
      'hint',
      '--timeout',
      '0.1',
      '--interval',
      '0.05',
      'Try X',
    ])
    assert.equal(asked.status, 1)
    assert.ok(existsSync(join(box(), 'to-child-84')))
    assert.equal(JSON.parse(lntt(['inbox', '--as', 'child', '--issue', '84']).stdout).question, 'Try X')
    assert.equal(lntt(['inbox', '--as', 'child']).stdout, '')
  })

  test('two coordinators in one repository have a mailbox each', () => {
    lntt([
      'ask',
      '--to',
      'coordinator',
      '--theme',
      'alpha',
      '--topic',
      'q',
      '--timeout',
      '0.1',
      '--interval',
      '0.05',
      'for alpha',
    ])
    assert.equal(JSON.parse(lntt(['inbox', '--as', 'coordinator', '--theme', 'alpha']).stdout).question, 'for alpha')
    assert.equal(lntt(['inbox', '--as', 'coordinator', '--theme', 'beta']).stdout, '')
    assert.ok(existsSync(join(box(), 'to-coordinator-alpha')))
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

  test('usage errors exit 2, others exit 1 with one line', () => {
    assert.equal(lntt(['ask', 'Question without --to']).status, 2)
    assert.equal(lntt(['ask', '--to', 'coordinator', '--timeout', 'soon', 'q']).status, 2)
    const unknown = lntt(['answer', '20260101-000000-none', 'x'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /^lntt answer: no message 20260101-000000-none/)
    assert.equal(lntt(['ask', '--to', 'boss', 'q']).status, 1)
  })

  test('inbox --wait with --timeout ends with exit 1 when nothing comes', () => {
    const r = lntt(['inbox', '--as', 'coordinator', '--wait', '--interval', '0.05', '--timeout', '0.1'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no message to the coordinator/)
  })
})
