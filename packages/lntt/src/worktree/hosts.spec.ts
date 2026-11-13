import { assert, describe, it } from '@effect/vitest'
import {
  agentArgs,
  type Runner,
  renderBrief,
  type Start,
  shellLaunch,
  startGit,
  startHerdr,
  startOrca,
  toolFailure,
  worktreeHost,
} from '../worktree.ts'

// The adapters' steps (src/worktree/hosts.ts), run through the library's synchronous driver
// (src/worktree.ts) with a runner that records each call: what each host is asked, in order.

describe('the host that creates the worktree', () => {
  it('Orca, Herdr, or plain git', () => {
    assert.strictEqual(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x' }), 'orca')
    assert.strictEqual(worktreeHost({ HERDR_ENV: '1' }), 'herdr')
    assert.strictEqual(worktreeHost({}), 'git')
  })

  it('hosts that cannot create worktrees fall back to git', () => {
    assert.strictEqual(worktreeHost({ TERM_PROGRAM: 'waveterm' }), 'git')
    assert.strictEqual(worktreeHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'git')
  })

  it('nested: Herdr running in an Orca terminal is the innermost, so Herdr creates it', () => {
    assert.strictEqual(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x', HERDR_ENV: '1' }), 'herdr')
  })
})

describe('the brief', () => {
  it('fills the issue, title, branch and worktree into the template', () => {
    const brief = renderBrief('#{{issue}} {{title}} on {{branch}} in {{worktree}}', {
      issue: 78,
      title: 'Start an agent',
      branch: 'feat/78/start-agent',
      worktree: '/w',
    })
    assert.strictEqual(brief, '#78 Start an agent on feat/78/start-agent in /w')
  })

  it('the shipped template names the stop point and the friction return', () => {
    const brief = renderBrief(undefined, { issue: 78, title: 'T', branch: 'feat/78/t', worktree: '/w' })
    assert.match(brief, /#78/)
    assert.match(brief, /draft/)
    assert.match(brief, /no merge/i)
    assert.match(brief, /gh pr ready/)
    assert.match(brief, /friction/i)
    assert.match(brief, /\/w/)
    assert.notMatch(brief, /\{\{/)
  })

  it('the shipped template routes every wait to the orchestrator, with the issue', () => {
    const brief = renderBrief(undefined, { issue: 78, title: 'T', branch: 'feat/78/t', worktree: '/w' })
    assert.match(brief, /## Every wait goes through the mailbox/)
    assert.match(brief, /`pnpm exec lntt ask --to orchestrator --issue 78 "<…>"`/)
    assert.match(brief, /1Password/)
    assert.match(brief, /`pnpm exec lntt ask --wait <id>`/)
    assert.match(brief, /re-read your mailbox:\n`pnpm exec lntt inbox --as child --issue 78`/)
  })
})

// Records every call; answers from a table keyed by the command and its first arguments.
function recorder(answers: Record<string, string> = {}) {
  const calls: string[] = []
  const runner: Runner = {
    run(command, args) {
      const line = [command, ...args].join(' ')
      calls.push(line)
      const key = Object.keys(answers).find((k) => line.startsWith(k))
      return key ? (answers[key] as string) : ''
    },
    shell(script, cwd) {
      calls.push(`setup in ${cwd}: ${script.trim()}`)
    },
    sleep() {},
  }
  return { calls, runner }
}

const START: Start = {
  issue: 78,
  title: 'Start an agent',
  branch: 'feat/78/start-agent',
  base: 'main',
  agent: { kind: 'claude' },
  root: '/repo',
  brief: 'BRIEF',
}

describe('Orca', () => {
  it('one create: the issue linked, setup run, the agent with the brief; the name flattened for rename', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({
        result: {
          worktree: {
            path: '/repo/.worktrees/starter/feat-78-start-agent',
            branch: 'refs/heads/me/feat-78-start-agent',
          },
          agentTerminalHandle: 'term_1',
        },
      }),
    })
    const started = startOrca(START, runner)
    assert.deepStrictEqual(calls, [
      'orca worktree create --help',
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup run --json --agent claude --prompt BRIEF',
    ])
    assert.deepStrictEqual(started, {
      host: 'orca',
      issue: 78,
      branch: 'feat/78/start-agent',
      path: '/repo/.worktrees/starter/feat-78-start-agent',
      agent: 'term_1',
    })
  })

  it('a current Orca names the agent in launch.outcome.handle', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({
        result: { worktree: { path: '/p' }, launch: { outcome: { kind: 'terminal', handle: 'term_new' } } },
      }),
    })
    assert.strictEqual(startOrca(START, runner).agent, 'term_new')
  })

  it('a reply without the agent handle does not crash, and still counts the agent as started', () => {
    const { runner } = recorder({ 'orca worktree create': '' })
    const started = startOrca(START, runner)
    assert.strictEqual(started.path, null)
    assert.strictEqual(started.agent, 'unknown')
  })

  it('without an agent, no --agent and no --prompt', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...START, agent: null }, runner)
    assert.notMatch(calls[0] as string, /--agent|--prompt|--surface/)
    assert.strictEqual(calls.length, 1, 'no agent, nothing to ask the help about')
  })
})

describe('Orca starts the agent in a terminal', () => {
  const WITH_SURFACE = 'Usage: orca worktree create --name <name> [--agent <id>] [--surface chat|terminal]'
  const created = JSON.stringify({ result: { worktree: { path: '/w' } } })

  it('--surface terminal on the create, where Orca lists --surface', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': WITH_SURFACE,
      'orca worktree create --name': created,
    })
    startOrca(START, runner)
    assert.match(calls.at(-1) as string, /--agent claude --prompt BRIEF --surface terminal$/)
  })

  it('also with a model and an effort', () => {
    const help = `${WITH_SURFACE} [--model <id>] [--effort <level>]`
    const { calls, runner } = recorder({ 'orca worktree create --help': help, 'orca worktree create --name': created })
    startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner)
    assert.match(calls.at(-1) as string, /--model sonnet --effort high --surface terminal$/)
  })

  it('an Orca whose help lists no --surface gets no flag', () => {
    const help = 'Usage: orca worktree create --name <name> [--agent <id>] [--model <id>]'
    const { calls, runner } = recorder({ 'orca worktree create --help': help, 'orca worktree create --name': created })
    startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet' } }, runner)
    assert.notMatch(calls.at(-1) as string, /--surface/)
    const bare = recorder({ 'orca worktree create --help': '', 'orca worktree create --name': created })
    startOrca(START, bare.runner)
    assert.notMatch(bare.calls.at(-1) as string, /--surface/)
  })

  it('only an option named --surface counts, not --surface-x or a word in prose', () => {
    for (const help of [
      'Usage: orca worktree create [--surface-x <v>]',
      'Usage: orca worktree create; the surface is yours',
    ]) {
      const { calls, runner } = recorder({
        'orca worktree create --help': help,
        'orca worktree create --name': created,
      })
      startOrca(START, runner)
      assert.notMatch(calls.at(-1) as string, /--surface/)
    }
  })

  it('a help that cannot be run stops the start, instead of silently starting a chat', () => {
    const runner: Runner = {
      run(_command, args) {
        if (args.includes('--help')) throw new Error('orca: help failed')
        return created
      },
      shell() {},
      sleep() {},
    }
    assert.throws(() => startOrca(START, runner), /help failed/)
  })

  it('a help that prints nothing starts an untuned agent with no flag', () => {
    const { calls, runner } = recorder({ 'orca worktree create --help': '', 'orca worktree create --name': created })
    startOrca(START, runner)
    assert.match(calls.at(-1) as string, /--agent claude --prompt BRIEF$/)
  })

  it('opencode with a model opens its own terminal and gets no --surface', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': WITH_SURFACE,
      'orca worktree create --name': created,
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 'term_7' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: true } } }),
    })
    startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner, () => null)
    assert.ok(calls.some((c) => c.startsWith('orca terminal create')))
    assert.ok(calls.every((c) => !c.includes('--surface')))
  })

  it('the worker path takes no --surface: worker-start has no such option (orca 1.4.229 help)', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help':
        'Usage: orca worktree create --name <name> [--agent <id>] [--surface chat|terminal]',
      'orca orchestration run-current': JSON.stringify({ result: { run: { id: 'run_1' } } }),
      'orca worktree create --name': created,
      'orca orchestration worker-start': JSON.stringify({ result: { dispatch: { dispatchId: 'ctx_9' } } }),
    })
    // a help with --surface and no --model is no real Orca: it pins that this path never adds the flag
    startOrca({ ...START, agent: { kind: 'codex', model: 'gpt-6' } }, runner)
    assert.ok(calls.some((c) => c.startsWith('orca orchestration worker-start')))
    assert.ok(calls.every((c) => !c.includes('--surface')))
  })
})

describe('the agent arguments', () => {
  it('model and effort, as each agent spells them', () => {
    assert.deepStrictEqual(agentArgs({ kind: 'claude', model: 'sonnet', effort: 'high' }), [
      '--model',
      'sonnet',
      '--effort',
      'high',
    ])
    assert.deepStrictEqual(agentArgs({ kind: 'codex', model: 'gpt-6', effort: 'xhigh' }), [
      '--model',
      'gpt-6',
      '-c',
      'model_reasoning_effort="xhigh"',
    ])
    assert.deepStrictEqual(agentArgs({ kind: 'claude' }), [])
  })

  it('what the agent cannot take is an error, not a silent drop', () => {
    assert.throws(() => agentArgs({ kind: 'opencode', effort: 'high' }), /opencode/)
    assert.throws(() => agentArgs({ kind: 'pi', effort: 'high' }), /pi/)
  })

  it('opencode takes its model through its inline configuration, on a standalone server', () => {
    assert.strictEqual(
      shellLaunch({ kind: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }),
      `OPENCODE_CONFIG_CONTENT='{"model":"opencode/deepseek-v4.1-flash-free"}' opencode --standalone`,
    )
    assert.strictEqual(shellLaunch({ kind: 'opencode' }), null)
    assert.strictEqual(shellLaunch({ kind: 'claude', model: 'sonnet' }), null)
    assert.throws(() => shellLaunch({ kind: 'opencode', model: "x'; rm -rf ~" }), /provider\/model/)
  })
})

describe('Orca with a model or an effort', () => {
  it('a current Orca takes the model and the effort on worktree create: one call', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help':
        'Usage: orca worktree create --name <name> [--agent <id>] [--model <id>] [--effort <level>]',
      'orca worktree create --name': JSON.stringify({
        result: { worktree: { path: '/w' }, launch: { outcome: { kind: 'terminal', handle: 'term_7' } } },
      }),
    })
    const started = startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner)
    assert.deepStrictEqual(calls, [
      'orca worktree create --help',
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup run --json --agent claude --prompt BRIEF --model sonnet --effort high',
    ])
    assert.strictEqual(started.agent, 'term_7')
  })

  it('a model alone, or an effort alone, goes alone', () => {
    const run = (agent: { kind: string; model?: string; effort?: string }) => {
      const { calls, runner } = recorder({
        'orca worktree create --help':
          'Usage: orca worktree create --name <name> [--agent <id>] [--model <id>] [--effort <level>]',
        'orca worktree create --name': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      })
      startOrca({ ...START, agent }, runner)
      return calls.at(-1) as string
    }
    assert.match(run({ kind: 'claude', model: 'sonnet' }), /--prompt BRIEF --model sonnet$/)
    assert.match(run({ kind: 'claude', effort: 'high' }), /--prompt BRIEF --effort high$/)
  })

  it('Orca that cannot say what it takes stops the start, instead of guessing an older one', () => {
    const runner: Runner = {
      run(_command, args) {
        if (args.includes('--help')) throw new Error('orca: command not found')
        return ''
      },
      shell() {},
      sleep() {},
    }
    assert.throws(
      () => startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet' } }, runner),
      /orca: command not found/,
    )
  })

  it('the handle in the oldest field still counts', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { startupTerminal: { handle: 'term_old' } } }),
    })
    assert.strictEqual(startOrca(START, runner).agent, 'term_old')
  })

  it('an older Orca: the worktree with its issue, the setup run here, then a supervised worker on it', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <name> [--agent <id>] [--prompt <text>]',
      'orca orchestration run-current': JSON.stringify({ ok: true, result: { run: { id: 'run_1' } } }),
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      'orca orchestration worker-start': JSON.stringify({ ok: true, result: { dispatch: { dispatchId: 'ctx_9' } } }),
    })
    const started = startOrca(
      { ...START, agent: { kind: 'codex', model: 'gpt-6' } },
      runner,
      () => 'pnpm install --frozen-lockfile\n',
    )
    assert.deepStrictEqual(calls, [
      'orca worktree create --help',
      'orca orchestration run-current --json',
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup skip --json',
      'setup in /w: pnpm install --frozen-lockfile',
      'orca orchestration worker-start --spec BRIEF --worktree path:/w --agent codex --json --model gpt-6',
    ])
    assert.strictEqual(started.agent, 'ctx_9')
    assert.strictEqual(started.path, '/w')
  })

  it('opencode with a model: the worktree, the setup, then opencode in a terminal and the brief sent', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 'term_7' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: true } } }),
    })
    const started = startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner, () => 'pnpm i')
    assert.deepStrictEqual(calls, [
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup skip --json',
      'setup in /w: pnpm i',
      `orca terminal create --worktree path:/w --title feat-78-start-agent --command OPENCODE_CONFIG_CONTENT='{"model":"opencode/x"}' opencode --standalone --json`,
      'orca terminal wait --terminal term_7 --for tui-idle --timeout-ms 120000 --json',
      'orca terminal send --terminal term_7 --text BRIEF --enter --json',
    ])
    assert.strictEqual(started.agent, 'term_7')
  })

  it('a brief is never typed into an agent that is not ready', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 'term_7' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: false } } }),
    })
    assert.throws(() => startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner), /not ready/)
  })

  it('creates the Run when none is bound', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <name> [--agent <id>] [--prompt <text>]',
      'orca orchestration run-current': JSON.stringify({ ok: true, result: { run: null } }),
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
    })
    startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner)
    assert.strictEqual(calls[0], 'orca worktree create --help', 'an older Orca: the help says no --model')
    assert.match(calls[2] as string, /^orca orchestration run-create --objective .+ --json$/)
    assert.match(calls.at(-1) as string, /--model sonnet --effort high$/)
  })
})

describe('Herdr', () => {
  it('creates the worktree on the right name, runs the setup, starts the agent, sends the brief', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { root_pane: { pane_id: 'w2:p1' } } } }),
    })
    const started = startHerdr(START, runner, () => 'pnpm install --frozen-lockfile\n')
    const path = '/repo/.worktrees/feat-78-start-agent'
    assert.deepStrictEqual(calls, [
      `herdr worktree create --cwd /repo --branch feat/78/start-agent --base main --path ${path} --label feat-78-start-agent --no-focus`,
      'git branch --unset-upstream feat/78/start-agent',
      `setup in ${path}: pnpm install --frozen-lockfile`,
      'herdr agent start feat-78-start-agent --kind claude --pane w2:p1',
      'herdr agent prompt feat-78-start-agent BRIEF',
    ])
    assert.strictEqual(started.agent, 'feat-78-start-agent')
  })

  it('opencode with a model: started in the pane, found by Herdr, prompted through the pane', () => {
    let listed = 0
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }),
    })
    const base = runner.run
    runner.run = (command, args, opts) => {
      if (command === 'herdr' && args[0] === 'agent' && args[1] === 'list') {
        calls.push('herdr agent list')
        listed += 1
        return JSON.stringify({ result: { agents: listed < 2 ? [] : [{ agent: 'opencode', pane_id: 'w2:p1' }] } })
      }
      return base(command, args, opts)
    }
    const started = startHerdr({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner, () => null)
    assert.deepStrictEqual(calls.slice(2), [
      `herdr pane run w2:p1 OPENCODE_CONFIG_CONTENT='{"model":"opencode/x"}' opencode --standalone`,
      'herdr agent list',
      'herdr agent list',
      'herdr agent prompt w2:p1 BRIEF',
    ])
    assert.strictEqual(started.agent, 'w2:p1')
  })

  it('model and effort go to the agent after --', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }),
    })
    startHerdr({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner, () => null)
    assert.ok(
      calls.includes(
        'herdr agent start feat-78-start-agent --kind claude --pane w2:p1 -- --model sonnet --effort high',
      ),
    )
  })

  it('finds the pane through the workspace when the create reply has none', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { workspace_id: 'wF' } } }),
      'herdr pane list': JSON.stringify({ result: { panes: [{ pane_id: 'wF:p1' }] } }),
    })
    startHerdr(START, runner, () => null)
    assert.ok(calls.includes('herdr pane list --workspace wF'))
    assert.ok(calls.includes('herdr agent start feat-78-start-agent --kind claude --pane wF:p1'))
  })
})

describe('a tool that refuses', () => {
  it('the reason Orca writes in its JSON reply, not "Command failed"', () => {
    const stdout = JSON.stringify({
      ok: false,
      error: { code: 'invalid_argument', message: 'Agent claude model haiku does not support effort low.' },
    })
    assert.strictEqual(
      toolFailure('orca', ['worktree', 'create', '--name', 'x'], stdout, ''),
      'orca worktree create: Agent claude model haiku does not support effort low.',
    )
  })

  it('JSON with no message falls back to what was printed', () => {
    assert.strictEqual(
      toolFailure('orca', ['a', 'b'], '{"ok":false}', 'stderr says why'),
      'orca a b: {"ok":false} stderr says why',
    )
    assert.strictEqual(toolFailure('orca', ['a', 'b'], 'null', ''), 'orca a b: null')
  })

  it('otherwise the last lines of what it printed', () => {
    assert.strictEqual(toolFailure('git', ['x', 'y'], '', '1\n2\n3\n4\n5'), 'git x y: 3 4 5')
    assert.strictEqual(
      toolFailure('herdr', ['pane', 'run'], '', 'boom\nno such pane\n'),
      'herdr pane run: boom no such pane',
    )
    assert.strictEqual(toolFailure('git', ['worktree', 'add'], '', ''), 'git worktree add failed')
  })
})

describe('an Orca that cannot say what it takes', () => {
  it('Orca whose help says nothing on stdout cannot say what it takes', () => {
    const { runner } = recorder({ 'orca worktree create --help': '' })
    assert.throws(() => startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet' } }, runner), /could not tell/)
  })
})

describe('a coordinator’s worktree and its children', () => {
  const COORDINATOR: Start = { ...START, issue: null, title: 'Theme t', branch: 'chore/no-issue/t' }
  const CHILD: Start = { ...START, parent: 'current' }

  it('Orca links no issue for the coordinator, and the lineage for a child', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...COORDINATOR, agent: null }, runner)
    startOrca({ ...CHILD, agent: null }, runner)
    assert.notMatch(calls[0] as string, /--issue|--parent-worktree/)
    assert.match(calls[1] as string, /--issue 78 /)
    assert.match(calls[1] as string, /--parent-worktree current /)
  })

  it('Orca’s worker route carries the lineage and names a coordinator by its title', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <n>',
      'orca orchestration run-current': '{"result":{"run":{"id":"r"}}}',
      'orca worktree create --name': JSON.stringify({ result: { worktree: { path: '/p' } } }),
      'orca orchestration worker-start': JSON.stringify({ result: { dispatchId: 'd1' } }),
    })
    const started = startOrca({ ...CHILD, agent: { kind: 'claude', model: 'sonnet' } }, runner)
    assert.ok(calls.some((c) => /^orca worktree create .*--parent-worktree current/.test(c)))
    assert.strictEqual(started.parent, 'current')
    const { calls: more, runner: second } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <n>',
      'orca orchestration run-current': '{}',
      'orca worktree create --name': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...COORDINATOR, agent: { kind: 'claude', model: 'sonnet' } }, second)
    assert.ok(more.some((c) => c.includes('--objective lntt worktree start Theme t')))
  })

  it('Herdr and git report the parent they were given, and a coordinator has no issue', () => {
    const { runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }),
    })
    const herdr = startHerdr({ ...CHILD }, runner, () => null)
    assert.strictEqual(herdr.parent, 'current')
    assert.strictEqual(startHerdr({ ...COORDINATOR, agent: null }, runner, () => null).issue, null)
    const git = startGit({ ...COORDINATOR, agent: null }, recorder().runner, () => null)
    assert.strictEqual(git.issue, null)
    assert.ok(!('parent' in git))
    assert.strictEqual(startGit({ ...CHILD, agent: null }, recorder().runner, () => null).parent, 'current')
  })
})
