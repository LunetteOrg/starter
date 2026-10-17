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
  if (process.env['FAKE_FAIL_' + kind]) { process.stderr.write('boom\\n'); process.exit(1) }
  const result = (process.env['FAKE_' + kind] || 'no findings').replace(/\\\\n/g, '\\n')
  process.stdout.write(JSON.stringify({ result, session_id: session, is_error: false, total_cost_usd: 0.01 }))
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
  writeFileSync(join(repo, '.gitignore'), '.fakebin\n.fakelog\n')
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
  rmSync(repo, { recursive: true, force: true })
})

const state = () => JSON.parse(readFileSync(join(repo, '.git/lntt-review.json'), 'utf8'))

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
    assert.equal(lntt(['--base', 'main']).code, 1)
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
    assert.equal(readFileSync(log, 'utf8'), '')
    assert.equal(lntt(['--base', 'main']).code, 1, 'a real round refuses')
  })
})
