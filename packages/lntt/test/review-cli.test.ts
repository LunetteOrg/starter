import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

function lntt(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, 'review', ...args], {
    cwd: repo,
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

const state = () => JSON.parse(readFileSync(join(repo, '.git/lntt-review.json'), 'utf8'))

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
    const result = JSON.parse(r.out)
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
  test('a clean round: exit 0, the JSON on stdout, the head saved as reviewed', () => {
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).findings, [])
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
    const finding = JSON.parse(r.out).findings[0]
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
    assert.match(JSON.parse(r.out).failed[0].error, /claude exited 1: boom/)
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
    assert.equal(existsSync(join(repo, '.git/lntt-review.json')), false, 'no round on the defaults')

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
    const r = lntt(['--base', 'main'], { FAKE_REVIEW: '- [warning] a.ts:1 — w — a' })
    assert.equal(JSON.parse(r.out).findings[0].foundBy.length, 2)
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
    assert.equal(JSON.parse(r.out).skipped[0].agent, 'claude opus')
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
    assert.match(JSON.parse(r.out).skipped[0].error, /stopped: the other agents answered/)
  })

  test('the progress goes to stderr with tokens, and to a file of JSON events the band reads', () => {
    const env = { FAKE_REVIEW: '- [blocker] a.ts:1 — wrong — fix', FAKE_VERIFY: 'confirmed\\nshown' }
    const r = lntt(['--base', 'main'], env)
    assert.match(r.err, /lntt review: done code · claude sonnet in \d+s \(1\.5k tokens\)/)
    assert.match(r.err, /round 1 done in \d+s: 1 findings, 0 refuted, 0 failed, 0 skipped, 3k tokens/)
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
    assert.match(JSON.parse(r.out).failed[0].error, /the round took longer than/)
  })

  test('the progress names the Claude Code session that started the round, or none', () => {
    lntt(['--base', 'main'], { CLAUDE_CODE_SESSION_ID: 'session-1' })
    const named = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(named.session, 'session-1')
    git('commit', '-q', '--allow-empty', '-m', 'again')
    lntt(['--base', 'main'])
    const none = JSON.parse(readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8').split('\n')[0] as string)
    assert.equal(none.session, null)
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
    assert.match(JSON.parse(r.out).failed.at(-1).error, /the branch moved/)
  })

  test('a round that fails on another branch than the saved one keeps no reviewed commit', () => {
    assert.equal(lntt(['--base', 'main']).code, 0)
    git('switch', '-qc', 'feat/2/y')
    writeFileSync(join(repo, 'a.ts'), 'export const a = 9\n')
    git('commit', '-qam', 'other branch')
    lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' })
    assert.deepEqual([state().branch, state().reviewed], ['feat/2/y', null])
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
    assert.equal(JSON.parse(r.out).findings[0].id, 'f1', r.err)
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
    assert.match(r.err, /lntt review allow <rounds>/)
    const out = JSON.parse(r.out)
    assert.deepEqual(
      out.findings.map((f: { id: string }) => f.id),
      ['f1'],
    )
    assert.deepEqual(out.limit, { round: 2, maxRounds: 1, allowed: 0 })
    assert.equal(readFileSync(log, 'utf8'), calls, 'no agent started')
    assert.equal(state().round, 1)
    assert.deepEqual(events().at(-1), { ...events().at(-1), type: 'limit', round: 2, maxRounds: 1, open: 1, failed: 0 })
  })

  test('what is open at the limit: a withdrawn finding is not, a failed reviewer is', () => {
    withMaxRounds(1)
    lntt(['--base', 'main'], open)
    lntt(['reply', 'f1', 'no'], { FAKE_REPLY: 'withdrawn\\nfair' })
    commit(3)
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 3, r.err)
    assert.match(r.err, /still open: nothing$/m)
    assert.deepEqual(JSON.parse(r.out).findings, [])
    assert.equal(events().at(-1).open, 0)

    git('switch', '-qc', 'feat/2/y')
    commit(4)
    assert.equal(lntt(['--base', 'main'], { FAKE_FAIL_REVIEW: '1' }).code, 1)
    commit(5)
    const calls = readFileSync(log, 'utf8')
    const failed = lntt(['--base', 'main'])
    assert.equal(failed.code, 3, failed.err)
    assert.match(failed.err, /still open: code · claude sonnet failed$/m)
    assert.equal(JSON.parse(failed.out).failed[0].agent, 'claude sonnet')
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
    assert.deepEqual(JSON.parse(r.out).limit, { round: 3, maxRounds: 1, allowed: 1 })
    assert.equal(events().at(-1).allowed, 1)

    git('switch', '-qc', 'feat/2/y')
    commit(5)
    assert.match(lntt(['allow', '1']).err, /no round on feat\/2\/y yet/)
    assert.equal(state().branch, 'feat/1/x', "the other branch's state untouched")
    assert.equal(state().allowed, 1)
    assert.equal(lntt(['--base', 'main']).code, 0)
    assert.equal(state().allowed, undefined, 'a new branch starts with nothing allowed')
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
    const before = readFileSync(join(repo, '.git/lntt-review.json'), 'utf8')
    for (const count of [['0'], [], ['abc'], ['1.5'], ['-1'], ['1', '2']]) {
      assert.equal(lntt(['allow', ...count]).code, 2, `allow ${count.join(' ')}`)
    }
    assert.equal(readFileSync(join(repo, '.git/lntt-review.json'), 'utf8'), before)
  })

  test('a maxRounds below 1 does not validate', () => {
    withMaxRounds(0)
    const r = lntt(['--base', 'main'])
    assert.equal(r.code, 1)
    assert.match(r.err, /maxRounds must be >= 1/)
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
    assert.equal(JSON.parse(r.out).findings[0].id, 'f1', r.err)
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
