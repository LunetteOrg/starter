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
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { branchKey } from '../src/review-store.ts'
import { type Clone, clone } from './clone.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

// A claude that answers by the kind of prompt it reads on stdin: a review, a check, an
// answer to the author. Each answer comes from an environment variable, and every call
// is logged with its arguments.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs')
let prompt = ''
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  const args = process.argv.slice(2)
  const resume = args.indexOf('--resume')
  const session = resume >= 0 ? args[resume + 1] : 'sess-' + Math.random().toString(36).slice(2, 8)
  const kind = prompt.startsWith('You are reviewing') ? 'REVIEW' : prompt.startsWith('You are checking') ? 'VERIFY' : 'REPLY'
  fs.appendFileSync(process.env.FAKE_LOG, kind + ' ' + args.join(' ') + '\\n')
  if (process.env.FAKE_PROMPTS) fs.appendFileSync(process.env.FAKE_PROMPTS, prompt + '\\n=====\\n')
  const model = args[args.indexOf('--model') + 1]
  // A test that needs another agent to be running first, or the rounds to overlap,
  // holds the answer: until a file has content, or for a fixed time.
  const holdUntil = Date.now() + 15000
  while (process.env['FAKE_WAIT_FILE_' + model] && Date.now() < holdUntil) {
    try { if (fs.readFileSync(process.env['FAKE_WAIT_FILE_' + model], 'utf8').trim()) break } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  if (process.env.FAKE_DELAY_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DELAY_MS))
  if (process.env.FAKE_ENVLOG) fs.appendFileSync(process.env.FAKE_ENVLOG, (process.env.ORCA_AGENT_HOOK_PORT ? 'orca-hook-env' : 'clean') + '\\n')
  if (process.env.FAKE_DIRTY) fs.writeFileSync('a.ts', 'changed during the round\\n')
  if (process.env['FAKE_LOG_TERM_' + model]) {
    process.on('SIGTERM', () => { fs.appendFileSync(process.env.FAKE_PIDS, 'TERM\\n'); process.exit(0) })
    fs.appendFileSync(process.env.FAKE_PIDS, 'started\\n')
    setInterval(() => {}, 1000)
    return
  }
  // A leader that exits on SIGTERM and leaves a child of its group that ignores it.
  if (process.env['FAKE_ORPHAN_' + model]) {
    require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').appendFileSync(process.env.FAKE_CHILD_PIDS, String(process.pid)); setTimeout(() => {}, 60000)"], { stdio: 'ignore' })
    const childUntil = Date.now() + 5000
    while (Date.now() < childUntil) {
      try { if (fs.readFileSync(process.env.FAKE_CHILD_PIDS, 'utf8').trim()) break } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    process.on('SIGTERM', () => process.exit(0))
    fs.appendFileSync(process.env.FAKE_PIDS, 'leader\\n')
    setInterval(() => {}, 1000)
    return
  }
  if (process.env['FAKE_IGNORE_TERM_' + model]) {
    process.on('SIGTERM', () => {})
    fs.appendFileSync(process.env.FAKE_PIDS, process.pid + '\\n')
    setInterval(() => {}, 1000)
    return
  }
  if (process.env['FAKE_SLEEP_' + model]) { setTimeout(() => {}, 600000); return }
  if (process.env['FAKE_FAIL_' + kind] || process.env['FAKE_FAIL_' + kind + '_' + model]) { process.stderr.write('boom\\n'); process.exit(1) }
  const result = (process.env['FAKE_' + kind + '_' + model] || process.env['FAKE_' + kind] || 'no findings').replace(/\\\\n/g, '\\n')
  process.stdout.write(JSON.stringify({ result, session_id: session, is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 500 } }))
})
`

let repo: string
let bin: string
let log: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function lntt(args: string[], env: Record<string, string> = {}, at: string = repo) {
  const r = spawnSync(process.execPath, [BIN, 'review', ...args], {
    cwd: at,
    encoding: 'utf8',
    // A run that hangs fails its test instead of blocking the suite.
    timeout: 20_000,
    killSignal: 'SIGKILL',
    env: {
      HOME: repo,
      PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      FAKE_LOG: log,
      ...env,
    },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const CONFIG = JSON.stringify({
  delivery: {
    review: {
      reviewers: {
        decisions: { with: [] },
        tests: { with: [] },
        code: { with: [{ kind: 'claude', model: 'sonnet' }] },
      },
      verify: { with: [{ kind: 'claude', model: 'opus' }] },
    },
  },
})

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-')))
  bin = join(repo, '.fakebin')
  log = join(repo, '.fakelog')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(log, '')
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  writeFileSync(join(repo, '.gitignore'), '.fakebin\n.fakelog\n.orca/\n.orca-events\n.envlog\n.pids\n.caffeinate\n')
  mkdirSync(join(repo, '.agents'))
  writeFileSync(join(repo, '.agents/config.jsonc'), CONFIG)
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('switch', '-qc', 'feat/1/x')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2\n')
  git('commit', '-qam', 'change')
})

afterEach(() => {
  // A hook script lntt started in the background may still be writing: retry the removal.
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// Where lntt review keeps a branch's state and ledger: one file each, named by the branch
// (percent-encoded), in the clone's common git directory unless a place is configured.
const storeDir = (...names: string[]) => join(repo, '.git/lntt-review', ...names)
const stateFile = (branch = 'feat/1/x', dir = storeDir()) => join(dir, 'state', `${branchKey(branch)}.json`)
const ledgerFile = (branch = 'feat/1/x', dir = storeDir()) => join(dir, 'ledger', `${branchKey(branch)}.json`)
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const state = (branch = 'feat/1/x') => JSON.parse(readFileSync(stateFile(branch), 'utf8'))

// The last round as an agent reads it: through the command, never from the state's file.
const reading = () => JSON.parse(lntt(['status', '--json']).out).state

describe('lntt review with lntt check', () => {
  test('the decisions lens gets lntt check decisions; a finding on a line that does not exist never reaches a verifier', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        recording: { logs: { adr: { path: 'docs/adr', index: 'docs/adr/README.md' } } },
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [{ kind: 'claude', model: 'haiku' }] },
              tests: { with: [] },
              code: { with: [{ kind: 'claude', model: 'sonnet' }] },
            },
            verify: { with: [{ kind: 'claude', model: 'opus' }] },
          },
        },
      }),
    )
    mkdirSync(join(repo, 'docs/adr'), { recursive: true })
    writeFileSync(join(repo, 'docs/adr/README.md'), '# Decisions\n')
    writeFileSync(join(repo, 'docs/adr/storage.md'), '# Storage\n')
    git('add', '-A')
    git('commit', '-qm', 'a record left out of its index')
    const prompts = join(repo, '.fakeprompts')
    writeFileSync(join(repo, '.gitignore'), `${readFileSync(join(repo, '.gitignore'), 'utf8')}.fakeprompts\n`)
    git('commit', '-qam', 'ignore the prompts')
    const r = lntt(['--base', 'main'], {
      FAKE_PROMPTS: prompts,
      FAKE_REVIEW_sonnet: '- [blocker] a.ts:40 — an invented line — fix',
    })
    assert.match(r.err, /before the reviewers: lntt check decisions/)
    const decisions = readFileSync(prompts, 'utf8')
      .split('\n=====\n')
      .find((p) => p.includes('Lens: decisions')) as string
    assert.match(decisions, /"check":"index","status":"FAIL","path":"docs\/adr\/storage\.md"/)
    assert.match(decisions, /"check":"inventory","status":"INFO","path":"docs\/adr\/storage\.md"/)
    const result = reading()
    assert.deepEqual(result.findings, [])
    assert.deepEqual(
      result.refuted.map((f: { proofs: { by: string; proof: string }[] }) => f.proofs),
      [[{ by: 'lntt check cite', outcome: 'refuted', proof: 'a.ts:40: no line 40: the file has 1 line' }]],
    )
    assert.doesNotMatch(readFileSync(log, 'utf8'), /^VERIFY/m)
    assert.equal(r.code, 0, r.err)
  })
})

describe('lntt review, end to end with a fake agent', () => {
  test('a clean round: exit 0, its summary on stdout, the head saved as reviewed', () => {
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^lntt review: feat\/1\/x: round 1 of 4, reviewed \w+, clean; 0 open, 0 replied, 0 closed/)
    assert.deepEqual(reading().findings, [])
    assert.match(r.err, /round 1 done/)
    assert.match(r.err, /the diff goes to: anthropic \(claude\)/)
    assert.equal(state().reviewed, git('rev-parse', '--short', 'HEAD'))
    assert.match(
      readFileSync(log, 'utf8'),
      /^REVIEW -p --output-format json --tools Read,Grep,Glob --strict-mcp-config/m,
    )
  })

  test('a confirmed blocker exits 1; withdrawn by its reviewer, the next round is clean', () => {
    const env = { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\na.ts:1 shows it' }
    const r = lntt(['--base', 'main'], env)
    assert.equal(r.code, 1, r.err)
    const finding = reading().findings[0]
    assert.deepEqual([finding.id, finding.verdict], ['f1', 'confirmed'])

    const reply = lntt(['reply', 'f1', 'line 1 is the point'], { FAKE_REPLY: 'withdrawn\\nfair' })
    assert.equal(reply.code, 0, reply.err)
    assert.equal(JSON.parse(reply.out).withdrawn, true)
    const session = finding.foundBy[0].session
    assert.match(readFileSync(log, 'utf8'), new RegExp(`^REPLY .*--resume ${session}$`, 'm'))

    const again = lntt(['--base', 'main'])
    assert.equal(again.code, 0, again.err)
  })

  test('kept by its reviewer, the finding stays open and reply exits 1', () => {
    lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_VERIFY: 'confirmed\\np' })
    const reply = lntt(['reply', 'f1', 'no'], { FAKE_REPLY: 'kept\\nstill wrong' })
    assert.equal(reply.code, 1)
    assert.equal(state().result.findings[0].verdict, 'confirmed')
  })

  test('a reviewer that fails: exit 1, listed in failed, and the range is read again next time', () => {
    const r = lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' })
    assert.equal(r.code, 1)
    assert.match(reading().failed[0].error, /claude exited 1: boom/)
    assert.equal(state().reviewed, null)
    const again = lntt(['--base', 'main'])
    assert.match(again.err, /round 2, no round read the whole branch/)
  })

  test('refused: a configuration that does not validate, a dirty tree, a detached HEAD', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{"delivery":{"review":{"timeoutMinutes":0}}}')
    git('commit', '-qam', 'bad config')
    const bad = lntt(['--base', 'main'])
    assert.equal(bad.code, 1)
    assert.match(bad.err, /lntt review: error: [\s\S]*timeoutMinutes must be >= 1/)
    assert.equal(existsSync(stateFile()), false, 'no round on the defaults')

    git('revert', '--no-edit', 'HEAD')
    writeFileSync(join(repo, 'a.ts'), 'dirty\n')
    assert.match(lntt(['--base', 'main']).err, /uncommitted changes/)
    git('checkout', '-q', '--', 'a.ts')

    git('switch', '-q', '--detach')
    assert.match(lntt(['--base', 'main']).err, /HEAD is detached/)
  })

  test('--plan prints the plan and what cannot start, and starts nothing', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { review: { reviewers: { code: { with: [{ kind: 'opencode', model: 'x/y' }] } } } } }),
    )
    git('commit', '-qam', 'opencode')
    const r = lntt(['--base', 'main', '--plan'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /cannot start opencode x\/y: opencode is not on the PATH/)
    assert.match(r.err, /the diff goes to: .*x \(opencode\)/)
    assert.equal(readFileSync(log, 'utf8'), '')
    assert.equal(lntt(['--base', 'main']).code, 1, 'a real round refuses')
  })

  test('a later round that fails keeps the commit the last good round read', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    const first = git('rev-parse', '--short', 'HEAD')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3\n')
    git('commit', '-qam', 'more')
    assert.equal(lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' }).code, 1)
    assert.equal(state().reviewed, first)
  })

  test('with two reviewers on a finding, it is withdrawn only when both withdraw it', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus' },
                ],
              },
            },
            verify: false,
          },
        },
      }),
    )
    git('commit', '-qam', 'two reviewers')
    lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a' })
    assert.equal(reading().findings[0].foundBy.length, 2)
    const reply = lntt(['reply', 'f1', 'it is fine'], {
      FAKE_REPLY_sonnet: 'withdrawn\\nok',
      FAKE_REPLY_opus: 'kept\\nno',
    })
    assert.equal(reply.code, 1)
    assert.deepEqual(
      JSON.parse(reply.out).replies.map((x: { withdrawn: boolean }) => x.withdrawn),
      [true, false],
    )
  })

  test('an optional reviewer that fails is reported as skipped and the round can be clean', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus', optional: true },
                ],
              },
            },
            verify: false,
          },
        },
      }),
    )
    git('commit', '-qam', 'optional')
    const r = lntt(['--base', 'main'], { FAKE_FAIL_REVIEW_opus: '1' })
    assert.equal(r.code, 0, r.err)
    assert.equal(reading().skipped[0].agent, 'claude opus')
    assert.equal(state().reviewed, git('rev-parse', '--short', 'HEAD'), 'the next round reads only what comes after')
    assert.match(r.err, /lntt review: skipped code · claude opus/)
    const starts = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'start')
    assert.deepEqual(
      starts.map((e) => [e.label, e.optional]),
      [
        ['code · claude sonnet', false],
        ['code · claude opus', true],
      ],
    )
    assert.doesNotMatch(r.err, /lntt review: failed/)
  })

  test("a refusal matches the skill's watch, as a failure does", () => {
    writeFileSync(join(repo, 'a.ts'), 'dirty\n')
    assert.match(lntt(['--base', 'main']).err, /^lntt review: error: /m)
  })

  test('an optional agent still running after the others answered is stopped, not awaited', { timeout: 30000 }, () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus', optional: true },
                ],
              },
            },
            verify: false,
            optionalGraceMinutes: 0,
          },
        },
      }),
    )
    git('commit', '-qam', 'slow optional')
    const began = Date.now()
    const r = lntt(['--base', 'main'], { FAKE_SLEEP_opus: '1' })
    assert.equal(r.code, 0, r.err)
    assert.ok(Date.now() - began < 20000, 'not awaited')
    assert.match(reading().skipped[0].error, /stopped: the other agents answered/)
  })

  test('the progress goes to stderr with tokens, and to a file of JSON events the band reads', () => {
    const env = { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\nshown' }
    const r = lntt(['--base', 'main'], env)
    assert.match(r.err, /lntt review: done code · claude sonnet in \d+s \(1\.5k tokens\)/)
    assert.match(
      r.err,
      /round 1 done in \d+s: 1 findings, 0 refuted, 0 failed, 0 partial, 0 skipped, 0 closed, 3k tokens/,
    )
    assert.doesNotMatch(r.err, /\$/)
    const events = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    assert.deepEqual(
      events.map((e) => [e.type, e.phase ?? e.round ?? '', e.total ?? e.outcome ?? '']),
      [
        ['round', 1, ''],
        ['phase', 'reviewers', 1],
        ['start', 'reviewers', ''],
        ['end', 'reviewers', 'done'],
        ['phase', 'verify', 1],
        ['start', 'verify', ''],
        ['end', 'verify', 'done'],
        ['done', 1, ''],
      ],
    )
    assert.ok(events.every((e) => typeof e.t === 'number'))
    assert.equal(events.at(-1).tokens, 3000)
    assert.equal(events[3].label, 'code · claude sonnet')
    assert.equal(events[3].tokens, 1500)
  })

  test('a round that cannot start leaves an error event for the band', () => {
    writeFileSync(join(repo, 'a.ts'), 'dirty\n')
    lntt(['--base', 'main'])
    const last = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').trim().split('\n').at(-1) as string
    assert.equal(JSON.parse(last).type, 'error')
  })

  test('under Claude Code in Orca: each agent is a subagent of the session, and the agents get no hook variables', () => {
    const hooks = join(repo, '.orca/agent-hooks')
    mkdirSync(hooks, { recursive: true })
    const events = join(repo, '.orca-events')
    writeFileSync(join(hooks, 'claude-hook.sh'), `#!/bin/sh\ncat >> ${events}; echo >> ${events}\n`)
    const envlog = join(repo, '.envlog')
    const r = lntt(['--base', 'main'], {
      ORCA_AGENT_HOOK_PORT: '1',
      ORCA_AGENT_HOOK_TOKEN: 't',
      ORCA_PANE_KEY: 'tab:pane',
      CLAUDE_CODE_SESSION_ID: 'sess',
      FAKE_ENVLOG: envlog,
    })
    assert.equal(r.code, 0, r.err)
    // lntt sends the events through scripts it does not wait for: wait for the last one.
    const until = Date.now() + 5000
    while (
      !/"SubagentStop"[^\n]*code · claude sonnet|code · claude sonnet[^\n]*"SubagentStop"/.test(
        existsSync(events) ? readFileSync(events, 'utf8') : '',
      ) &&
      Date.now() < until
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    const sent = readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const mine = sent.filter((e) => e.agent_type === 'code · claude sonnet')
    assert.equal(mine[0].hook_event_name, 'SubagentStart')
    assert.equal(mine[0].session_id, 'sess')
    assert.equal(mine.at(-1).hook_event_name, 'SubagentStop')
    assert.deepEqual([...new Set(readFileSync(envlog, 'utf8').split('\n').filter(Boolean))], ['clean'])
  })

  test('the Mac is kept awake for the length of the round', { skip: process.platform !== 'darwin' }, () => {
    const calls = join(repo, '.caffeinate')
    writeFileSync(join(bin, 'caffeinate'), `#!/bin/sh\necho "$@" >> ${calls}\n`)
    chmodSync(join(bin, 'caffeinate'), 0o755)
    lntt(['--base', 'main'])
    // caffeinate starts on its own: give it a moment to write.
    const until = Date.now() + 3000
    while (!existsSync(calls) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    assert.match(readFileSync(calls, 'utf8'), /^-i -w \d+$/m)
  })

  test('an agent that ignores SIGTERM is killed', { timeout: 30000 }, () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus', optional: true },
                ],
              },
            },
            verify: false,
            optionalGraceMinutes: 0,
          },
        },
      }),
    )
    git('commit', '-qam', 'stubborn optional')
    const pids = join(repo, '.pids')
    writeFileSync(pids, '')
    // The required agent answers only once the optional one has started and named its pid:
    // otherwise a fast machine stops the optional one before it starts.
    const r = lntt(['--base', 'main'], { FAKE_IGNORE_TERM_opus: '1', FAKE_PIDS: pids, FAKE_WAIT_FILE_sonnet: pids })
    assert.equal(r.code, 0, r.err)
    const pid = Number(readFileSync(pids, 'utf8').trim())
    assert.ok(pid > 0)
    // The exit handler's SIGKILL is sent as lntt review exits; the kernel takes the process
    // away a moment later.
    const until = Date.now() + 3000
    while (Date.now() < until) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    assert.throws(() => process.kill(pid, 0), 'the stubborn agent is gone')
  })

  test('a round past roundTimeoutMinutes stops its agents and fails', { timeout: 30000 }, () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { review: { roundTimeoutMinutes: 0.02, verify: false } } }),
    )
    git('commit', '-qam', 'short round')
    const r = lntt(['--base', 'main'], { FAKE_SLEEP_sonnet: '1', FAKE_SLEEP_haiku: '1' })
    assert.equal(r.code, 1)
    assert.match(reading().failed[0].error, /the round took longer than/)
  })

  test('the progress names the Claude Code session that started the round, or none', () => {
    lntt(['--base', 'main'], { CLAUDE_CODE_SESSION_ID: 'session-1' })
    const named = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(named.session, 'session-1')
    git('commit', '-q', '--allow-empty', '-m', 'again')
    lntt(['--base', 'main'])
    const none = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(none.session, null)
    git('commit', '-q', '--allow-empty', '-m', 'empty id')
    lntt(['--base', 'main'], { CLAUDE_CODE_SESSION_ID: '' })
    const empty = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(empty.session, null)
  })

  test("the progress names lntt review's pid; an error starts a new file", () => {
    lntt(['--base', 'main'])
    const first = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(first.type, 'round')
    assert.ok(Number.isInteger(first.pid))
    writeFileSync(join(repo, 'a.ts'), 'dirty\n')
    lntt(['--base', 'main'])
    const lines = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').trim().split('\n')
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).type),
      ['error'],
    )
  })

  test('a branch that changes while the round runs makes the round fail', () => {
    const r = lntt(['--base', 'main'], { FAKE_DIRTY: '1' })
    assert.equal(r.code, 1)
    assert.match(reading().failed.at(-1).error, /the branch moved/)
  })

  test('a round that fails on another branch than the saved one keeps no reviewed commit', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    git('switch', '-qc', 'feat/2/y')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 9\n')
    git('commit', '-qam', 'other branch')
    lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' })
    assert.deepEqual([state('feat/2/y').branch, state('feat/2/y').reviewed], ['feat/2/y', null])
  })

  const firstEvent = () =>
    JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)

  test('an empty delta on a new branch saves round 1, and the branch reviewed before it keeps its round', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    writeFileSync(join(repo, 'a.ts'), 'export const a = 5\n')
    git('commit', '-qam', 'again')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(state().round, 2)
    git('switch', '-q', 'main')
    git('switch', '-qc', 'feat/3/z')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(firstEvent().files, 0, 'the delta was empty')
    const own = state('feat/3/z')
    assert.deepEqual([own.branch, own.round, own.rounds], ['feat/3/z', 1, []])
    assert.equal(state().round, 2, 'the branch reviewed before keeps its round')
  })

  test("an empty delta on the branch's own state keeps its round and its costs", () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    writeFileSync(join(repo, 'a.ts'), 'export const a = 5\n')
    git('commit', '-qam', 'again')
    assert.equal(lntt(['--base', 'main']).code, 0)
    git('commit', '-q', '--allow-empty', '-m', 'empty')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(firstEvent().files, 0, 'the delta was empty')
    assert.deepEqual([state().round, state().rounds.length], [2, 2])
  })

  test('--plan as the first argument: an error leaves the progress file of the last round alone', () => {
    lntt(['--base', 'main'])
    const before = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
    writeFileSync(join(repo, '.agents/config.jsonc'), '{"delivery":{"review":{"timeoutMinutes":0}}}')
    git('commit', '-qam', 'bad')
    assert.equal(lntt(['--plan', '--base', 'main']).code, 1)
    assert.equal(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8'), before)
  })

  test('Ctrl-C gives the agents SIGTERM before anything harder', { timeout: 30000 }, async () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: { with: [{ kind: 'claude', model: 'sonnet' }] },
            },
            verify: false,
          },
        },
      }),
    )
    git('commit', '-qam', 'one reviewer')
    const pids = join(repo, '.pids')
    writeFileSync(pids, '')
    const child = spawn(process.execPath, [BIN, 'review', '--base', 'main'], {
      cwd: repo,
      env: {
        HOME: repo,
        PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: log,
        FAKE_LOG_TERM_sonnet: '1',
        FAKE_PIDS: pids,
      },
      stdio: 'ignore',
    })
    const until = Date.now() + 10_000
    while (!readFileSync(pids, 'utf8').includes('started') && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50))
    child.kill('SIGINT')
    await new Promise((r) => child.on('exit', r))
    assert.match(readFileSync(pids, 'utf8'), /TERM/)
  })

  test('Ctrl-C keeps the agents still waiting for a slot from starting', { timeout: 30000 }, async () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus' },
                ],
              },
            },
            verify: false,
            perProvider: 1,
          },
        },
      }),
    )
    git('commit', '-qam', 'two in one slot')
    const pids = join(repo, '.pids')
    writeFileSync(pids, '')
    const child = spawn(process.execPath, [BIN, 'review', '--base', 'main'], {
      cwd: repo,
      env: {
        HOME: repo,
        PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: log,
        FAKE_LOG_TERM_sonnet: '1',
        FAKE_LOG_TERM_opus: '1',
        FAKE_PIDS: pids,
      },
      stdio: 'ignore',
    })
    const until = Date.now() + 10_000
    while (!readFileSync(pids, 'utf8').includes('started') && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50))
    child.kill('SIGINT')
    await new Promise((r) => child.on('exit', r))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(readFileSync(pids, 'utf8').match(/started/g)?.length, 1)
  })

  test('one round at a time in a worktree: a second is refused while the first runs', () => {
    const lock = join(repo, '.git/lntt-review.lock')
    writeFileSync(lock, String(process.pid))
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 1)
    assert.match(r.err, /a round is already running in this worktree \(pid \d+\)/)
    writeFileSync(lock, '999999')
    assert.equal(lntt(['--base', 'main']).code, 0, 'a lock left by a process that is gone is taken over')
    assert.equal(existsSync(lock), false, 'the lock goes with the round')
  })

  test('a reply stops at the round deadline too', { timeout: 30000 }, () => {
    // The round runs with the usual deadline: on a slow machine a short one would stop the
    // round itself. Only the reply gets the short deadline.
    const r = lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a' })
    assert.equal(reading().findings[0].id, 'f1', r.err)
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { review: { roundTimeoutMinutes: 0.02, verify: false } } }),
    )
    const reply = lntt(['reply', 'f1', 'no'], { FAKE_SLEEP_sonnet: '1', FAKE_SLEEP_haiku: '1' })
    assert.equal(reply.code, 1)
    assert.match(reply.out, /took longer than/)
  })

  test('the lock is taken atomically: of two rounds started together, one runs and one is refused', {
    timeout: 30000,
  }, async () => {
    const run = () =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [BIN, 'review', '--base', 'main'], {
          cwd: repo,
          // Each round lasts two seconds: the three overlap, whatever the machine's speed.
          env: {
            HOME: repo,
            PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
            FAKE_LOG: log,
            FAKE_DELAY_MS: '2000',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let err = ''
        child.stderr.on('data', (d) => {
          err += d
        })
        child.on('exit', () => resolve(/already running/.test(err) ? 1 : 0))
      })
    const refused = (await Promise.all([run(), run(), run()])).reduce((a, b) => a + b, 0)
    assert.equal(refused, 2)
  })

  test('a lock file with no valid pid is taken over; a reply with an unknown finding says so first', () => {
    writeFileSync(join(repo, '.git/lntt-review.lock'), 'garbage')
    assert.equal(lntt(['--base', 'main']).code, 0)
    writeFileSync(join(repo, '.git/lntt-review.lock'), String(process.pid))
    assert.match(lntt(['reply', 'f99', 'x']).err, /no open finding f99/)
  })
})

describe("lntt review, with the project's phase", () => {
  const phased = (phase: string | undefined) => {
    const config = JSON.parse(CONFIG)
    if (phase !== undefined) config.project = { phase }
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', `phase ${phase}`)
  }

  test('in development the reviewers and the verifiers read what is not a finding before production', () => {
    phased('development')
    const prompts = join(repo, '.git/prompts')
    const r = lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_PROMPTS: prompts })
    assert.equal(r.code, 1, r.err)
    const read = readFileSync(prompts, 'utf8')
      .split('\n=====\n')
      .filter((p) => p.trim())
    assert.ok(read.some((p) => p.startsWith('You are reviewing')))
    assert.ok(read.some((p) => p.startsWith('You are checking')))
    for (const p of read) assert.match(p, /## Before production[\s\S]*Not a finding yet[\s\S]*Findings anyway/)
  })

  test('in production, or with no phase, they do not', () => {
    for (const phase of ['production', undefined]) {
      phased(phase)
      const prompts = join(repo, '.git/prompts')
      writeFileSync(prompts, '')
      const r = lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_PROMPTS: prompts })
      assert.equal(r.code, 1, r.err)
      assert.match(readFileSync(prompts, 'utf8'), /You are reviewing[\s\S]*You are checking/)
      assert.doesNotMatch(readFileSync(prompts, 'utf8'), /Before production/, String(phase))
    }
  })
})

describe('lntt review, with the findings the branch already closed', () => {
  const ledger = () => JSON.parse(readFileSync(ledgerFile(), 'utf8'))
  const verifies = () => readFileSync(log, 'utf8').match(/^VERIFY /gm)?.length ?? 0

  test('a refuted finding is kept with its proof; repeated on the unchanged line, it is dropped and asks no verifier', () => {
    const prompts = join(repo, '.git/prompts')
    const env = { FAKE_REVIEW: '- [warning] a.ts:1 — a may be 2 — check it', FAKE_PROMPTS: prompts }
    const first = lntt(['--base', 'main'], { ...env, FAKE_VERIFY: 'refuted\\na.ts:1 is the point' })
    assert.equal(first.code, 0, first.err)
    assert.deepEqual(
      ledger().closed.map((c: { id: string; outcome: string; cited: string; proof: string }) => [
        c.id,
        c.outcome,
        c.cited,
        c.proof,
      ]),
      [['f1', 'refuted', 'export const a = 2', 'claude opus: a.ts:1 is the point']],
    )
    assert.equal(ledger().branch, 'feat/1/x')

    // Line 1 stays as it was; the change adds line 2.
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2\nexport const b = 1\n')
    git('commit', '-qam', 'b')
    const second = lntt(['--base', 'main'], { ...env, FAKE_VERIFY: 'confirmed\\nyes' })
    assert.equal(second.code, 0, second.err)
    assert.deepEqual(
      reading().repeated.map((f: { id: string; closedBy: string }) => [f.id, f.closedBy]),
      [['f2', 'f1']],
    )
    assert.match(second.err, /round 2 done in \d+s: 0 findings, 0 refuted, 0 failed, 0 partial, 0 skipped, 1 closed/)
    assert.equal(verifies(), 1, 'only the first round asked a verifier')
    assert.match(
      readFileSync(prompts, 'utf8'),
      /## Findings this branch already closed[\s\S]*- f1 \(warning\) `a\.ts:1`/,
    )
  })

  test('a ledger file that names another branch is none, a ledger that cannot be read is said and replaced', () => {
    const path = ledgerFile()
    const prompts = join(repo, '.git/prompts')
    const other = {
      id: 'f1',
      round: 1,
      severity: 'warning',
      path: 'a.ts',
      line: 1,
      what: 'other',
      cited: 'export const a = 2',
      outcome: 'refuted',
      proof: 'p',
    }
    put(path, JSON.stringify({ branch: 'feat/2/y', closed: [other] }))
    const env = { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_VERIFY: 'refuted\\nno', FAKE_PROMPTS: prompts }
    const r = lntt(['--base', 'main'], env)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(reading().repeated, [])
    assert.doesNotMatch(readFileSync(prompts, 'utf8'), /Findings this branch already closed/)
    assert.equal(ledger().branch, 'feat/1/x')

    put(path, '{"branch": "feat/1/x", "clo')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 3\n')
    git('commit', '-qam', 'more')
    const cut = lntt(['--base', 'main'])
    assert.equal(cut.code, 0, cut.err)
    assert.match(cut.err, /ledger\/feat%2F1%2Fx\.json cannot be read: the branch starts a new ledger/)
    assert.deepEqual(ledger().closed, [])

    put(path, '{"branch": "feat/1/x"}')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 4\n')
    git('commit', '-qam', 'again')
    const shapeless = lntt(['--base', 'main'])
    assert.equal(shapeless.code, 0, shapeless.err)
    assert.match(shapeless.err, /ledger\/feat%2F1%2Fx\.json cannot be read/, 'valid JSON with no closed list')
    assert.deepEqual(ledger().closed, [])
  })

  test('a round that failed, or an empty delta, closes nothing', () => {
    const note = '- [note] (no anchor) — n — a'
    const failed = lntt(['--base', 'main'], {
      FAKE_REVIEW: `${note}\\n- [warning] a.ts:1 — w — a`,
      FAKE_FAIL_VERIFY: '1',
    })
    assert.equal(failed.code, 1, failed.err)
    assert.equal(existsSync(ledgerFile()), false, 'a failed verifier: nothing closed')
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note, FAKE_VERIFY: 'refuted\\nno' }).code, 0)
    assert.deepEqual(
      ledger().closed.map((c: { id: string; severity: string; outcome: string }) => [c.id, c.severity, c.outcome]),
      [
        ['f1', 'warning', 'fixed'],
        ['f3', 'note', 'accepted'],
      ],
      'the warning the failed round left, and the note of this one',
    )
    const before = readFileSync(ledgerFile(), 'utf8')
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
    assert.equal(readFileSync(ledgerFile(), 'utf8'), before, 'an empty delta')
  })

  test('a finding its reviewers withdraw is closed, with the answer as the proof', () => {
    lntt(['--base', 'main'], { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\nshown' })
    assert.deepEqual(ledger().closed, [])
    assert.equal(lntt(['reply', 'f1', 'line 1 is the point'], { FAKE_REPLY: 'withdrawn\\nfair' }).code, 0)
    assert.deepEqual(
      ledger().closed.map((c: { id: string; outcome: string; proof: string }) => [c.id, c.outcome, c.proof]),
      [['f1', 'refuted', 'withdrawn by its reviewers after the answer: line 1 is the point']],
    )
  })

  test('past delivery.review.warningRounds a confirmed warning does not block, and is accepted open', () => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.warningRounds = 1
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'warningRounds 1')
    const env = { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_VERIFY: 'confirmed\\nshown' }
    const first = lntt(['--base', 'main'], env)
    assert.equal(first.code, 1, 'round 1: a warning blocks')
    assert.deepEqual(reading().blocking, ['blocker', 'warning'])
    assert.doesNotMatch(first.err, /past delivery\.review\.warningRounds/)

    writeFileSync(join(repo, 'a.ts'), 'export const a = 3\n')
    git('commit', '-qam', 'more')
    const second = lntt(['--base', 'main'], env)
    assert.equal(second.code, 0, second.err)
    assert.deepEqual(reading().blocking, ['blocker'])
    assert.deepEqual(
      reading().findings.map((f: { id: string; verdict: string }) => [f.id, f.verdict]),
      [['f1', 'confirmed']],
      'the warning is still listed, for the pull request',
    )
    assert.match(second.err, /round 2 is past delivery\.review\.warningRounds \(1\): only blockers block/)
    assert.deepEqual(
      ledger().closed.map((c: { id: string; outcome: string }) => [c.id, c.outcome]),
      [['f1', 'accepted']],
    )

    writeFileSync(join(repo, 'a.ts'), 'export const a = 4\n')
    git('commit', '-qam', 'again')
    const blockers = lntt(['--base', 'main'], {
      FAKE_REVIEW: '- [blocker] a.ts:1 — b — a',
      FAKE_VERIFY: 'confirmed\\nshown',
    })
    assert.equal(blockers.code, 1, 'a blocker blocks past warningRounds too')
    assert.doesNotMatch(blockers.err, /past delivery\.review\.warningRounds/, 'no warning or note is left')
  })

  test('a warningRounds not below maxRounds is said in the plan, and at the start of a round', () => {
    const config = JSON.parse(CONFIG)
    Object.assign(config.delivery.review, { maxRounds: 2, warningRounds: 2 })
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'warningRounds 2 of 2')
    const warning =
      /^ {2}warning: delivery\.review\.warningRounds \(2\) is not below delivery\.review\.maxRounds \(2\)/m
    assert.match(lntt(['--base', 'main', '--plan']).err, warning)
    assert.match(lntt(['--base', 'main']).err, warning)
  })

  test('a warningRounds below 1 does not validate', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{"delivery":{"review":{"warningRounds":0}}}')
    git('commit', '-qam', 'bad')
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 1)
    assert.match(r.err, /warningRounds must be >= 1/)
  })
})

describe('lntt review at delivery.review.maxRounds', () => {
  const withMaxRounds = (n: number) => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.maxRounds = n
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', `maxRounds ${n}`)
  }
  const commit = (value: number) => {
    writeFileSync(join(repo, 'a.ts'), `export const a = ${value}\n`)
    git('commit', '-qam', `a = ${value}`)
  }
  const progress = () => readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
  const events = () =>
    progress()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  const open = { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_VERIFY: 'confirmed\\np' }

  test('the round past it does not start: exit 3, a limit line, what is still open', () => {
    withMaxRounds(1)
    assert.equal(lntt(['--base', 'main'], open).code, 1)
    const calls = readFileSync(log, 'utf8')
    commit(3)

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    assert.match(
      r.err,
      /^lntt review: limit: round 2 would pass delivery\.review\.maxRounds \(1\) on feat\/1\/x; still open: f1 \(warning, confirmed\)$/m,
    )
    assert.match(r.err, /pnpm exec lntt review allow <rounds>/)
    assert.match(r.out, /^ {2}f1 warning confirmed a\.ts:1 — w$/m)
    assert.match(r.out, /^lntt review: feat\/1\/x: round 1 of 1, .*, round 2 refused at the limit; /)
    assert.equal(readFileSync(log, 'utf8'), calls, 'no agent started')
    assert.equal(state().round, 1)
    assert.deepEqual(events().at(-1), {
      ...events().at(-1),
      type: 'limit',
      round: 2,
      maxRounds: 1,
      allowed: 0,
      open: 1,
      failed: 0,
    })
    // A branch nobody started with lntt worktree start sends nothing.
    assert.equal(events().at(-1).asked, undefined)
    assert.doesNotMatch(r.err, /limit: sent/)
    const box = join(repo, '.git/lntt-messages')
    assert.ok(!existsSync(box) || readdirSync(box).every((name) => !name.startsWith('to-')), 'no message')
  })

  // The start marker lntt worktree start leaves in the mailbox for the branch.
  const startedBy = (marker: Record<string, unknown>) => {
    mkdirSync(join(repo, '.git/lntt-messages/started'), { recursive: true })
    writeFileSync(join(repo, '.git/lntt-messages/started/feat%2F1%2Fx.json'), JSON.stringify(marker))
  }
  // The messages of a directory, without their answers.
  const messages = (dir: string) =>
    readdirSync(join(repo, '.git/lntt-messages', dir)).filter(
      (name) => name.endsWith('.md') && !name.endsWith('.answer.md'),
    )

  test('a child of a theme sends what is open to its coordinator, and says how to wait for the answer', () => {
    withMaxRounds(1)
    assert.equal(lntt(['--base', 'main'], open).code, 1)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'coordinator', theme: 'alpha' })

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    const [file, ...more] = messages('to-coordinator-alpha')
    assert.equal(more.length, 0)
    const id = (file as string).replace(/\.md$/, '')
    assert.match(id, /^\d{8}-\d{6}-issue-1-review-limit$/)
    const text = readFileSync(join(repo, '.git/lntt-messages/to-coordinator-alpha', file as string), 'utf8')
    assert.match(
      text,
      /^#1 feat\/1\/x: lntt review limit, round 2 would pass delivery\.review\.maxRounds \(1\); still open: f1 \(warning, confirmed\); decide: the pull request as it is, pnpm exec lntt review allow <rounds>, or an issue for what is open$/m,
    )
    assert.match(text, /^- f1 \[warning, confirmed\] a\.ts:1 — w — a$/m)
    assert.deepEqual(events().at(-1).asked, {
      id,
      to: 'coordinator',
      path: join(repo, '.git/lntt-messages/to-coordinator-alpha', file as string),
    })
    assert.match(
      r.err,
      new RegExp(
        `^lntt review: limit: sent ${id} to the coordinator alpha; wait with: pnpm exec lntt ask --wait ${id}$`,
        'm',
      ),
    )
  })

  test('a plain child sends what is open to the orchestrator, the topic tagged with its issue', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'orchestrator' })

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    const [file, ...more] = messages('to-orchestrator')
    assert.equal(more.length, 0)
    assert.match(file as string, /^\d{8}-\d{6}-issue-1-review-limit\.md$/)
    assert.equal(events().at(-1).asked.id, (file as string).replace(/\.md$/, ''))
    assert.match(r.err, /limit: sent \S+ to the orchestrator; wait with: pnpm exec lntt ask --wait /)
  })

  test('a limit already sent and not answered is not sent again; once answered, the next limit is', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'coordinator', theme: 'alpha' })

    const first = lntt(['--base', 'main'], open)
    assert.equal(first.code, 3, first.err)
    const id = events().at(-1).asked.id
    const again = lntt(['--base', 'main'], open)
    assert.equal(again.code, 3, again.err)
    assert.deepEqual(messages('to-coordinator-alpha'), [`${id}.md`])
    assert.equal(events().at(-1).asked.id, id)
    assert.match(
      again.err,
      new RegExp(
        `^lntt review: limit: already sent ${id} to the coordinator alpha; wait with: pnpm exec lntt ask --wait ${id}$`,
        'm',
      ),
    )

    writeFileSync(join(repo, '.git/lntt-messages/to-coordinator-alpha', `${id}.answer.md`), 'Open an issue.\n')
    const after = lntt(['--base', 'main'], open)
    assert.equal(after.code, 3, after.err)
    assert.equal(messages('to-coordinator-alpha').length, 2)
    assert.notEqual(events().at(-1).asked.id, id)
    assert.match(after.err, /limit: sent /)
  })

  test('a limit sent under a topic with a collision suffix is still the one waited on', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'coordinator', theme: 'alpha' })
    const id = '20260101-000000-issue-1-review-limit-2'
    mkdirSync(join(repo, '.git/lntt-messages/to-coordinator-alpha'), { recursive: true })
    writeFileSync(join(repo, '.git/lntt-messages/to-coordinator-alpha', `${id}.md`), '#1 feat/1/x: lntt review limit\n')
    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    assert.deepEqual(messages('to-coordinator-alpha'), [`${id}.md`])
    assert.equal(events().at(-1).asked.id, id)
  })

  test('another branch’s pending limit does not stand for this one', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'coordinator', theme: 'alpha' })
    mkdirSync(join(repo, '.git/lntt-messages/to-coordinator-alpha'), { recursive: true })
    writeFileSync(
      join(repo, '.git/lntt-messages/to-coordinator-alpha/20260101-000000-issue-2-review-limit.md'),
      '#2 feat/2/y: lntt review limit\n',
    )
    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    assert.equal(messages('to-coordinator-alpha').length, 2)
    assert.match(r.err, /limit: sent /)
  })

  test('a coordinator’s own branch sends its limit to the orchestrator, on no issue', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: null, to: 'orchestrator', theme: 'alpha' })

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    const [file, ...more] = messages('to-orchestrator')
    assert.equal(more.length, 0)
    assert.match(file as string, /^\d{8}-\d{6}-review-limit\.md$/)
    const text = readFileSync(join(repo, '.git/lntt-messages/to-orchestrator', file as string), 'utf8')
    assert.match(text, /^feat\/1\/x: lntt review limit, /)
    assert.ok(!existsSync(join(repo, '.git/lntt-messages/to-coordinator-alpha')))
  })

  test('a branch still on the name Orca gave it finds the marker of its conventional name', () => {
    git('branch', '-m', 'ilmeskio/feat-1-x')
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'orchestrator' })

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    const [file] = messages('to-orchestrator')
    assert.match(file as string, /^\d{8}-\d{6}-issue-1-review-limit\.md$/)
    const text = readFileSync(join(repo, '.git/lntt-messages/to-orchestrator', file as string), 'utf8')
    assert.match(text, /^#1 ilmeskio\/feat-1-x: lntt review limit, /)
  })

  test('a message that cannot be sent is a warning; the round still stops with exit 3', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    commit(3)
    startedBy({ branch: 'feat/1/x', issue: 1, to: 'orchestrator' })
    // A file where the directory of the message would go.
    writeFileSync(join(repo, '.git/lntt-messages/to-orchestrator'), '')

    const r = lntt(['--base', 'main'], open)
    assert.equal(r.code, 3, r.err)
    assert.match(r.err, /^lntt review: limit: could not send to the orchestrator: /m)
    assert.equal(events().at(-1).asked, undefined)
  })

  test('what is open at the limit: a withdrawn finding is not, a failed reviewer is', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    lntt(['reply', 'f1', 'no'], { FAKE_REPLY: 'withdrawn\\nfair' })
    commit(3)
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 3, r.err)
    assert.match(r.err, /still open: nothing$/m)
    assert.doesNotMatch(r.out, /^ {2}f1 /m)
    assert.equal(events().at(-1).open, 0)

    git('switch', '-qc', 'feat/2/y')
    commit(4)
    assert.equal(lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' }).code, 1)
    commit(5)
    const calls = readFileSync(log, 'utf8')
    const failed = lntt(['--base', 'main'])
    assert.equal(failed.code, 3, failed.err)
    assert.match(failed.err, /still open: code · claude sonnet failed$/m)
    assert.match(failed.out, /^ {2}code · claude sonnet failed: claude exited 1: boom$/m)
    assert.equal(events().at(-1).failed, 1)
    assert.equal(readFileSync(log, 'utf8'), calls, 'no agent started')
  })

  test('a person allows more rounds for the branch, and the next round runs', () => {
    withMaxRounds(1)
    assert.equal(lntt(['--base', 'main']).code, 0)
    commit(3)
    assert.equal(lntt(['--base', 'main']).code, 3)

    const allow = lntt(['allow', '2'])
    assert.equal(allow.code, 0, allow.err)
    assert.match(allow.err, /feat\/1\/x may take 3 rounds: delivery\.review\.maxRounds \(1\) and 2 allowed/)
    assert.equal(state().allowed, 2)
    assert.deepEqual(
      events().map((e) => [e.type, e.allowed]),
      [['allow', 2]],
      'the band no longer shows the limit',
    )

    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /round 2 done/)
    assert.equal(state().allowed, 2, 'kept by the round')
    assert.equal(lntt(['allow', '1']).code, 0)
    assert.equal(state().allowed, 3, 'added to what was allowed')
    assert.deepEqual(
      events().map((e) => [e.type, e.allowed]),
      [['allow', 3]],
    )
  })

  test('the rounds allowed count in the limit, and stay with their branch', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'])
    lntt(['allow', '1'])
    commit(3)
    assert.equal(lntt(['--base', 'main']).code, 0)
    commit(4)
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 3, r.err)
    assert.match(r.err, /delivery\.review\.maxRounds \(1\) and 1 allowed on feat\/1\/x/)
    assert.deepEqual(events().at(-1), { ...events().at(-1), round: 3, maxRounds: 1, allowed: 1 })

    git('switch', '-qc', 'feat/2/y')
    commit(5)
    assert.match(lntt(['allow', '1']).err, /no round on feat\/2\/y yet/)
    assert.equal(state().allowed, 1, "the other branch's state untouched")
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(state('feat/2/y').allowed, undefined, 'a new branch starts with nothing allowed')
    assert.equal(state().allowed, 1)
  })

  test('--plan names the limit; a run with no new commit is not a round and is not stopped', () => {
    withMaxRounds(1)
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(lntt(['--base', 'main']).code, 0, 'nothing new to read')
    commit(3)
    const plan = lntt(['--base', 'main', '--plan'])
    assert.equal(plan.code, 0, plan.err)
    assert.match(plan.err, /limit: round 2 would pass delivery\.review\.maxRounds \(1\): it will not start/)
  })

  test('allow is refused before any round on the branch, and with a count that is not a whole number from 1', () => {
    assert.match(lntt(['allow', '1']).err, /no round on feat\/1\/x yet/)
    assert.equal(existsSync(join(repo, '.git/lntt-review.progress')), false, 'a refused allow starts no progress')
    lntt(['--base', 'main'])
    const before = readFileSync(stateFile(), 'utf8')
    for (const count of [['0'], [], ['abc'], ['1.5'], ['-1'], ['1', '2']]) {
      assert.equal(lntt(['allow', ...count]).code, 2, `allow ${count.join(' ')}`)
    }
    assert.equal(readFileSync(stateFile(), 'utf8'), before)
  })

  test('a maxRounds below 1 does not validate', () => {
    withMaxRounds(0)
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 1)
    assert.match(r.err, /maxRounds must be >= 1/)
  })
})

describe("the cost of the branch's rounds", () => {
  const commit = (value: number) => {
    writeFileSync(join(repo, 'a.ts'), `export const a = ${value}\n`)
    git('commit', '-qam', `a = ${value}`)
  }
  const found = { FAKE_REVIEW: '- [warning] a.ts:1 — w — a', FAKE_VERIFY: 'confirmed\\np' }

  test('each round that read files is kept with its tokens and USD; lntt review cost prints their sum', () => {
    assert.equal(lntt(['cost']).out, 'no rounds\n', 'nothing yet on the branch')
    const first = lntt(['--base', 'main'])
    assert.equal(first.code, 0, first.err)
    assert.match(first.err, /round 1 done[^\n]*\nlntt review: branch total: 1 round, 1\.5k tokens, 0\.01 USD$/m)
    const one = reading()
    commit(3)
    const second = lntt(['--base', 'main'], found)
    assert.equal(second.code, 1, second.err)
    assert.match(second.err, /round 2 done[^\n]*\nlntt review: branch total: 2 rounds, 4\.5k tokens, 0\.03 USD$/m)
    const two = reading()
    const rounds = [
      { round: 1, head: one.head, tokens: one.tokens, usd: one.cost, noTokens: [], noUsd: [] },
      { round: 2, head: two.head, tokens: two.tokens, usd: two.cost, noTokens: [], noUsd: [] },
    ]
    assert.deepEqual(state().rounds, rounds)
    assert.deepEqual([one.tokens, one.cost, two.tokens, two.cost], [1500, 0.01, 3000, 0.02])

    const cost = lntt(['cost'])
    assert.equal(cost.code, 0, cost.err)
    assert.equal(cost.out, '2 rounds, 4.5k tokens, 0.03 USD\n')
    assert.deepEqual(JSON.parse(lntt(['cost', '--json']).out), {
      branch: 'feat/1/x',
      rounds,
      total: { rounds: 2, tokens: 4500, usd: 0.03, unrecorded: [], line: '2 rounds, 4.5k tokens, 0.03 USD' },
    })

    // No new commit: no round more, and nothing added. Nor by a reply, nor by allow.
    lntt(['--base', 'main'], found)
    assert.equal(lntt(['reply', 'f1', 'fine'], { FAKE_REPLY: 'kept\\nno' }).code, 1)
    assert.equal(lntt(['allow', '1']).code, 0)
    assert.deepEqual(state().rounds, rounds)
    assert.equal(state().allowed, 1)
  })

  test('a failed agent is a round that reported no tokens and no USD, named with its agent', () => {
    lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' })
    assert.deepEqual(state().rounds[0].noTokens, ['claude sonnet'])
    assert.equal(
      lntt(['cost']).out,
      '1 round, no tokens, no USD; no tokens: round 1 (claude sonnet); no USD: round 1 (claude sonnet)\n',
    )
  })

  test('another branch starts a list of its own', () => {
    lntt(['--base', 'main'])
    git('switch', '-qc', 'feat/2/y')
    commit(5)
    assert.equal(lntt(['cost']).out, 'no rounds\n')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.deepEqual(
      state('feat/2/y').rounds.map((r: { head: string }) => r.head),
      [git('rev-parse', '--short', 'HEAD')],
    )
    assert.equal(state().rounds.length, 1, "the other branch's list is its own")
  })

  test('a state saved before the rounds were kept names the rounds it has no cost for', () => {
    lntt(['--base', 'main'])
    const path = stateFile()
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    delete saved.rounds
    writeFileSync(path, JSON.stringify({ ...saved, round: 2 }))
    assert.equal(lntt(['cost']).out, 'no rounds; not recorded: rounds 1, 2\n')
    assert.deepEqual(JSON.parse(lntt(['cost', '--json']).out).total.unrecorded, [1, 2])
    commit(9)
    assert.match(
      lntt(['--base', 'main']).err,
      /^lntt review: branch total: 1 round, [^;]+; not recorded: rounds 1, 2$/m,
    )
  })

  test('a cost that cannot be read is an error, and leaves the progress of the last round alone', () => {
    lntt(['--base', 'main'])
    const progress = readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
    put(stateFile(), '{ cut short')
    const r = lntt(['cost'])
    assert.equal(r.code, 1)
    assert.match(r.err, /^lntt review: error: /m)
    assert.equal(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8'), progress)
  })

  test('at the limit: the branch total on stderr and in the message to the parent', () => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.maxRounds = 1
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'maxRounds 1')
    assert.equal(lntt(['--base', 'main'], found).code, 1)
    commit(3)
    mkdirSync(join(repo, '.git/lntt-messages/started'), { recursive: true })
    writeFileSync(
      join(repo, '.git/lntt-messages/started/feat%2F1%2Fx.json'),
      JSON.stringify({ branch: 'feat/1/x', issue: 1, to: 'orchestrator' }),
    )
    const r = lntt(['--base', 'main'], found)
    assert.equal(r.code, 3, r.err)
    const line = '1 round, 3k tokens, 0.02 USD'
    assert.match(r.err, new RegExp(`^lntt review: branch total: ${line.replace(/\./g, '\\.')}$`, 'm'))
    const dir = join(repo, '.git/lntt-messages/to-orchestrator')
    const [file] = readdirSync(dir).filter((name) => name.endsWith('.md') && !name.endsWith('.answer.md'))
    assert.match(readFileSync(join(dir, file as string), 'utf8'), new RegExp(`^review cost: ${line}$`, 'm'))
  })
})

// The 5-second SIGKILL timer of `terminate` is the only thing that can kill the stubborn
// agent while the round is open: the exit handler kills what is left only when lntt
// review exits, and a verifier holds the round open past the timer.
describe('an agent that ignores SIGTERM, while the round goes on', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test('is alive until the timer, and gone after it', { timeout: 60000 }, async () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus', optional: true },
                ],
              },
            },
            verify: { with: [{ kind: 'claude', model: 'haiku' }] },
            optionalGraceMinutes: 0,
          },
        },
      }),
    )
    git('commit', '-qam', 'stubborn optional, slow verifier')
    const pids = join(repo, '.pids')
    const release = join(bin, 'release')
    writeFileSync(pids, '')
    // The required reviewer answers once the optional one has named its pid, and the
    // grace (0) stops it at once; the verifier then holds the round open until released.
    const child = spawn(process.execPath, [BIN, 'review', '--base', 'main'], {
      cwd: repo,
      env: {
        HOME: repo,
        PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: log,
        FAKE_IGNORE_TERM_opus: '1',
        FAKE_PIDS: pids,
        FAKE_WAIT_FILE_sonnet: pids,
        FAKE_WAIT_FILE_haiku: release,
        FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d
    })
    const exited = new Promise((resolve) => child.on('exit', resolve))
    try {
      const until = Date.now() + 10_000
      while (!readFileSync(pids, 'utf8').trim() && Date.now() < until) await sleep(50)
      const pid = Number(readFileSync(pids, 'utf8').trim())
      assert.ok(pid > 0, `the stubborn agent named its pid: ${err}`)
      // SIGTERM follows the pid being named (the required reviewer answers after it), so
      // the timer's 5 seconds start no earlier than the file's last write.
      const stopped = statSync(pids).mtimeMs
      await sleep(Math.max(0, stopped + 2000 - Date.now()))
      assert.ok(alive(pid), 'SIGTERM did not stop it, and the timer has not fired yet')
      while (alive(pid) && Date.now() < stopped + 8000) await sleep(100)
      assert.ok(!alive(pid), 'the timer killed it while the round was still open')
      assert.ok(Date.now() - stopped >= 5000, 'not before the 5 seconds')
    } finally {
      writeFileSync(release, 'go\n')
      await exited
    }
  })
})

// The lock keeps a second round or reply from overwriting the state and the progress of
// the first (acquireLock, and the `own` guard of main).
describe('the lock of a worktree, held by a live process', () => {
  const lock = () => join(repo, '.git/lntt-review.lock')
  const progress = () => join(repo, '.git/lntt-review.progress')

  test('a reply takes it: refused while a round holds it, and the lock goes with the reply', () => {
    const r = lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a' })
    assert.equal(reading().findings[0].id, 'f1', r.err)
    writeFileSync(lock(), String(process.pid))
    const refused = lntt(['reply', 'f1', 'no'])
    assert.equal(refused.code, 1)
    assert.match(refused.err, /a round is already running in this worktree \(pid \d+\)/)
    assert.equal(readFileSync(lock(), 'utf8'), String(process.pid), 'the holder keeps its lock')
    rmSync(lock())
    lntt(['reply', 'f1', 'no'])
    assert.equal(existsSync(lock()), false, 'the lock goes with the reply')
  })

  test('--plan does not take it: it prints the plan, and the holder keeps its lock and progress', () => {
    lntt(['--base', 'main'])
    const before = readFileSync(progress(), 'utf8')
    writeFileSync(lock(), String(process.pid))
    const r = lntt(['--plan', '--base', 'main'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.err, /round \d+, /)
    assert.equal(readFileSync(lock(), 'utf8'), String(process.pid))
    assert.equal(readFileSync(progress(), 'utf8'), before)
  })

  test("a round it refuses leaves the running round's progress file alone", () => {
    writeFileSync(progress(), '{"type":"round","pid":1}\n')
    writeFileSync(lock(), String(process.pid))
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 1)
    assert.match(r.err, /^lntt review: error: a round is already running/m)
    assert.equal(readFileSync(progress(), 'utf8'), '{"type":"round","pid":1}\n')
  })
})

// lntt review signalled the agent's group: the SIGKILL that follows goes to the group
// whatever the leader did, so a child that ignored SIGTERM does not outlive it. A verifier
// holds the round open, so only the timer can be what kills the child.
describe('a child of an agent that exited on SIGTERM', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test('is killed with its group, though the leader is gone', { timeout: 60000 }, async () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        delivery: {
          review: {
            reviewers: {
              decisions: { with: [] },
              tests: { with: [] },
              code: {
                with: [
                  { kind: 'claude', model: 'sonnet' },
                  { kind: 'claude', model: 'opus', optional: true },
                ],
              },
            },
            verify: { with: [{ kind: 'claude', model: 'haiku' }] },
            optionalGraceMinutes: 0,
          },
        },
      }),
    )
    git('commit', '-qam', 'orphan child, slow verifier')
    const pids = join(repo, '.pids')
    const childPids = join(repo, '.caffeinate')
    const release = join(bin, 'release')
    writeFileSync(pids, '')
    writeFileSync(childPids, '')
    const lntt = spawn(process.execPath, [BIN, 'review', '--base', 'main'], {
      cwd: repo,
      env: {
        HOME: repo,
        PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: log,
        FAKE_ORPHAN_opus: '1',
        FAKE_PIDS: pids,
        FAKE_CHILD_PIDS: childPids,
        FAKE_WAIT_FILE_sonnet: pids,
        FAKE_WAIT_FILE_haiku: release,
        FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const exited = new Promise((resolve) => lntt.on('exit', resolve))
    let child = 0
    try {
      const until = Date.now() + 10_000
      while (!readFileSync(pids, 'utf8').trim() && Date.now() < until) await sleep(50)
      child = Number(readFileSync(childPids, 'utf8').trim())
      assert.ok(child > 0, 'the child named its pid')
      const stopped = statSync(pids).mtimeMs
      while (alive(child) && Date.now() < stopped + 8000) await sleep(100)
      assert.ok(!alive(child), 'the child that ignored SIGTERM is gone while the round is still open')
    } finally {
      writeFileSync(release, 'go\n')
      await exited
      if (child > 0) {
        try {
          process.kill(child, 'SIGKILL')
        } catch {}
      }
    }
  })
})

describe('the base a round reads from', () => {
  let tmp: string
  let c: Clone

  const withCandidate = (config: Record<string, unknown>) =>
    JSON.stringify({ ...JSON.parse(CONFIG), delivery: { ...JSON.parse(CONFIG).delivery, ...config } })

  // A gh that answers the open-candidate query.
  function gh(): void {
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\ncase "$*" in *"pr list"*) echo '[{"number":40,"headRefName":"candidate/13","body":""}]';; esac\n`,
    )
    chmodSync(join(bin, 'gh'), 0o755)
  }

  // The first commit the plan's range starts from.
  const from = (err: string) => /round 1, first round: (\w+)\.\./.exec(err)?.[1]
  const short = (sha: string) => c.git('rev-parse', '--short', sha)

  function branch(config: string, from: string): void {
    c = clone(tmp, { '.agents/config.jsonc': config })
    repo = c.repo
    c.git('switch', '-qc', 'feat/5/x', from)
    c.git('commit', '-q', '--allow-empty', '-m', 'mine')
  }

  beforeEach(() => {
    rmSync(repo, { recursive: true, force: true })
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-base-')))
    bin = join(tmp, 'bin')
    log = join(tmp, 'log')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
    chmodSync(join(bin, 'claude'), 0o755)
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test('with no candidate: origin/main, not the stale local main', () => {
    branch(CONFIG, 'origin/main')
    const r = lntt(['--plan'])
    assert.equal(r.code, 0, r.err)
    assert.equal(from(r.err), short(c.main))
  })

  test('a branch on the open candidate: from where it left the candidate', () => {
    branch(withCandidate({ candidate: { prefix: 'candidate/' } }), 'origin/candidate/13')
    gh()
    const r = lntt(['--plan'], { GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.code, 0, r.err)
    assert.equal(from(r.err), short(c.candidate))
  })

  test('an explicit --base wins over the open candidate', () => {
    branch(withCandidate({ candidate: { prefix: 'candidate/' } }), 'origin/candidate/13')
    gh()
    const r = lntt(['--plan', '--base', 'main'], { GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.code, 0, r.err)
    assert.equal(from(r.err), short(c.main))
  })

  test('GitHub unreachable (no gh): origin/main, and it says so', () => {
    branch(withCandidate({ candidate: { prefix: 'candidate/' } }), 'origin/candidate/13')
    const r = lntt(['--plan'], { GITHUB_REPOSITORY: 'o/r' })
    assert.equal(r.code, 0, r.err)
    assert.equal(from(r.err), short(c.main))
    assert.match(r.err, /the open candidate is unknown/)
  })
})

// `lntt review status`: the worktree's state read through lntt review, never from the
// files in the git directory; exit 0 clean, 1 to act on, 3 at the limit, 4 no round here.
describe('lntt review status', () => {
  const gitDir = (...names: string[]) => join(repo, '.git', ...names)
  const json = (args: string[] = [], env: Record<string, string> = {}) => {
    const r = lntt(['status', '--json', ...args], env)
    return { code: r.code, out: JSON.parse(r.out), err: r.err }
  }
  const first = (out: string) => out.split('\n').find((line) => line.startsWith('lntt review: ')) as string
  const blocker = { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\na.ts:1 shows it' }

  test('an own clean round: exit 0, the outcome line, and the JSON', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    const head = git('rev-parse', '--short', 'HEAD')
    const r = lntt(['status'])
    assert.equal(r.code, 0, r.err)
    assert.match(
      first(r.out),
      new RegExp(
        `^lntt review: feat/1/x: round 1 of 4, reviewed ${head}, clean; 0 open, 0 replied, 0 closed, 1\\.5k tokens, \\$0\\.01$`,
      ),
    )
    assert.equal(r.out.split('\n').at(-2), first(r.out), 'nothing to act on: the outcome line ends it')
    const j = json()
    assert.equal(j.code, 0)
    assert.equal(j.out.branch, 'feat/1/x')
    assert.equal(j.out.running, null)
    assert.equal(j.out.state.branch, 'feat/1/x')
    assert.equal(j.out.state.current, true)
    assert.equal(j.out.state.merged, null, 'no origin: whether it is merged cannot be told')
    assert.equal(j.out.state.round, 1)
    assert.equal(j.out.state.maxRounds, 4)
    assert.equal(j.out.state.allowed, 0)
    assert.equal(j.out.state.limit, 4)
    assert.equal(j.out.state.reviewed, head)
    assert.equal(j.out.state.clean, true)
    assert.equal(j.out.state.atLimit, false)
    assert.deepEqual(j.out.state.open, [])
    assert.deepEqual(j.out.state.replied, [])
    assert.deepEqual(j.out.state.closed, [])
    assert.equal(j.out.state.tokens, 1500)
    assert.equal(j.out.state.cost, 0.01)
    assert.match(j.out.state.updated, /^\d{4}-\d\d-\d\dT/)
    for (const key of [
      'branch',
      'current',
      'updated',
      'merged',
      'round',
      'maxRounds',
      'allowed',
      'limit',
      'reviewed',
      'base',
      'head',
      'clean',
      'atLimit',
      'blocking',
      'open',
      'replied',
      'closed',
      'failed',
      'partial',
      'skipped',
      'tokens',
      'cost',
      'findings',
      'refuted',
      'repeated',
      'rounds',
    ])
      assert.ok(key in j.out.state, key)
    assert.deepEqual([j.out.state.findings, j.out.state.refuted, j.out.state.repeated], [[], [], []])
    assert.deepEqual(
      j.out.state.rounds.map((c: { round: number; usd: number }) => [c.round, c.usd]),
      [[1, 0.01]],
    )
  })

  test('a confirmed blocker: exit 1 and its line; kept by a reply it stays open, withdrawn it is closed', () => {
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    const r = lntt(['status'])
    assert.equal(r.code, 1, r.err)
    assert.match(first(r.out), /, not clean; 1 open \(1 blocking\), 0 replied, 0 closed/)
    assert.match(r.out, /^ {2}f1 blocker confirmed a\.ts:1 — wrong$/m)

    assert.equal(lntt(['reply', 'f1', 'no'], { FAKE_REPLY: 'kept\\nstill wrong' }).code, 1)
    const kept = json()
    assert.equal(kept.code, 1)
    assert.deepEqual(
      kept.out.state.open.map((f: { id: string }) => f.id),
      ['f1'],
    )
    assert.deepEqual(kept.out.state.replied[0].reply, { answer: 'no', withdrawn: false })

    assert.equal(lntt(['reply', 'f1', 'line 1 is the point'], { FAKE_REPLY: 'withdrawn\\nfair' }).code, 0)
    const withdrawn = json()
    assert.equal(withdrawn.code, 0)
    assert.deepEqual(withdrawn.out.state.open, [])
    assert.deepEqual(
      withdrawn.out.state.replied.map((f: { id: string; verdict: string }) => [f.id, f.verdict]),
      [['f1', 'withdrawn']],
    )
    assert.deepEqual(
      withdrawn.out.state.closed.map((c: { id: string; outcome: string }) => [c.id, c.outcome]),
      [['f1', 'refuted']],
    )
    assert.match(first(lntt(['status']).out), /, clean; 0 open, 1 replied, 1 closed/)
  })

  test('a reviewer that failed: exit 1 and its line', () => {
    assert.equal(lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' }).code, 1)
    const r = lntt(['status'])
    assert.equal(r.code, 1, r.err)
    assert.match(first(r.out), /reviewed nothing, not clean; 0 open, 0 replied, 0 closed, 1 failed/)
    assert.match(r.out, /^ {2}code · claude sonnet failed: claude exited 1: boom$/m)
  })

  test('at the limit: exit 3, said, atLimit true', () => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.maxRounds = 1
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'maxRounds 1')
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    const r = lntt(['status'])
    assert.equal(r.code, 3, r.err)
    assert.match(first(r.out), /^lntt review: feat\/1\/x: round 1 of 1, reviewed \w+, not clean, at the limit; 1 open/)
    const j = json()
    assert.equal(j.code, 3)
    assert.equal(j.out.state.atLimit, true)
    assert.equal(j.out.state.limit, 1)

    assert.equal(lntt(['allow', '1']).code, 0)
    const allowed = json()
    assert.equal(allowed.code, 1, 'the rounds allowed lift the limit')
    assert.equal(allowed.out.state.allowed, 1)
    assert.equal(allowed.out.state.limit, 2)
    assert.equal(allowed.out.state.atLimit, false)
    assert.match(first(lntt(['status']).out), /round 1 of 2, reviewed \w+, not clean; 1 open \(1 blocking\)/)
  })

  test('a clean round at the limit is clean: exit 0', () => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.maxRounds = 1
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'maxRounds 1')
    assert.equal(lntt(['--base', 'main']).code, 0)
    const j = json()
    assert.equal(j.code, 0)
    assert.equal(j.out.state.atLimit, false)
    assert.match(first(lntt(['status']).out), /round 1 of 1, reviewed \w+, clean;/)
  })

  test("another branch's state is none here and stays where it is; a detached HEAD has no round", () => {
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    git('switch', '-qc', 'feat/2/y')
    const r = lntt(['status'])
    assert.equal(r.code, 4, r.err)
    assert.equal(r.out, 'lntt review: no round on feat/2/y yet\n')
    assert.deepEqual(json().out, { branch: 'feat/2/y', running: null, state: null })
    assert.equal(existsSync(stateFile()), true, "feat/1/x's state is where it was")

    git('switch', '-q', 'feat/1/x')
    assert.equal(lntt(['status']).code, 1, 'found again on its own branch')
    git('switch', '-q', '--detach')
    const detached = lntt(['status'])
    assert.equal(detached.code, 4)
    assert.equal(detached.out, 'lntt review: no round on detached HEAD yet\n')
    assert.deepEqual(json().out, { branch: null, running: null, state: null })
  })

  test('no state: exit 4, and state null', () => {
    const r = lntt(['status'])
    assert.equal(r.code, 4, r.err)
    assert.equal(r.out, 'lntt review: no round on feat/1/x yet\n')
    assert.deepEqual(json().out, { branch: 'feat/1/x', running: null, state: null })
  })

  test('a state that cannot be read: an error, exit 1, and --clear removes it', () => {
    for (const text of ['{', 'null', '[]', '{"branch":"feat/1/x","round":1,"reviewed":null}']) {
      put(stateFile(), text)
      const r = lntt(['status'])
      assert.equal(r.code, 1, text)
      assert.match(
        r.err,
        /^lntt review: error: .*state\/feat%2F1%2Fx\.json cannot be read: pnpm exec lntt review status --clear removes it$/m,
        text,
      )
    }
    const cleared = lntt(['status', '--clear'])
    assert.equal(cleared.code, 0, cleared.err)
    assert.match(cleared.out, /^lntt review: cleared an unreadable state: its state$/m)
    assert.ok(!existsSync(stateFile()))
  })

  test('a state written before a field existed reads with its default', () => {
    const r = lntt(['--base', 'main'], {
      FAKE_REVIEW: '- [note] a.ts:1 — n — fix\\n- [blocker] .agents/config.jsonc:1 — b — fix',
      FAKE_VERIFY: 'confirmed\\np',
    })
    assert.equal(r.code, 1, r.err)
    const old = state()
    delete old.result.blocking
    delete old.result.skipped
    delete old.result.closed
    delete old.rounds
    // A note listed before the blocker: the summary still puts what blocks first.
    old.result.findings.reverse()
    put(stateFile(), JSON.stringify(old))
    const summary = lntt(['status'])
    assert.equal(summary.code, 1, summary.err)
    assert.match(
      summary.out,
      /^ {2}f\d blocker confirmed \.agents\/config\.jsonc:1 — b\n {2}f\d note unverified a\.ts:1 — n$/m,
    )
    const json = JSON.parse(lntt(['status', '--json']).out)
    assert.deepEqual(json.state.blocking, ['blocker', 'warning'])
    assert.deepEqual(json.state.skipped, [])
    assert.deepEqual(json.state.repeated, [])
    assert.deepEqual(json.state.rounds, [])
  })

  test('a branch with no commit yet is named, not taken for a detached HEAD', () => {
    git('switch', '-q', '--orphan', 'feat/9/new')
    const r = lntt(['status'])
    assert.equal(r.code, 4)
    assert.match(r.out, /^lntt review: no round on feat\/9\/new yet$/m)
  })

  test('a lock created an instant ago is no round running yet, and --clear waits for it', () => {
    git('switch', '-qc', 'feat/2/y')
    writeFileSync(gitDir('lntt-review.lock'), '')
    const r = lntt(['status', '--json'])
    assert.equal(JSON.parse(r.out).running, null)
    assert.doesNotMatch(lntt(['status']).out, /running/)
    const cleared = lntt(['status', '--clear'])
    assert.equal(cleared.code, 1)
    assert.match(cleared.err, /a round is running in this worktree \(pid starting\): nothing cleared/)
  })

  test('in a linked worktree and in the main checkout, each reads its own state', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-wt-')))
    const wt = join(dir, 'wt')
    const main = repo
    try {
      assert.equal(lntt(['--base', 'main']).code, 0)
      git('worktree', 'add', '-q', '-b', 'feat/3/z', wt, 'main')
      repo = wt
      writeFileSync(join(wt, 'a.ts'), 'export const a = 3\n')
      git('commit', '-qam', 'another change')
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      const linked = lntt(['status'])
      assert.equal(linked.code, 1, linked.err)
      assert.match(first(linked.out), /^lntt review: feat\/3\/z: round 1 of 4/)
      repo = main
      const own = lntt(['status'])
      assert.equal(own.code, 0, own.err)
      assert.match(first(own.out), /^lntt review: feat\/1\/x: round 1 of 4, reviewed \w+, clean/)
      assert.doesNotMatch(own.out, /^ {2}f1 |feat\/3\/z/m, 'a line of f1: the reviewed sha may hold those letters')
    } finally {
      repo = main
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a round running: reported with its pid, and --clear refused with nothing removed', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    git('switch', '-qc', 'feat/2/y')
    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' })
    try {
      writeFileSync(gitDir('lntt-review.lock'), String(sleeper.pid))
      const r = lntt(['status'])
      assert.equal(r.code, 4)
      assert.match(r.out, new RegExp(`; a round is running \\(pid ${sleeper.pid}\\)\\n$`))
      assert.equal(json().out.running, sleeper.pid)
      const clear = lntt(['status', '--clear'])
      assert.equal(clear.code, 1)
      assert.match(clear.err, /^lntt review: error: /m)
      assert.equal(existsSync(stateFile()), true)
      assert.equal(readFileSync(gitDir('lntt-review.lock'), 'utf8'), String(sleeper.pid))
    } finally {
      sleeper.kill()
    }
  })

  test('--clear: refused on the current unmerged branch, whose state stays; the lock is never removed', () => {
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    assert.equal(lntt(['reply', 'f1', 'fair'], { FAKE_REPLY: 'withdrawn\\nfair' }).code, 0)
    const refused = lntt(['status', '--clear'])
    assert.equal(refused.code, 1)
    assert.match(
      refused.err,
      /^lntt review: error: the state is feat\/1\/x's, the current branch, and whether it is merged cannot be told \(.+\): nothing cleared$/m,
    )
    assert.equal(existsSync(stateFile()), true)

    const dead = spawnSync('true').pid as number
    writeFileSync(gitDir('lntt-review.lock'), String(dead))
    assert.equal(json().out.running, null, 'a lock whose process is gone is no round running')
    assert.equal(lntt(['status', '--clear']).code, 1, 'still not merged')
    assert.equal(existsSync(stateFile()), true)
    assert.equal(existsSync(ledgerFile()), true)
    assert.equal(readFileSync(gitDir('lntt-review.lock'), 'utf8'), String(dead), 'the lock is never removed')

    git('switch', '-qc', 'feat/2/y')
    const nothing = lntt(['status', '--clear'])
    assert.equal(nothing.code, 0)
    assert.equal(nothing.out, 'lntt review: nothing to clear\n')
    assert.equal(existsSync(stateFile()), true, "another branch's state is not this branch's to clear")
  })

  test('--clear of a state that cannot be read keeps the ledger of a branch that is not merged', () => {
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    assert.equal(lntt(['reply', 'f1', 'fair'], { FAKE_REPLY: 'withdrawn\\nfair' }).code, 0)
    const ledger = readFileSync(ledgerFile(), 'utf8')
    put(stateFile(), '{')
    const r = lntt(['status', '--clear'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'lntt review: cleared an unreadable state: its state and progress\n')
    assert.equal(existsSync(stateFile()), false)
    assert.equal(readFileSync(ledgerFile(), 'utf8'), ledger)
  })

  test('a ledger that cannot be read closes nothing in status', () => {
    assert.equal(lntt(['--base', 'main'], blocker).code, 1)
    assert.equal(lntt(['reply', 'f1', 'fair'], { FAKE_REPLY: 'withdrawn\\nfair' }).code, 0)
    put(ledgerFile(), '{')
    assert.deepEqual(json().out.state.closed, [])
  })

  test('--clear on the current branch once it is merged into the base', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-origin-')))
    try {
      assert.equal(lntt(['--base', 'main']).code, 0)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')])
      git('remote', 'add', 'origin', join(dir, 'origin.git'))
      git('push', '-q', 'origin', 'main:main')
      git('fetch', '-q', 'origin')
      assert.equal(json().out.state.merged, false)
      const refused = lntt(['status', '--clear'])
      assert.equal(refused.code, 1)
      assert.match(refused.err, /the current branch, and it is not merged \(not in origin\/main\): nothing cleared$/m)

      git('push', '-q', 'origin', 'feat/1/x:main')
      git('fetch', '-q', 'origin')
      assert.equal(json().out.state.merged, true)
      // A candidate GitHub cannot name (no gh here): the base may be the wrong one, so
      // whether the branch is merged cannot be told, and --clear says why.
      const config = JSON.parse(CONFIG)
      config.delivery.candidate = { prefix: 'candidate/' }
      writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
      assert.equal(json().out.state.merged, null)
      const unknown = lntt(['status', '--clear'])
      assert.equal(unknown.code, 1)
      assert.match(unknown.err, /whether it is merged cannot be told \(the open candidate is unknown/)
      git('checkout', '-q', '--', '.agents/config.jsonc')
      const r = lntt(['status', '--clear'])
      assert.equal(r.code, 0, r.err)
      assert.equal(r.out, "lntt review: cleared feat/1/x's state, ledger and progress\n")
      assert.equal(existsSync(stateFile()), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--clear with --json, and an unknown flag: usage, exit 2', () => {
    assert.equal(lntt(['status', '--clear', '--json']).code, 2)
    assert.equal(lntt(['status', '--nope']).code, 2)
  })
})

// What an agent reads of a round: a summary by default, each level folded, a part of the
// state with a jq query.
describe('reading a part of the review state', () => {
  const blocker = { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\na.ts:1 shows it' }
  const commit = (value: number) => {
    writeFileSync(join(repo, 'a.ts'), `export const a = ${value}\n`)
    git('commit', '-qam', `a = ${value}`)
  }
  const query = (expression: string, ...flags: string[]) => lntt(['status', `--query=${expression}`, ...flags])
  const withMaxRounds = (n: number) => {
    const config = JSON.parse(CONFIG)
    config.delivery.review.maxRounds = n
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', `maxRounds ${n}`)
  }

  const finding = (id: string, severity: string, verdict: string) => ({
    id,
    severity,
    verdict,
    path: 'a.ts',
    line: 1,
    what: `${id} what`,
    action: 'act',
    foundBy: [],
    proofs: [],
  })
  // A state with something in every list, written by hand: no round produces all of it.
  const fullState = () => {
    const cost = (round: number) => ({ round, head: 'h', tokens: 1, usd: 0.5, noTokens: [], noUsd: [] })
    put(
      stateFile(),
      JSON.stringify({
        branch: 'feat/1/x',
        round: 4,
        reviewed: 'abc',
        result: {
          round: 4,
          base: 'b',
          head: 'h',
          scope: 'first round',
          lenses: ['code'],
          findings: [
            finding('f1', 'note', 'unverified'),
            finding('f2', 'blocker', 'confirmed'),
            finding('f3', 'warning', 'withdrawn'),
          ],
          refuted: [finding('f4', 'warning', 'refuted'), finding('f5', 'blocker', 'refuted')],
          failed: [{ lens: 'code', agent: 'claude x', error: 'boom' }],
          partial: [{ lens: 'tests', agent: 'claude y', lines: ['l1', 'l2'], reply: 'r' }],
          skipped: [],
          closed: [{ ...finding('f6', 'warning', 'unverified'), closedBy: 'f0', closedWhat: 'the old text' }],
          blocking: ['blocker', 'warning'],
          cost: 1.5,
          tokens: 2000,
          noTokens: [],
          noUsd: [],
        },
        rounds: [cost(1), cost(2), cost(3), cost(4)],
      }),
    )
    put(ledgerFile(), JSON.stringify({ branch: 'feat/1/x', closed: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })) }))
  }

  describe('status, folded', () => {
    const THINGS = [
      'lntt review: feat/1/x: round 4 of 4, reviewed abc, not clean, at the limit; 2 open (1 blocking), 1 replied, 5 closed, 1 failed, 1 partial, 2k tokens, $1.50',
      '  f2 blocker confirmed a.ts:1 — f2 what',
      '  f1 note unverified a.ts:1 — f1 what',
      '  code · claude x failed: boom',
      '  tests · claude y: 2 lines not read',
      '  f6 warning repeats f0 a.ts:1 — f6 what',
    ]

    test('each level as its count, a zero shown, then the outcome and what to act on', () => {
      fullState()
      const r = lntt(['status'])
      assert.equal(r.code, 3, r.err)
      assert.equal(
        r.out,
        `${[
          'findings: 3 (2 open)',
          'refuted: 2',
          'repeated: 1',
          'closed: 5',
          'failed: 1',
          'partial: 1',
          'skipped: 0',
          'rounds: 4',
          ...THINGS,
        ].join('\n')}\n`,
      )
    })

    test('a clean round has every count at zero, and its one line', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const head = git('rev-parse', '--short', 'HEAD')
      const r = lntt(['status'])
      assert.equal(r.code, 0, r.err)
      assert.equal(
        r.out,
        [
          'findings: 0 (0 open)',
          'refuted: 0',
          'repeated: 0',
          'closed: 0',
          'failed: 0',
          'partial: 0',
          'skipped: 0',
          'rounds: 1',
          `lntt review: feat/1/x: round 1 of 4, reviewed ${head}, clean; 0 open, 0 replied, 0 closed, 1.5k tokens, $0.01`,
          '',
        ].join('\n'),
      )
    })

    test('a failed agent takes one short line, its whole error left in the state', () => {
      fullState()
      const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
      saved.result.failed = [
        { lens: 'code', agent: 'a', error: 'first\nsecond' },
        { lens: 'code', agent: 'b', error: 'x'.repeat(40_000) },
      ]
      put(stateFile(), JSON.stringify(saved))
      const lines = lntt(['status']).out.split('\n')
      assert.ok(lines.includes('  code · a failed: first …'), lines.join('\n'))
      assert.ok(lines.includes(`  code · b failed: ${'x'.repeat(200)}…`), 'capped')
      assert.equal(lines.includes('second'), false)
      assert.equal(query('.state.failed[0].error').out, 'first\nsecond\n')
    })

    test('a skipped agent is counted on the outcome line', () => {
      fullState()
      const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
      saved.result.skipped = [{ lens: 'code', agent: 'a', error: 'e' }]
      put(stateFile(), JSON.stringify(saved))
      assert.match(lntt(['status']).out, /, 1 partial, 1 skipped, /)
    })

    test("no state, and another branch's: the one line, nothing folded", () => {
      assert.equal(lntt(['status']).out, 'lntt review: no round on feat/1/x yet\n')
      fullState()
      git('switch', '-qc', 'feat/2/y')
      const r = lntt(['status'])
      assert.equal(r.code, 4, r.err)
      assert.equal(r.out.split('\n').length, 2, r.out)
      assert.equal(r.out, 'lntt review: no round on feat/2/y yet\n')
    })

    test('a state saved before scope and lenses existed reads with their defaults', () => {
      fullState()
      const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
      delete saved.result.scope
      delete saved.result.lenses
      put(stateFile(), JSON.stringify(saved))
      assert.equal(query('.state | [.scope, .lenses]').out, '["",[]]\n')
    })

    test('--json carries the last round whole, and the rounds', () => {
      fullState()
      const { state } = JSON.parse(lntt(['status', '--json']).out)
      const ids = (list: { id: string }[]) => list.map((f) => f.id)
      assert.deepEqual(ids(state.findings), ['f1', 'f2', 'f3'])
      assert.deepEqual(ids(state.open), ['f1', 'f2'])
      assert.deepEqual(ids(state.refuted), ['f4', 'f5'])
      assert.deepEqual(ids(state.closed), ['a', 'b', 'c', 'd', 'e'])
      assert.deepEqual(state.repeated[0].closedBy, 'f0')
      assert.deepEqual(state.repeated[0].closedWhat, 'the old text')
      assert.deepEqual([state.scope, state.lenses], ['first round', ['code']])
      assert.deepEqual(
        state.rounds.map((c: { round: number }) => c.round),
        [1, 2, 3, 4],
      )
    })
  })

  describe('status --query', () => {
    test('a path, a slice and the shorthand for several fields; exit as status', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const clean = query('.state.clean')
      assert.deepEqual([clean.code, clean.out], [0, 'true\n'])
      commit(3)
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      const path = query('.state.findings[] | select(.id=="f1") | .severity')
      assert.deepEqual([path.code, path.out], [1, 'blocker\n'])
      const slice = query('.state.rounds[1:3][] | {round,usd}')
      assert.deepEqual([slice.code, slice.out], [1, '{"round":2,"usd":0.02}\n'])
    })

    test('a string is raw, and quoted with --json; several outputs take a line each', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      assert.equal(query('.branch').out, 'feat/1/x\n')
      assert.equal(query('.branch', '--json').out, '"feat/1/x"\n')
      assert.equal(query('.branch, .state.round').out, 'feat/1/x\n1\n')
      assert.equal(query('.branch, .state.round', '--json').out, '"feat/1/x"\n1\n')
      assert.equal(query('.state.blocking', '--json').out, '["blocker","warning"]\n', 'compact')
      assert.equal(query('empty').out, '', 'no output, no empty line')
    })

    test('an expression that does not compile: exit 2, nothing on stdout, the message on stderr', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const r = query('.state |')
      assert.equal(r.code, 2)
      assert.equal(r.out, '')
      assert.match(r.err, /jq: error: syntax error/)
    })

    test('a failure while running: exit 2, and what jq had printed is dropped', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const r = query('.state.round, error("boom")')
      assert.equal(r.code, 2)
      assert.equal(r.out, '')
      assert.match(r.err, /boom/)
      const halted = query('.state.round, ("stop" | halt_error(7))')
      assert.equal(halted.code, 2, 'whatever exit jq halts with')
      assert.equal(halted.out, '')
      assert.match(halted.err, /stop/)
    })

    test('no state: exit 4, a failure on what is not there says no round, and a bad expression stays a usage error', () => {
      const failing = query('.state.open[]')
      assert.equal(failing.code, 4)
      assert.equal(failing.out, '')
      assert.match(failing.err, /^lntt review: no round on feat\/1\/x yet\njq: error .*Cannot iterate over null/)
      const state = query('.state')
      assert.deepEqual([state.code, state.out], [4, 'null\n'])
      const bad = query('.state |')
      assert.equal(bad.code, 2)
      assert.match(bad.err, /syntax error/)
    })

    test("another branch's state is none here: exit 4, and a failure on it too", () => {
      fullState()
      git('switch', '-qc', 'feat/2/y')
      const r = query('.state')
      assert.deepEqual([r.code, r.out], [4, 'null\n'])
      assert.equal(query('.state.round[]').code, 4)
    })

    test('not clean exits 1, at the limit 3', () => {
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      assert.equal(query('.state.clean').code, 1)
      withMaxRounds(1)
      const limit = query('.state.atLimit')
      assert.deepEqual([limit.code, limit.out], [3, 'true\n'])
    })

    test('the wasm giving up is a jq failure: exit 2, whatever the state says', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const r = query('def f: 1+f; f')
      assert.equal(r.code, 2, r.err)
      assert.equal(r.out, '')
      assert.match(r.err, /jq gave up/)
    })

    test('a signal ends a query that does not end', async () => {
      const child = spawn(process.execPath, [BIN, 'review', 'status', '--query=repeat(1)|empty'], {
        cwd: repo,
        env: { HOME: repo, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
        stdio: 'ignore',
      })
      const ended = new Promise<string | null>((resolve) => child.on('exit', (_, signal) => resolve(signal)))
      // The time to reach the query; a slow machine only signals it sooner, which also ends it.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      child.kill('SIGTERM')
      const hung = setTimeout(() => child.kill('SIGKILL'), 8000)
      const signal = await ended
      clearTimeout(hung)
      assert.equal(signal, 'SIGTERM')
    })

    test('a long document arrives whole through a pipe', () => {
      fullState()
      const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
      saved.result.findings[0].what = 'x'.repeat(500_000)
      put(stateFile(), JSON.stringify(saved))
      const json = lntt(['status', '--json'])
      assert.equal(JSON.parse(json.out).state.findings[0].what.length, 500_000)
      assert.equal(query('.state.findings[0].what').out.length, 500_001)
    })

    test('a reader that leaves early does not make it fail', () => {
      fullState()
      const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
      saved.result.findings[0].what = 'x'.repeat(1_000_000)
      put(stateFile(), JSON.stringify(saved))
      const shell = `{ '${process.execPath}' '${BIN}' review status --json; echo "code $?" >&2; } | head -c 1 >/dev/null`
      const r = spawnSync('sh', ['-c', shell], {
        cwd: repo,
        encoding: 'utf8',
        env: { HOME: repo, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
      })
      assert.equal(r.stderr, 'code 3\n')
    })

    test('--clear does not take it, and it needs an expression', () => {
      assert.equal(lntt(['status', '--clear', '--query=.']).code, 2)
      assert.equal(lntt(['status', '--query']).code, 2)
      assert.equal(lntt(['status', '--query=']).code, 2)
    })

    test('an expression starting with a dash is an expression, never a flag of jq', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      for (const expression of ['--help', '--version', '-h', '-n', '-e', '--arg', '--']) {
        const r = query(expression)
        assert.equal(r.code, 2, expression)
        assert.equal(r.out, '', expression)
        assert.match(r.err, /jq: error/, expression)
      }
      assert.deepEqual([query('-1').code, query('-1').out], [0, '-1\n'], 'one that is a valid expression runs as one')
    })

    test('what jq itself sends to stderr on a success goes there', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const r = query('.branch | debug')
      assert.equal(r.code, 0)
      assert.equal(r.out, 'feat/1/x\n')
      assert.match(r.err, /DEBUG/)
    })
  })

  describe("a round's stdout", () => {
    // The lines of status past its folded block: what a round prints.
    const statusThings = () => `${lntt(['status']).out.split('\n').slice(8).join('\n')}`

    test('is the summary of status, a finding per line and no JSON', () => {
      const r = lntt(['--base', 'main'], blocker)
      assert.equal(r.code, 1, r.err)
      const head = git('rev-parse', '--short', 'HEAD')
      assert.equal(
        r.out,
        [
          `lntt review: feat/1/x: round 1 of 4, reviewed ${head}, not clean; 1 open (1 blocking), 0 replied, 0 closed, 3k tokens, $0.02`,
          '  f1 blocker confirmed a.ts:1 — wrong',
          '',
        ].join('\n'),
      )
      assert.equal(r.out, statusThings())
    })

    test('a clean round is its one line', () => {
      const r = lntt(['--base', 'main'])
      assert.equal(r.code, 0, r.err)
      assert.equal(r.out.split('\n').length, 2, r.out)
      assert.equal(r.out, statusThings())
    })

    test('names a failed reviewer', () => {
      const r = lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' })
      assert.equal(r.code, 1)
      assert.equal(
        r.out,
        [
          'lntt review: feat/1/x: round 1 of 4, reviewed nothing, not clean; 0 open, 0 replied, 0 closed, 1 failed',
          '  code · claude sonnet failed: claude exited 1: boom',
          '',
        ].join('\n'),
      )
      assert.equal(r.out, statusThings())
    })

    test('names a lens read in part, and the lines stay in the state', () => {
      const r = lntt(['--base', 'main'], {
        FAKE_REVIEW: '- [warning] a.ts:1 — x — y\\n- [blocker] something went wrong',
        FAKE_VERIFY: 'confirmed\\nshown',
      })
      assert.equal(r.code, 1, r.err)
      assert.match(r.out, /^ {2}code · claude sonnet: 1 lines not read$/m)
      assert.equal(r.out, statusThings())
      assert.equal(query('.state.partial[0].lines[0]').out, '- [blocker] something went wrong\n')
    })

    test('names a finding that repeats a closed one; its text and the refuted ones are read with status', () => {
      const env = { FAKE_REVIEW: '- [warning] a.ts:1 — a may be 2 — check it', FAKE_VERIFY: 'refuted\\nthe point' }
      const first = lntt(['--base', 'main'], env)
      assert.equal(first.code, 0, first.err)
      assert.doesNotMatch(first.out, /a may be 2/, 'a refuted finding is nothing to do')
      assert.equal(query('.state.refuted[] | .what').out, 'a may be 2\n')

      writeFileSync(join(repo, 'a.ts'), 'export const a = 2\nexport const b = 1\n')
      git('commit', '-qam', 'b')
      const second = lntt(['--base', 'main'], env)
      assert.equal(second.code, 0, second.err)
      assert.match(second.out, /^ {2}f2 warning repeats f1 a\.ts:1 — a may be 2$/m)
      assert.equal(second.out, statusThings())
      assert.equal(query('.state.repeated[] | "\\(.id) \\(.closedBy) \\(.closedWhat)"').out, 'f2 f1 a may be 2\n')
    })

    test('--json is not a flag of a round; stderr still ends the round as it did', () => {
      const refused = lntt(['--json'])
      assert.equal(refused.code, 2)
      assert.equal(refused.out, '')
      const r = lntt(['--base', 'main'], blocker)
      assert.match(r.err, /round 1 done in \d+s: 1 findings, 0 refuted/)
      assert.match(r.err, /lntt review: branch total: 1 round/)
    })

    test('a reply answers in JSON, as it did', () => {
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      const reply = lntt(['reply', 'f1', 'no'], { FAKE_REPLY: 'kept\\nstill wrong' })
      assert.equal(JSON.parse(reply.out).id, 'f1')
    })
  })

  describe("the limit's stdout", () => {
    test('is the summary, with exit 3; what was asked and the total are on stderr', () => {
      withMaxRounds(1)
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      commit(3)
      const r = lntt(['--base', 'main'], blocker)
      assert.equal(r.code, 3, r.err)
      assert.match(
        r.out,
        /^lntt review: feat\/1\/x: round 1 of 1, reviewed \w+, not clean, at the limit, round 2 refused at the limit; 1 open \(1 blocking\), 0 replied, 0 closed, 3k tokens, \$0\.02\n {2}f1 blocker confirmed a\.ts:1 — wrong\n$/,
      )
      assert.equal(
        r.out.replace(', round 2 refused at the limit', ''),
        lntt(['status']).out.split('\n').slice(8).join('\n'),
      )
      assert.match(r.err, /lntt review: branch total: 1 round, 3k tokens, 0\.02 USD/)
    })

    test('a state written before a field existed is summed up too', () => {
      withMaxRounds(1)
      assert.equal(lntt(['--base', 'main'], blocker).code, 1)
      const old = state()
      delete old.result.blocking
      delete old.result.failed
      delete old.result.partial
      delete old.result.closed
      put(stateFile(), JSON.stringify(old))
      commit(3)
      const r = lntt(['--base', 'main'], blocker)
      assert.equal(r.code, 3, r.err)
      assert.match(r.out, /^ {2}f1 blocker confirmed a\.ts:1 — wrong$/m)
    })
  })
})

// One state and one ledger per branch, in the clone's common git directory unless the
// operator or the project names another place.
describe("where lntt review keeps a branch's rounds", () => {
  const note = '- [note] (no anchor) — n — a'
  const commit = (value: number) => {
    writeFileSync(join(repo, 'a.ts'), `export const a = ${value}\n`)
    git('commit', '-qam', `a = ${value}`)
  }
  const dirs: string[] = []
  const temp = (name: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `lntt-review-${name}-`)))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  // A home with an operator profile; HOME decides which profile lntt reads.
  const home = (profile: object) => {
    const dir = temp('home')
    mkdirSync(join(dir, '.agents'))
    writeFileSync(join(dir, '.agents/operator.jsonc'), JSON.stringify(profile))
    return dir
  }

  test('two branches reviewed in turn in one worktree each keep their round and their ledger', () => {
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
    commit(3)
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
    const x = readFileSync(ledgerFile('feat/1/x'), 'utf8')
    git('switch', '-q', 'main')
    git('switch', '-qc', 'feat/2/y')
    commit(7)
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
    assert.deepEqual([state('feat/2/y').round, state('feat/2/y').rounds.length], [1, 1])
    assert.equal(JSON.parse(readFileSync(ledgerFile('feat/2/y'), 'utf8')).branch, 'feat/2/y')
    assert.deepEqual([state('feat/1/x').round, state('feat/1/x').rounds.length], [2, 2], "x's rounds are x's")
    assert.equal(readFileSync(ledgerFile('feat/1/x'), 'utf8'), x, "x's ledger is untouched")

    git('switch', '-q', 'feat/1/x')
    commit(4)
    assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
    assert.equal(state('feat/1/x').round, 3, 'back on x, the next round is its third')
    assert.equal(state('feat/2/y').round, 1)
  })

  test("a branch's state is found from another worktree of the clone, and the lock and progress stay with each", () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    git('switch', '-q', 'main')
    const other = join(temp('worktree'), 'wt')
    git('worktree', 'add', '-q', other, 'feat/1/x')
    const seen = JSON.parse(lntt(['status', '--json'], {}, other).out)
    assert.equal(seen.state.round, 1)
    assert.equal(seen.state.branch, 'feat/1/x')

    writeFileSync(join(other, 'a.ts'), 'export const a = 8\n')
    execFileSync('git', ['commit', '-qam', 'from the worktree'], { cwd: other })
    const r = lntt(['--base', 'main'], {}, other)
    assert.equal(r.code, 0, r.err)
    assert.equal(state().round, 2, 'the worktree continued the branch where the first left it')
    const own = join(repo, '.git/worktrees/wt')
    assert.equal(existsSync(join(own, 'lntt-review.progress')), true, "the worktree's own progress")
    assert.equal(existsSync(join(repo, '.git/lntt-review.progress')), true, "and the main checkout's own")
    assert.deepEqual(readdirSync(storeDir()).sort(), ['ledger', 'state'], 'no lock or progress in the place')
  })

  test("the operator's place is used, with a folder per repository; the project's is the default and loses to it", () => {
    git('remote', 'add', 'origin', 'git@github.com:org/proj.git')
    const mine = temp('mine')
    const theirs = temp('theirs')
    const config = JSON.parse(CONFIG)
    config.delivery.review.stateDir = theirs
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'the project names a place')

    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(existsSync(stateFile('feat/1/x', join(theirs, 'org/proj'))), true, "the project's place")
    assert.equal(existsSync(stateFile()), false, 'not the common directory')

    const env = { HOME: home({ review: { stateDir: mine } }) }
    commit(5)
    assert.equal(lntt(['--base', 'main'], env).code, 0)
    assert.equal(existsSync(stateFile('feat/1/x', join(mine, 'org/proj'))), true, "the operator's place wins")
    assert.equal(JSON.parse(lntt(['status', '--json'], env).out).state.round, 1, 'and holds the branch from now on')
  })

  test('a place with ~ starts at the home; with no origin the repository is keyed by its git directory', () => {
    const env = { HOME: home({ review: { stateDir: '~/store' } }) }
    assert.equal(lntt(['--base', 'main'], env).code, 0)
    const [keyed] = readdirSync(join(env.HOME, 'store/local'))
    assert.match(keyed as string, /^[0-9a-f]{12}$/)
    assert.equal(existsSync(stateFile('feat/1/x', join(env.HOME, 'store/local', keyed as string))), true)
  })

  test("the project's place, relative, starts at the main checkout", () => {
    git('remote', 'add', 'origin', 'https://github.com/org/proj')
    const config = JSON.parse(CONFIG)
    config.delivery.review.stateDir = '.git/elsewhere'
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'a relative place')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(existsSync(stateFile('feat/1/x', join(repo, '.git/elsewhere/org/proj'))), true)
  })

  test("the operator's place must be absolute or start with ~", () => {
    const r = lntt(['--base', 'main'], { HOME: home({ review: { stateDir: 'relative/dir' } }) })
    assert.equal(r.code, 1)
    assert.match(r.err, /review\.stateDir must be an absolute path or start with ~: relative\/dir/)
  })

  describe('--prune', () => {
    const origin = () => {
      const dir = temp('origin')
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')])
      git('remote', 'add', 'origin', join(dir, 'origin.git'))
      git('push', '-q', 'origin', 'main:main')
      return dir
    }
    // A local branch whose upstream the remote then deleted, as GitHub does when it merges.
    const merged = (name: string) => {
      git('branch', name, 'main')
      git('push', '-q', '-u', 'origin', name)
      git('push', '-q', 'origin', '--delete', name)
      git('fetch', '-q', '--prune', 'origin')
    }
    const record = (branch: string) => {
      put(stateFile(branch), JSON.stringify({ branch }))
      put(ledgerFile(branch), JSON.stringify({ branch, closed: [] }))
    }

    test('removes what no branch holds any more or whose upstream is gone, and keeps the rest', () => {
      origin()
      merged('feat/merged')
      merged('feat/busy')
      git('branch', 'feat/live', 'main')
      git('push', '-q', 'origin', 'main:refs/heads/feat/remote-only')
      git('fetch', '-q', 'origin')
      git('worktree', 'add', '-q', join(temp('worktree'), 'busy'), 'feat/busy')
      for (const b of ['feat/1/x', 'feat/old', 'feat/merged', 'feat/busy', 'feat/live', 'feat/remote-only']) record(b)
      // A file that cannot be read goes with its branch.
      put(stateFile('feat/old'), '{')

      const dry = lntt(['status', '--prune', '--dry-run'])
      assert.equal(dry.code, 0, dry.err)
      assert.equal(
        dry.out,
        'lntt review: would prune feat/merged (its upstream is gone)\n' +
          'lntt review: would prune feat/old (no branch of that name is left)\n',
      )
      assert.equal(existsSync(stateFile('feat/old')), true, 'a dry run removes nothing')

      const r = lntt(['status', '--prune'])
      assert.equal(r.code, 0, r.err)
      assert.equal(
        r.out,
        'lntt review: pruned feat/merged (its upstream is gone): state and ledger\n' +
          'lntt review: pruned feat/old (no branch of that name is left): state and ledger\n',
      )
      for (const gone of ['feat/merged', 'feat/old']) {
        assert.equal(existsSync(stateFile(gone)) || existsSync(ledgerFile(gone)), false, gone)
      }
      // The current branch, one checked out in a worktree, a live one, one that only a remote holds.
      for (const kept of ['feat/1/x', 'feat/busy', 'feat/live', 'feat/remote-only']) {
        assert.equal(existsSync(stateFile(kept)) && existsSync(ledgerFile(kept)), true, kept)
      }
      assert.equal(lntt(['status', '--prune']).out, 'lntt review: nothing to prune\n')
    })

    test('takes nothing else, and --dry-run goes with it', () => {
      assert.equal(lntt(['status', '--prune', '--json']).code, 2)
      assert.equal(lntt(['status', '--prune', '--clear']).code, 2)
      assert.equal(lntt(['status', '--prune', '--query=.']).code, 2)
      assert.equal(lntt(['status', '--dry-run']).code, 2)
    })
  })

  describe('a state in the old place, the worktree’s git directory', () => {
    const old = (name = 'lntt-review.json') => join(repo, '.git', name)

    test('is read once: moved to the file of the branch it names, with a line saying so', () => {
      assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
      renameSync(stateFile(), old())
      renameSync(ledgerFile(), old('lntt-review-ledger.json'))
      const r = lntt(['status', '--json'])
      assert.equal(JSON.parse(r.out).state.round, 1)
      assert.match(
        r.err,
        /^lntt review: moved the state of feat\/1\/x from .+lntt-review\.json to .+feat%2F1%2Fx\.json$/m,
      )
      assert.match(r.err, /^lntt review: moved the ledger of feat\/1\/x /m)
      assert.equal(existsSync(old()) || existsSync(old('lntt-review-ledger.json')), false, 'never read again')
      assert.equal(existsSync(stateFile()) && existsSync(ledgerFile()), true)
      assert.equal(lntt(['status']).err, '', 'said once')
    })

    test("is moved to its own branch's file, whichever branch is checked out", () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      renameSync(stateFile(), old())
      git('switch', '-q', 'main')
      git('switch', '-qc', 'feat/2/y')
      assert.equal(lntt(['status']).code, 4)
      assert.equal(existsSync(stateFile()), true, "feat/1/x's state is kept, not dropped")
      assert.equal(existsSync(old()), false)
    })

    test('does not replace a newer one of the place, and a file that cannot be read is set aside', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      const before = readFileSync(stateFile(), 'utf8')
      writeFileSync(old(), JSON.stringify({ branch: 'feat/1/x', round: 9 }))
      utimesSync(old(), new Date(2000, 0, 1), new Date(2000, 0, 1))
      const r = lntt(['status'])
      assert.match(
        r.err,
        /^lntt review: the state of feat\/1\/x in .+lntt-review\.json is older than the one in .+: dropped$/m,
      )
      assert.equal(readFileSync(stateFile(), 'utf8'), before)
      assert.equal(existsSync(old()), false)

      writeFileSync(old('lntt-review-ledger.json'), '{ cut')
      assert.match(
        lntt(['status']).err,
        /lntt-review-ledger\.json cannot be read: set aside as lntt-review-ledger\.json\.unreadable/,
      )
      assert.equal(existsSync(old('lntt-review-ledger.json.unreadable')), true)
    })
  })

  test('a state file that names another branch than its own file is not read', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    const saved = JSON.parse(readFileSync(stateFile(), 'utf8'))
    put(stateFile('feat/2/y'), JSON.stringify(saved))
    git('switch', '-qc', 'feat/2/y')
    const r = lntt(['status'])
    assert.equal(r.code, 1)
    assert.match(r.err, /state\/feat%2F2%2Fy\.json cannot be read: pnpm exec lntt review status --clear removes it/)
    // A round or the cost would otherwise write over it.
    for (const args of [['cost'], ['--base', 'main']]) {
      const refused = lntt(args)
      assert.equal(refused.code, 1, args.join(' '))
      assert.match(refused.err, /state\/feat%2F2%2Fy\.json cannot be read/, args.join(' '))
    }
  })

  test('a branch name is a file name with its capitals encoded, so a case-insensitive filesystem tells two apart', () => {
    git('switch', '-qc', 'Fix/A', 'feat/1/x')
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(existsSync(join(storeDir(), 'state', '%46ix%2F%41.json')), true)
    assert.equal(state('Fix/A').branch, 'Fix/A')
  })

  test('a place of ~ alone, and a project place starting with ~/', () => {
    git('remote', 'add', 'origin', 'git@github.com:org/proj.git')
    const bare = home({ review: { stateDir: '~' } })
    assert.equal(lntt(['--base', 'main'], { HOME: bare }).code, 0)
    assert.equal(existsSync(stateFile('feat/1/x', join(bare, 'org/proj'))), true)

    const config = JSON.parse(CONFIG)
    config.delivery.review.stateDir = '~/shared'
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('commit', '-qam', 'a place in the home')
    const plain = temp('plain')
    assert.equal(lntt(['--base', 'main'], { HOME: plain }).code, 0)
    assert.equal(existsSync(stateFile('feat/1/x', join(plain, 'shared/org/proj'))), true)
  })

  test('an origin whose org is .. cannot take the state out of its place', () => {
    git('remote', 'add', 'origin', 'https://example.com/../proj')
    const mine = temp('mine')
    assert.equal(lntt(['--base', 'main'], { HOME: home({ review: { stateDir: mine } }) }).code, 0)
    assert.deepEqual(readdirSync(mine), ['local'], 'keyed by the git directory, inside the place')
  })

  test('--clear of a ledger with no state: refused until the branch is merged; a detached HEAD has nothing', () => {
    put(ledgerFile(), JSON.stringify({ branch: 'feat/1/x', closed: [] }))
    const refused = lntt(['status', '--clear'])
    assert.equal(refused.code, 1)
    assert.match(refused.err, /nothing cleared$/m)
    assert.equal(existsSync(ledgerFile()), true)

    const dir = temp('origin')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')])
    git('remote', 'add', 'origin', join(dir, 'origin.git'))
    git('push', '-q', 'origin', 'feat/1/x:main')
    git('fetch', '-q', 'origin')
    const r = lntt(['status', '--clear'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, "lntt review: cleared feat/1/x's ledger\n")
    assert.equal(existsSync(ledgerFile()), false)

    put(ledgerFile(), JSON.stringify({ branch: 'feat/1/x', closed: [] }))
    git('switch', '-q', '--detach')
    assert.equal(lntt(['status', '--clear']).out, 'lntt review: nothing to clear\n')
    assert.equal(existsSync(ledgerFile()), true)
  })

  test('--prune leaves a file whose name is not an encoded branch, and takes a state for HEAD that no ref holds', () => {
    const dir = temp('origin')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')])
    git('remote', 'add', 'origin', join(dir, 'origin.git'))
    git('push', '-q', 'origin', 'main:main')
    git('fetch', '-q', 'origin')
    git('remote', 'set-head', 'origin', 'main')
    put(join(storeDir(), 'state', '%E0.json'), '{}')
    put(join(storeDir(), 'state', 'Feat%2FOld.json'), '{}')
    put(stateFile('HEAD'), '{}')
    const r = lntt(['status', '--prune'])
    assert.equal(r.out, 'lntt review: pruned HEAD (no branch of that name is left): state\n')
    assert.equal(existsSync(join(storeDir(), 'state', '%E0.json')), true)
    assert.equal(existsSync(join(storeDir(), 'state', 'Feat%2FOld.json')), true, 'not listed, not removed')
  })

  describe('a state in the old place, more cases', () => {
    const old = (name = 'lntt-review.json') => join(repo, '.git', name)

    test('a state that cannot be read is set aside, and an older ledger does not replace the place’s', () => {
      writeFileSync(old(), '{ cut')
      const set = lntt(['status'])
      assert.match(set.err, /lntt-review\.json cannot be read: set aside as lntt-review\.json\.unreadable/)
      assert.equal(existsSync(old('lntt-review.json.unreadable')), true)

      assert.equal(lntt(['--base', 'main'], { FAKE_REVIEW: note }).code, 0)
      const ledger = readFileSync(ledgerFile(), 'utf8')
      writeFileSync(old('lntt-review-ledger.json'), JSON.stringify({ branch: 'feat/1/x', closed: [{ id: 'old' }] }))
      utimesSync(old('lntt-review-ledger.json'), new Date(2000, 0, 1), new Date(2000, 0, 1))
      assert.match(lntt(['status']).err, /the ledger of feat\/1\/x in .+ is older than the one in .+: dropped/)
      assert.equal(readFileSync(ledgerFile(), 'utf8'), ledger)
    })

    test('a newer one replaces the place’s', () => {
      assert.equal(lntt(['--base', 'main']).code, 0)
      utimesSync(stateFile(), new Date(2000, 0, 1), new Date(2000, 0, 1))
      writeFileSync(old(), JSON.stringify({ ...state(), round: 7 }))
      assert.match(lntt(['status']).err, /moved the state of feat\/1\/x/)
      assert.equal(state().round, 7)
    })
  })
})
