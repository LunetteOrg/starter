import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { headlessInvocation, parseReply } from '../src/headless.ts'
import { agentEnv } from '../src/review-cli.ts'
import { shellLaunch } from '../src/worktree.ts'
import { collect, flagsOf, helpFlags, missingFlags, tool, upstream } from './upstream.ts'

// lntt against the real opencode: the flags of the headless reviewer against
// `opencode run --help` and those of the interactive launch against `opencode --help`,
// then a one-line call on a free model, which needs no key, whose JSON lntt parses.
const skip = upstream('opencode') ? false : 'set UPSTREAM_SMOKE=opencode to run (needs the real opencode)'
const MODEL = process.env.UPSTREAM_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'

describe('opencode', () => {
  test('every flag lntt passes to opencode is in its --help', { skip }, () => {
    const used = new Map<string, Set<string>>()
    const headless = headlessInvocation({ kind: 'opencode', model: MODEL }, '', 'ses_x')
    assert.equal(headless.args[0], 'run')
    collect(used, 'run', flagsOf(headless.args))
    // `OPENCODE_CONFIG_CONTENT='…' opencode --standalone`: the words after the command.
    const launch = shellLaunch({ kind: 'opencode', model: MODEL }) ?? ''
    collect(used, '', flagsOf(launch.split(' opencode ')[1]?.split(' ') ?? []))
    assert.ok(used.get('')?.size, `the launch has flags: ${launch}`)
    const flags = (subcommand: string) => helpFlags(tool('opencode', [...(subcommand ? [subcommand] : []), '--help']))
    assert.deepEqual(missingFlags('opencode', used, flags), [])
  })

  test('a one-line call on a free model answers with the JSON lntt reads: text, session, tokens', {
    skip,
    timeout: 180_000,
  }, () => {
    const inv = headlessInvocation({ kind: 'opencode', model: MODEL }, 'Reply with the single word ok.')
    // A HOME of its own: no login, configuration or session of the machine's.
    const home = mkdtempSync(join(tmpdir(), 'lntt-upstream-opencode-'))
    try {
      const r = spawnSync(inv.command, inv.args, {
        cwd: home,
        env: agentEnv({ ...process.env, HOME: home }, inv.env),
        input: inv.stdin,
        encoding: 'utf8',
        timeout: 170_000,
      })
      assert.equal(r.status, 0, `opencode exited ${r.status ?? r.signal}: ${r.stderr || r.stdout}`)
      const reply = parseReply('opencode', r.stdout)
      assert.match(reply.text, /\S/)
      assert.match(reply.session ?? '', /\S/)
      assert.ok(reply.tokens !== null, `lntt read no token count from opencode's events:\n${r.stdout}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
