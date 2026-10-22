import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { orcaSubagents, subagentEvent } from '../src/orca-subagents.ts'
import { type Start, setupScript, startOrca } from '../src/worktree.ts'
import { runner } from '../src/worktree-cli.ts'
import {
  background,
  collect,
  drawn,
  flagsOf,
  missingFlags,
  readLog,
  recorder,
  throwawayHome,
  tool,
  upstream,
  waitFor,
} from './upstream.ts'

// lntt's Orca adapter against the real Orca: its flags against Orca's own description,
// then startOrca and the review's subagents on a headless Orca server, with the real
// claude not logged in (it stops at its welcome screen, spends nothing, and Orca sees a
// ready agent) and opencode on its free model for the shell launch.
const skip = upstream('orca')
  ? false
  : 'set UPSTREAM_SMOKE=orca to run (needs the real Orca, headless, on a throwaway machine)'

const START: Start = {
  issue: 137,
  title: 'Upstream check',
  branch: 'feat/137/upstream-orca',
  base: 'main',
  agent: { kind: 'claude', model: 'sonnet', effort: 'medium' },
  root: '/repo',
  brief: 'BRIEF',
  parent: 'path:/repo',
}

interface AgentContext {
  commands: { path: string[]; flags: string[] }[]
}

describe('Orca flags', () => {
  test('every flag lntt passes to orca is in orca agent-context --json', { skip }, () => {
    const context = JSON.parse(tool('orca', ['agent-context', '--json'])) as AgentContext
    // Every path of the adapter: one create with the agent, model and effort; the shell
    // launch of opencode with a model; the supervised worker when the create's help
    // lacks --model.
    const { calls, runner: recording } = recorder({
      'orca worktree create --help': '--model <id>',
      'orca worktree create': JSON.stringify({
        result: { worktree: { path: '/w' }, launch: { outcome: { handle: 't' } } },
      }),
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 't' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: true } } }),
      'orca orchestration worker-start': JSON.stringify({ result: { dispatch: { dispatchId: 'd' } } }),
    })
    startOrca(START, recording)
    startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/free' } }, recording)
    const worker = recorder({
      'orca worktree create --help': '--name <name> --agent <id>',
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
    })
    startOrca(START, worker.runner)
    const used = new Map<string, Set<string>>()
    for (const [command, ...args] of [...calls, ...worker.calls]) {
      if (command !== 'orca' || args.includes('--help')) continue
      // The longest command path the call starts with: `worktree create`, not `worktree`.
      const known = context.commands
        .filter((c) => c.path.every((word, i) => args[i] === word))
        .sort((a, b) => b.path.length - a.path.length)[0]
      assert.ok(known, `orca has no command ${args.slice(0, 2).join(' ')} in its agent-context`)
      collect(used, known.path.join(' '), flagsOf(args))
    }
    assert.ok(used.has('orchestration worker-start'), 'the worker path ran')
    const flags = (subcommand: string) =>
      new Set(context.commands.find((c) => c.path.join(' ') === subcommand)?.flags.map((f) => `--${f}`))
    assert.deepEqual(missingFlags('orca', used, flags), [])
  })
})

describe('Orca headless', () => {
  let home = ''
  let repo = ''
  let stop = () => {}
  const saved = { home: process.env.HOME, cwd: process.cwd() }

  // orca and lntt's runner find the server through HOME, and Orca picks the repository
  // from the working directory, as for a person in their checkout.
  before(async () => {
    if (skip) return
    ;({ home, repo } = throwawayHome())
    process.env.HOME = home
    process.chdir(repo)
    const log = join(home, 'serve.log')
    stop = background('orca', ['serve', '--no-pairing'], log)
    await waitFor('orca serve to be ready', () => readLog(log).includes('Orca server ready'), 120_000)
    tool('orca', ['repo', 'add', '--path', repo, '--json'])
  })

  after(() => {
    if (skip) return
    stop()
    process.chdir(saved.cwd)
    process.env.HOME = saved.home
    // Orca's terminal daemon may still be writing there; the machine is thrown away.
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  })

  const terminal = (handle: string) =>
    JSON.parse(tool('orca', ['terminal', 'show', '--terminal', handle, '--json'])) as {
      result: { terminal: { preview?: string; agentIdentity?: string } }
    }
  const screen = (handle: string) =>
    (
      JSON.parse(tool('orca', ['terminal', 'read', '--terminal', handle, '--json'])) as {
        result: { terminal: { tail: string[] } }
      }
    ).result.terminal.tail.join('\n')
  const worktrees = () => tool('git', ['worktree', 'list', '--porcelain'], { cwd: repo })

  test('startOrca: one create, the agent Orca starts with model, effort and the brief', {
    skip,
    timeout: 180_000,
  }, async () => {
    const brief = 'lntt upstream check: Orca starts the agent'
    const started = startOrca(
      { ...START, branch: 'feat/137/upstream-host', root: repo, brief, parent: undefined },
      runner,
      setupScript,
    )
    assert.ok(started.path && existsSync(started.path), `the worktree exists: ${started.path}`)
    assert.ok(worktrees().includes(`worktree ${started.path}\n`), 'git lists the worktree')
    assert.ok(started.agent && started.agent !== 'unknown', `the agent's handle: ${started.agent}`)
    // Orca refuses a model or effort it does not support before creating anything; the
    // agent it starts gets them, and the brief, on its command line.
    const handle = started.agent as string
    const preview = await waitFor('the brief in the agent terminal', () => {
      const p = terminal(handle).result.terminal.preview ?? ''
      return p.includes(brief) && p
    })
    assert.match(preview, /sonnet/)
    assert.match(preview, /medium/)
    assert.equal(terminal(handle).result.terminal.agentIdentity, 'claude')
  })

  test('startOrca, opencode with a model: its own terminal, the brief sent once it is idle', {
    skip,
    timeout: 180_000,
  }, async () => {
    const brief = 'Reply with the single word ok.'
    const started = startOrca(
      {
        ...START,
        branch: 'feat/137/upstream-shell',
        root: repo,
        brief,
        parent: undefined,
        agent: { kind: 'opencode', model: process.env.UPSTREAM_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free' },
      },
      runner,
      setupScript,
    )
    assert.ok(started.path && existsSync(started.path), `the worktree exists: ${started.path}`)
    assert.ok(worktrees().includes(`worktree ${started.path}\n`), 'git lists the worktree')
    assert.match(started.agent ?? '', /\S/)
    // terminal wait said satisfied and terminal send took the text, or startOrca threw;
    // the brief is on opencode's own screen, not lost to an interface still starting.
    const handle = started.agent as string
    await waitFor(
      'the brief on the opencode screen',
      () => drawn(screen(handle), brief),
      60_000,
      () => screen(handle),
    )
  })

  test("the review's subagents reach Orca through the hook script it installs", {
    skip,
    timeout: 120_000,
  }, async () => {
    const script = join(home, '.orca/agent-hooks/claude-hook.sh')
    assert.ok(existsSync(script), `Orca installed ${script}`)
    // The variables of a session in an Orca terminal, read from one.
    const dump = join(home, 'terminal.env')
    tool('orca', ['terminal', 'create', '--worktree', `path:${repo}`, '--command', `env > ${dump}`, '--json'])
    const captured = await waitFor('the environment of an Orca terminal', () => {
      const text = readLog(dump)
      return text.includes('ORCA_PANE_KEY=') && text
    })
    const env: Record<string, string> = { CLAUDE_CODE_SESSION_ID: 'lntt-upstream' }
    for (const line of captured.split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
    }
    env.HOME = home
    // The script itself takes the payload: exit 0 and nothing on stderr (curl's -sS
    // writes there when it cannot reach Orca).
    const direct = spawnSync('sh', [script], {
      env,
      input: JSON.stringify(subagentEvent('SubagentStart', 'lntt-upstream', 'probe', 'probe', repo)),
      encoding: 'utf8',
    })
    assert.equal(direct.status, 0, direct.stderr)
    assert.equal(direct.stderr, '')
    const subagents = orcaSubagents(env, repo)
    assert.ok(subagents, 'orcaSubagents finds the script and the variables')
    subagents.start('upstream-1', 'upstream check')
    // Orca lists the subagent under the pane that sent it.
    const seen = await waitFor('the subagent in orca worktree ps', () => {
      const ps = JSON.parse(tool('orca', ['worktree', 'ps', '--json'])) as {
        result: { worktrees: { agents?: { subagents?: { id: string; agentType: string }[] }[] }[] }
      }
      return ps.result.worktrees
        .flatMap((w) => w.agents ?? [])
        .flatMap((a) => a.subagents ?? [])
        .find((s) => s.id === 'upstream-1')
    })
    assert.equal(seen.agentType, 'upstream check')
    subagents.close()
  })
})
