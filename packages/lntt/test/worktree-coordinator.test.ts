import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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

const ISSUES: Record<string, { title: string; labels: { name: string }[] }> = {
  '84': { title: 'Coordinator mode: a theme parent delegates', labels: [{ name: 'enhancement' }] },
  '89': { title: 'Board status for released issues', labels: [{ name: 'enhancement' }] },
}

const CONFIG = `{
  "coordinator": {
    "gate": "propose",
    "models": {
      "coordinator": { "model": "sonnet" },
      "children": { "S": { "model": "sonnet" }, "M": { "model": "opus", "effort": "high" } }
    }
  }
}`

let tmp: string
let repo: string
let log: string

// Fake `orca` (records every call, answers a worktree create) and `gh` (the issues).
function stubs(dir: string): void {
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'orca'),
    `#!/usr/bin/env node
const args = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (process.env.FAKE_ORCA_FAIL && args[1] === 'create' && !args.includes('--help')) { console.error('orca: the terminal did not start'); process.exit(1) }
if (args.includes('--help')) console.log('Usage: orca worktree create --name <n> [--model <id>] [--effort <level>] [--parent-worktree <s>]')
else console.log(JSON.stringify({ result: { worktree: { path: '/orca/' + args[args.indexOf('--name') + 1] }, launch: { outcome: { handle: 'term_1' } } } }))
`,
  )
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const issues = ${JSON.stringify(ISSUES)}
const n = process.argv.at(-1).split('/').at(-1)
console.log(JSON.stringify({ number: Number(n), ...issues[n], type: null }))
`,
  )
  chmodSync(join(dir, 'orca'), 0o755)
  chmodSync(join(dir, 'gh'), 0o755)
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM|LNTT_)/.test(k)),
  )
  return { ...clean, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, LNTT_POLL_SECONDS: '0.05', ...extra } as Record<
    string,
    string
  >
}

function lntt(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [BIN, 'worktree', 'start', '--host', 'orca', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: env(extra),
    timeout: 30_000,
  })
}

// The `orca worktree create` calls so far.
function creates(): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] === 'worktree' && a[1] === 'create' && !a.includes('--help'))
}

const after = (call: string[], flag: string) => call[call.indexOf(flag) + 1]
const mailbox = () => join(repo, '.git', 'lntt-messages')
// The one start marker in the mailbox, under its branch's URL-encoded name.
// A theme's coordinator leaves its own marker, on no issue; a child's is the other one.
const started = (of: 'child' | 'coordinator' = 'child') => {
  const markers = readdirSync(join(mailbox(), 'started')).map((file) => {
    const marker = JSON.parse(readFileSync(join(mailbox(), 'started', file), 'utf8'))
    assert.equal(file, `${encodeURIComponent(marker.branch)}.json`)
    return marker
  })
  const own = markers.filter((marker) => (marker.issue === null) === (of === 'coordinator'))
  assert.equal(own.length, 1, JSON.stringify(markers))
  return own[0]
}
// The theme has a coordinator when its worktree was started by `lntt worktree start --coordinator`.
const coordinated = (theme: string) => {
  const r = lntt(['--coordinator', '--theme', theme, '--issue', '84'])
  assert.equal(r.status, 0, r.stderr)
  rmSync(log, { force: true })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-coordinator-')))
  repo = join(tmp, 'repo')
  log = join(tmp, 'orca.log')
  stubs(join(tmp, 'bin'))
  mkdirSync(join(repo, '.agents'), { recursive: true })
  writeFileSync(join(repo, '.agents/config.jsonc'), CONFIG)
  writeFileSync(
    join(tmp, 'context.md'),
    'Your neighbours: #89 (no lntt code). Touch only your sections of the schema.\n',
  )
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  // The clone has fetched main: the worktrees start from origin/main.
  git('update-ref', 'refs/remotes/origin/main', 'main')
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('lntt worktree start --coordinator', () => {
  test('one worktree on no issue, on the coordinator’s model, with the coordinator’s brief', () => {
    const r = lntt(['--coordinator', '--theme', 'release-0-6-1', '--issue', '84', '--issue', '89', '--approve', '89'])
    assert.equal(r.status, 0, r.stderr)
    const [call, ...rest] = creates()
    assert.equal(rest.length, 0)
    assert.ok(call)
    assert.equal(after(call, '--name'), 'chore-no-issue-release-0-6-1')
    assert.ok(!call.includes('--issue'), 'the parent is on no issue')
    assert.equal(after(call, '--model'), 'sonnet')
    const brief = after(call, '--prompt') as string
    assert.match(brief, /You write no code/)
    assert.match(brief, /#84: Coordinator mode/)
    assert.match(brief, /Approved to start now: #89\. To propose first: #84\./)
    assert.doesNotMatch(brief, /ultracode/i)
    assert.match(brief, new RegExp(`${join(tmp, 'bin', 'orca')} worktree set`))
    assert.equal(JSON.parse(r.stdout.trim()).issue, null)
    assert.doesNotMatch(r.stderr, /has no coordinator worktree/)
    assert.equal(readFileSync(join(mailbox(), 'approved-release-0-6-1.txt'), 'utf8'), '89\n')
    assert.deepEqual(started('coordinator'), {
      branch: 'chore/no-issue/release-0-6-1',
      issue: null,
      to: 'orchestrator',
      theme: 'release-0-6-1',
    })
  })

  test('--prompt adds to the coordinator’s brief, in a section of its own at the end', () => {
    const r = lntt(['--coordinator', '--theme', 't', '--issue', '84', '--prompt', 'extra'])
    assert.equal(r.status, 0, r.stderr)
    const brief = after(creates()[0] as string[], '--prompt') as string
    assert.match(brief, /You write no code/)
    assert.match(brief, /#84: Coordinator mode/)
    assert.ok(brief.endsWith('\n\n## Added at start\n\nextra\n'), brief)
  })

  test('refuses what is a child’s, before creating anything', () => {
    for (const extra of [
      ['--size', 'S'],
      ['--workflow'],
      ['--parent', 'current'],
      ['--context', join(tmp, 'context.md')],
    ]) {
      const r = lntt(['--coordinator', '--theme', 'x', '--issue', '84', ...extra])
      assert.equal(r.status, 2, extra.join(' '))
    }
    assert.equal(lntt(['--coordinator', '--issue', '84']).status, 2)
    for (const approve of ['99', '084', 'abc']) {
      assert.equal(lntt(['--coordinator', '--theme', 'x', '--issue', '84', '--approve', approve]).status, 2, approve)
    }
    assert.deepEqual(creates(), [])
  })
})

describe('lntt worktree start --theme (a coordinator’s child)', () => {
  const child = (...more: string[]) => [
    '--theme',
    'release-0-6-1',
    '--parent',
    'current',
    '--issue',
    '89',
    '--context',
    join(tmp, 'context.md'),
    ...more,
  ]
  const approved = () => writeFileSync(join(mailbox(), 'approved-release-0-6-1.txt'), '89\n')
  beforeEach(() => coordinated('release-0-6-1'))

  test('an approved child is started under its parent, on the model of its Size, with the theme in its brief', () => {
    mkdirSync(mailbox(), { recursive: true })
    approved()
    const r = lntt(child('--size', 'M', '--workflow', '--base', 'feat/84/coordinator-mode'))
    assert.equal(r.status, 0, r.stderr)
    const [call] = creates()
    assert.ok(call)
    assert.equal(after(call, '--parent-worktree'), 'current')
    assert.equal(after(call, '--issue'), '89')
    assert.equal(after(call, '--base-branch'), 'feat/84/coordinator-mode')
    assert.equal(after(call, '--model'), 'opus')
    assert.equal(after(call, '--effort'), 'high')
    const brief = after(call, '--prompt') as string
    assert.match(brief, /## The theme\n\nYour neighbours: #89/)
    assert.match(brief, /lntt ask --to coordinator --theme release-0-6-1/)
    assert.match(brief, /At most 6 agents/)
    assert.equal(JSON.parse(r.stdout.trim()).parent, 'current')
    assert.doesNotMatch(r.stderr, /has no coordinator worktree/)
    const marker = started()
    assert.match(marker.branch, /^[a-z]+\/89\//)
    assert.deepEqual(marker, { branch: marker.branch, issue: 89, to: 'coordinator', theme: 'release-0-6-1' })
  })

  test('a theme with no coordinator worktree: the child reports to the orchestrator, the theme’s context and Size kept', () => {
    rmSync(join(mailbox(), 'started'), { recursive: true })
    mkdirSync(mailbox(), { recursive: true })
    approved()
    const r = lntt(child('--size', 'M'))
    assert.equal(r.status, 0, r.stderr)
    const [call] = creates()
    assert.equal(after(call as string[], '--model'), 'opus')
    const brief = after(call as string[], '--prompt') as string
    assert.match(brief, /## The theme\n\nYour neighbours: #89/)
    assert.match(brief, /lntt ask --to orchestrator --issue 89 "#89 ready: /)
    assert.match(brief, /lntt ask --to orchestrator --issue 89 "<question>"/)
    assert.doesNotMatch(brief, /--to coordinator|your coordinator|the coordinator/i)
    assert.deepEqual(started(), { branch: started().branch, issue: 89, to: 'orchestrator' })
    assert.match(r.stderr, /theme release-0-6-1 has no coordinator worktree/)
  })

  test('a coordinator whose start failed leaves no marker: the theme has none, and no gate waits', () => {
    rmSync(join(mailbox(), 'started'), { recursive: true })
    const failed = lntt(['--coordinator', '--theme', 'release-0-6-1', '--issue', '84'], { FAKE_ORCA_FAIL: '1' })
    assert.equal(failed.status, 1)
    rmSync(log, { force: true })
    const r = lntt(child())
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /sent to the orchestrator; no child is created/)
    assert.match(after(creates()[0] as string[], '--prompt') as string, /lntt ask --to orchestrator --issue 89/)
  })

  test('a marker of the theme that is not the coordinator’s (a child’s, on an issue) is no coordinator', () => {
    rmSync(join(mailbox(), 'started'), { recursive: true })
    mkdirSync(join(mailbox(), 'started'), { recursive: true })
    const branch = 'chore/no-issue/release-0-6-1'
    writeFileSync(
      join(mailbox(), 'started', `${encodeURIComponent(branch)}.json`),
      `${JSON.stringify({ branch, issue: 89, to: 'coordinator', theme: 'release-0-6-1' })}\n`,
    )
    approved()
    const r = lntt(child())
    assert.equal(r.status, 0, r.stderr)
    assert.match(after(creates()[0] as string[], '--prompt') as string, /lntt ask --to orchestrator --issue 89/)
  })

  test('--prompt adds to a child’s brief, with --context and --workflow', () => {
    mkdirSync(mailbox(), { recursive: true })
    approved()
    const r = lntt(child('--workflow', '--prompt', 'Rebase on #84 first.'))
    assert.equal(r.status, 0, r.stderr)
    const brief = after(creates()[0] as string[], '--prompt') as string
    assert.match(brief, /^You are working on issue #89/)
    assert.match(brief, /## The theme\n\nYour neighbours: #89/)
    assert.match(brief, /At most 6 agents/)
    assert.ok(brief.endsWith('\n\n## Added at start\n\nRebase on #84 first.\n'), brief)
  })

  test('the command line wins over the Size', () => {
    mkdirSync(mailbox(), { recursive: true })
    approved()
    lntt(child('--size', 'M', '--model', 'haiku'))
    const [call] = creates()
    assert.equal(after(call as string[], '--model'), 'haiku')
  })

  test('without --workflow the brief has no workflow section, and no keyword of the harness', () => {
    mkdirSync(mailbox(), { recursive: true })
    approved()
    lntt(child())
    const brief = after(creates()[0] as string[], '--prompt') as string
    assert.doesNotMatch(brief, /ultracode|workflow/i)
  })

  test('a child that is not approved waits for the orchestrator and starts on its approval', async () => {
    const starting = spawn(process.execPath, [BIN, 'worktree', 'start', '--host', 'orca', ...child()], {
      cwd: repo,
      env: env(),
    })
    let stderr = ''
    starting.stderr.on('data', (d) => {
      stderr += d
    })
    const done = new Promise<number | null>((ok) => starting.on('close', ok))

    const asked = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'orchestrator', '--wait', '--timeout', '20'], {
      cwd: repo,
      encoding: 'utf8',
      env: env(),
    })
    const message = JSON.parse(asked.stdout.trim().split('\n')[0] as string)
    assert.match(
      message.question,
      /Coordinator release-0-6-1 proposes to start:\n- #89: Board status for released issues \(on origin\/main\)/,
    )
    assert.deepEqual(creates(), [], 'nothing is created while the answer is awaited')

    const replied = spawnSync(process.execPath, [BIN, 'answer', message.id, 'approve'], { cwd: repo, env: env() })
    assert.equal(replied.status, 0)
    assert.equal(await done, 0, stderr)
    assert.equal(creates().length, 1)
    // The approval is kept: the same child is not proposed twice.
    assert.match(readFileSync(join(mailbox(), 'approved-release-0-6-1.txt'), 'utf8'), /^89$/m)
  })

  test('an answer that does not approve stops the start, with the reason', async () => {
    const starting = spawn(process.execPath, [BIN, 'worktree', 'start', '--host', 'orca', ...child()], {
      cwd: repo,
      env: env(),
    })
    let stderr = ''
    starting.stderr.on('data', (d) => {
      stderr += d
    })
    const done = new Promise<number | null>((ok) => starting.on('close', ok))
    const asked = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'orchestrator', '--wait', '--timeout', '20'], {
      cwd: repo,
      encoding: 'utf8',
      env: env(),
    })
    const message = JSON.parse(asked.stdout.trim().split('\n')[0] as string)
    const replied = spawnSync(process.execPath, [BIN, 'answer', message.id, 'not yet: #84 merges first'], {
      cwd: repo,
      env: env(),
    })
    assert.equal(replied.status, 0)
    assert.equal(await done, 1)
    assert.match(stderr, /not approved by the orchestrator: not yet: #84 merges first/)
    assert.deepEqual(creates(), [])
  })

  test('an answer that adds a condition does not approve', async () => {
    const starting = spawn(process.execPath, [BIN, 'worktree', 'start', '--host', 'orca', ...child()], {
      cwd: repo,
      env: env(),
    })
    let stderr = ''
    starting.stderr.on('data', (d) => {
      stderr += d
    })
    const done = new Promise<number | null>((ok) => starting.on('close', ok))
    const asked = spawnSync(process.execPath, [BIN, 'inbox', '--as', 'orchestrator', '--wait', '--timeout', '20'], {
      cwd: repo,
      encoding: 'utf8',
      env: env(),
    })
    const message = JSON.parse(asked.stdout.trim().split('\n')[0] as string)
    spawnSync(process.execPath, [BIN, 'answer', message.id, 'yes, but not #89 yet'], { cwd: repo, env: env() })
    assert.equal(await done, 1)
    assert.match(stderr, /not approved by the orchestrator: yes, but not #89 yet/)
    assert.deepEqual(creates(), [])
  })

  test('gate: free starts at once', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{ "coordinator": { "gate": "free" } }')
    const r = lntt(child())
    assert.equal(r.status, 0, r.stderr)
    assert.equal(creates().length, 1)
  })

  test('flags of a theme without a theme, a missing context file and an unknown Size are refused first', () => {
    assert.equal(lntt(['--issue', '89', '--size', 'M']).status, 2)
    assert.equal(lntt(['--issue', '89', '--context', join(tmp, 'context.md')]).status, 2)
    assert.equal(lntt(['--theme', 'x', '--issue', '89', '--context', join(tmp, 'absent.md')]).status, 1)
    const size = lntt(['--theme', 'x', '--issue', '89', '--size', 'XXL'])
    assert.equal(size.status, 1)
    assert.match(size.stderr, /XS, S, M, L or XL/)
    assert.deepEqual(creates(), [])
  })

  test('the marker is written before the host starts: a start that fails still leaves it', () => {
    const r = lntt(['--issue', '89'], { FAKE_ORCA_FAIL: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /the terminal did not start/)
    assert.deepEqual(started(), {
      branch: started().branch,
      issue: 89,
      to: 'orchestrator',
    })
    assert.match(started().branch, /^[a-z]+\/89\//)
  })

  test('a marker that cannot be written is a warning: the start goes on', () => {
    const file = join(tmp, 'not-a-directory')
    writeFileSync(file, '')
    const r = lntt(['--issue', '89'], { LNTT_MESSAGES_DIR: file })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /^lntt worktree start: could not record who [a-z]+\/89\/\S+ reports to: /m)
    assert.equal(creates().length, 1)
    assert.equal(JSON.parse(r.stdout.trim()).issue, 89)
  })

  test('a plain issue: the plain brief, its waits to the orchestrator, no parent, the agent’s own model', () => {
    const r = lntt(['--issue', '89'])
    assert.equal(r.status, 0, r.stderr)
    const [call] = creates()
    assert.ok(call)
    assert.ok(!call.includes('--parent-worktree'))
    assert.ok(!call.includes('--model'))
    const brief = after(call, '--prompt') as string
    assert.match(brief, /working on issue #89/)
    assert.doesNotMatch(brief, /theme/i)
    assert.match(brief, /## Every wait goes through the mailbox/)
    assert.match(brief, /lntt ask --to orchestrator --issue 89/)
    const marker = started()
    assert.equal(marker.to, 'orchestrator')
    assert.equal(marker.issue, 89)
    assert.equal(marker.theme, undefined)
  })
})
