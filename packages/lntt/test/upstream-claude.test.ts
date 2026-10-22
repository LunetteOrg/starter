import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { headlessInvocation, parseReply } from '../src/headless.ts'
import { agentEnv } from '../src/review-cli.ts'
import { agentArgs } from '../src/worktree.ts'
import { collect, flagsOf, helpFlags, missingFlags, tool, upstream } from './upstream.ts'

// lntt against the real claude: the flags of the headless reviewer and of the
// interactive agent (Herdr's `--` arguments) against `claude --help`, which needs no
// login, and a one-line call whose JSON reply lntt parses, which needs an API key.
const skip = upstream('claude') ? false : 'set UPSTREAM_SMOKE=claude to run (needs the real claude)'
// The cheapest model: the call proves the reply's shape, not an answer.
const replySkip =
  skip ||
  (process.env.ANTHROPIC_API_KEY ? false : 'set ANTHROPIC_API_KEY to check the JSON reply (a call of a few cents)')

describe('claude', () => {
  test('every flag lntt passes to claude is in claude --help', { skip }, () => {
    const used = new Map<string, Set<string>>()
    const headless = headlessInvocation({ kind: 'claude', model: 'haiku', effort: 'low' }, '', 'session')
    collect(used, '-p', flagsOf(headless.args))
    collect(used, '(interactive)', flagsOf(agentArgs({ kind: 'claude', model: 'sonnet', effort: 'medium' })))
    const help = helpFlags(tool('claude', ['--help']))
    assert.deepEqual(
      missingFlags('claude', used, () => help),
      [],
    )
  })

  test('a one-line call answers with the JSON lntt reads: text, session, tokens, cost', {
    skip: replySkip,
    timeout: 120_000,
  }, () => {
    const inv = headlessInvocation({ kind: 'claude', model: 'haiku' }, 'Reply with the single word ok.')
    // An empty directory: no project instructions to read into the call.
    const dir = mkdtempSync(join(tmpdir(), 'lntt-upstream-claude-'))
    try {
      const r = spawnSync(inv.command, inv.args, {
        cwd: dir,
        env: agentEnv(process.env, inv.env),
        input: inv.stdin,
        encoding: 'utf8',
        // spawnSync blocks the test's own timeout.
        timeout: 110_000,
      })
      assert.equal(r.status, 0, `claude exited ${r.status ?? r.signal}: ${r.stderr || r.stdout}`)
      const reply = parseReply('claude', r.stdout)
      assert.match(reply.text, /\S/)
      assert.match(reply.session ?? '', /\S/)
      assert.ok(reply.tokens !== null && reply.tokens > 0, `tokens: ${reply.tokens}`)
      assert.ok(reply.cost !== null, 'claude reports the cost')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
