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
    Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM|LNTT_|GIT_)/.test(k)),
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

  test('a child asks the orchestrator about its issue: the issue tags the topic, inbox and answer find it', () => {
    const asked = lntt(
      [
        'ask',
        '--to',
        'orchestrator',
        '--issue',
        '84',
        '--topic',
        'limit',
        '--timeout',
        '0.1',
        '--interval',
        '0.05',
        'q',
      ],
      worktree,
    )
    assert.equal(asked.status, 1, asked.stderr)
    assert.match(asked.stderr, /no answer to \d{8}-\d{6}-issue-84-limit in 0\.1 s/)
    const listed = lntt(['inbox', '--as', 'orchestrator'])
    assert.equal(listed.status, 0, listed.stderr)
    const message = JSON.parse(listed.stdout)
    assert.equal(message.topic, 'issue-84-limit')
    assert.equal(message.path, join(box(), 'to-orchestrator', `${message.id}.md`))
    const replied = lntt(['answer', message.id, 'go'])
    assert.equal(replied.status, 0, replied.stderr)
    assert.equal(lntt(['inbox', '--as', 'orchestrator']).stdout, '')
    assert.ok(!existsSync(join(box(), 'to-child-84')))
  })

  test('a child of a theme asks its coordinator about its issue, and the coordinator answers', async () => {
    const asking = spawn(
      process.execPath,
      [
        BIN,
        'ask',
        '--to',
        'coordinator',
        '--theme',
        'alpha',
        '--issue',
        '84',
        '--interval',
        '0.05',
        '--timeout',
        '20',
        'Which base?',
      ],
      { cwd: worktree, env: clean() },
    )
    let out = ''
    asking.stdout.on('data', (d) => {
      out += d
    })
    const done = new Promise<number | null>((ok) => asking.on('close', ok))
    const listed = lntt([
      'inbox',
      '--as',
      'coordinator',
      '--theme',
      'alpha',
      '--wait',
      '--interval',
      '0.05',
      '--timeout',
      '20',
    ])
    assert.equal(listed.status, 0, listed.stderr)
    const message = JSON.parse(listed.stdout)
    assert.equal(message.topic, 'issue-84-which-base')
    assert.equal(lntt(['answer', message.id, 'main']).status, 0)
    assert.equal(await done, 0)
    assert.equal(out, 'main\n')
  })

  test('inbox --issue still narrows only a child', () => {
    assert.equal(lntt(['inbox', '--as', 'orchestrator', '--issue', '84']).status, 1)
  })

  test('ask --wait waits for the answer of a message already sent', async () => {
    const sent = lntt([
      'ask',
      '--to',
      'orchestrator',
      '--topic',
      'later',
      '--timeout',
      '0.1',
      '--interval',
      '0.05',
      'q',
    ])
    assert.equal(sent.status, 1)
    const id = JSON.parse(lntt(['inbox', '--as', 'orchestrator']).stdout).id
    const waiting = spawn(process.execPath, [BIN, 'ask', '--wait', id, '--interval', '0.05', '--timeout', '20'], {
      cwd: worktree,
      env: clean(),
    })
    let out = ''
    let err = ''
    waiting.stdout.on('data', (d) => {
      out += d
    })
    waiting.stderr.on('data', (d) => {
      err += d
    })
    const done = new Promise<number | null>((ok) => waiting.on('close', ok))
    assert.equal(lntt(['answer', id, 'Yes.']).status, 0)
    assert.equal(await done, 0, err)
    assert.equal(out, 'Yes.\n')
    assert.match(err, new RegExp(`waiting for the answer to ${id}`))
    // An answer already there is printed at once.
    const again = lntt(['ask', '--wait', `${id}.md`])
    assert.equal(again.status, 0, again.stderr)
    assert.equal(again.stdout, 'Yes.\n')
  })

  test('ask --wait finds a message sent to a child', () => {
    const dir = join(box(), 'to-child-84')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '20260101-000000-decision.md'), 'q\n')
    writeFileSync(join(dir, '20260101-000000-decision.answer.md'), 'Go.\n')
    const r = lntt(['ask', '--wait', '20260101-000000-decision'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'Go.\n')
  })

  test('ask --wait on an unknown id, or with no answer in time, exits 1', () => {
    const unknown = lntt(['ask', '--wait', '20260101-000000-none'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /^lntt ask: no message 20260101-000000-none/)
    mkdirSync(join(box(), 'to-coordinator-alpha'), { recursive: true })
    writeFileSync(join(box(), 'to-coordinator-alpha', '20261015-090000-q.md'), 'Q\n')
    const late = lntt(['ask', '--wait', '20261015-090000-q', '--timeout', '0.1', '--interval', '0.05'])
    assert.equal(late.status, 1)
    assert.match(late.stderr, /no answer to 20261015-090000-q in 0\.1 s/)
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

  test('ask --wait on an id in two directories exits 1: it names more than one message', () => {
    for (const dir of ['to-orchestrator', 'to-coordinator-alpha']) {
      mkdirSync(join(box(), dir), { recursive: true })
      writeFileSync(join(box(), dir, '20261015-090000-q.md'), 'Q\n')
    }
    const r = lntt(['ask', '--wait', '20261015-090000-q', '--timeout', '0.1', '--interval', '0.05'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lntt ask: 20261015-090000-q names more than one message: /)
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
