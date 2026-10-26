import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  agentArgs,
  type Runner,
  renderBrief,
  type Start,
  setupScript,
  shellLaunch,
  startGit,
  startHerdr,
  startOrca,
  toolFailure,
  worktreeHost,
} from '../src/index.ts'
import { projectConfig, runTool } from '../src/worktree-cli.ts'

describe('the host that creates the worktree', () => {
  test('Orca, Herdr, or plain git', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x' }), 'orca')
    assert.equal(worktreeHost({ HERDR_ENV: '1' }), 'herdr')
    assert.equal(worktreeHost({}), 'git')
  })

  test('hosts that cannot create worktrees fall back to git', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'waveterm' }), 'git')
    assert.equal(worktreeHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'git')
  })

  test('nested: Herdr running in an Orca terminal is the innermost, so Herdr creates it', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x', HERDR_ENV: '1' }), 'herdr')
  })
})

describe('the brief', () => {
  test('fills the issue, title, branch and worktree into the template', () => {
    const brief = renderBrief('#{{issue}} {{title}} on {{branch}} in {{worktree}}', {
      issue: 78,
      title: 'Start an agent',
      branch: 'feat/78/start-agent',
      worktree: '/w',
    })
    assert.equal(brief, '#78 Start an agent on feat/78/start-agent in /w')
  })

  test('the shipped template names the stop point and the friction return', () => {
    const brief = renderBrief(undefined, { issue: 78, title: 'T', branch: 'feat/78/t', worktree: '/w' })
    assert.match(brief, /#78/)
    assert.match(brief, /draft/)
    assert.match(brief, /no merge/i)
    assert.match(brief, /gh pr ready/)
    assert.match(brief, /friction/i)
    assert.match(brief, /\/w/)
    assert.doesNotMatch(brief, /\{\{/)
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
  test('one create: the issue linked, setup run, the agent with the brief; the name flattened for rename', () => {
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
    assert.deepEqual(calls, [
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup run --json --agent claude --prompt BRIEF',
    ])
    assert.deepEqual(started, {
      host: 'orca',
      issue: 78,
      branch: 'feat/78/start-agent',
      path: '/repo/.worktrees/starter/feat-78-start-agent',
      agent: 'term_1',
    })
  })

  test('a current Orca names the agent in launch.outcome.handle', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({
        result: { worktree: { path: '/p' }, launch: { outcome: { kind: 'terminal', handle: 'term_new' } } },
      }),
    })
    assert.equal(startOrca(START, runner).agent, 'term_new')
  })

  test('a reply without the agent handle does not crash, and still counts the agent as started', () => {
    const { runner } = recorder({ 'orca worktree create': '' })
    const started = startOrca(START, runner)
    assert.equal(started.path, null)
    assert.equal(started.agent, 'unknown')
  })

  test('without an agent, no --agent and no --prompt', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...START, agent: null }, runner)
    assert.doesNotMatch(calls[0] as string, /--agent|--prompt/)
  })
})

describe('the agent arguments', () => {
  test('model and effort, as each agent spells them', () => {
    assert.deepEqual(agentArgs({ kind: 'claude', model: 'sonnet', effort: 'high' }), [
      '--model',
      'sonnet',
      '--effort',
      'high',
    ])
    assert.deepEqual(agentArgs({ kind: 'codex', model: 'gpt-6', effort: 'xhigh' }), [
      '--model',
      'gpt-6',
      '-c',
      'model_reasoning_effort="xhigh"',
    ])
    assert.deepEqual(agentArgs({ kind: 'claude' }), [])
  })

  test('what the agent cannot take is an error, not a silent drop', () => {
    assert.throws(() => agentArgs({ kind: 'opencode', effort: 'high' }), /opencode/)
    assert.throws(() => agentArgs({ kind: 'pi', effort: 'high' }), /pi/)
  })

  test('opencode takes its model through its inline configuration, on a standalone server', () => {
    assert.equal(
      shellLaunch({ kind: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }),
      `OPENCODE_CONFIG_CONTENT='{"model":"opencode/deepseek-v4.1-flash-free"}' opencode --standalone`,
    )
    assert.equal(shellLaunch({ kind: 'opencode' }), null)
    assert.equal(shellLaunch({ kind: 'claude', model: 'sonnet' }), null)
    assert.throws(() => shellLaunch({ kind: 'opencode', model: "x'; rm -rf ~" }), /provider\/model/)
  })
})

describe('Orca with a model or an effort', () => {
  test('a current Orca takes the model and the effort on worktree create: one call', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help':
        'Usage: orca worktree create --name <name> [--agent <id>] [--model <id>] [--effort <level>]',
      'orca worktree create --name': JSON.stringify({
        result: { worktree: { path: '/w' }, launch: { outcome: { kind: 'terminal', handle: 'term_7' } } },
      }),
    })
    const started = startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner)
    assert.deepEqual(calls, [
      'orca worktree create --help',
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup run --json --agent claude --prompt BRIEF --model sonnet --effort high',
    ])
    assert.equal(started.agent, 'term_7')
  })

  test('a model alone, or an effort alone, goes alone', () => {
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

  test('Orca that cannot say what it takes stops the start, instead of guessing an older one', () => {
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

  test('the handle in the oldest field still counts', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { startupTerminal: { handle: 'term_old' } } }),
    })
    assert.equal(startOrca(START, runner).agent, 'term_old')
  })

  test('an older Orca: the worktree with its issue, the setup run here, then a supervised worker on it', () => {
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
    assert.deepEqual(calls, [
      'orca worktree create --help',
      'orca orchestration run-current --json',
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup skip --json',
      'setup in /w: pnpm install --frozen-lockfile',
      'orca orchestration worker-start --spec BRIEF --worktree path:/w --agent codex --json --model gpt-6',
    ])
    assert.equal(started.agent, 'ctx_9')
    assert.equal(started.path, '/w')
  })

  test('opencode with a model: the worktree, the setup, then opencode in a terminal and the brief sent', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 'term_7' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: true } } }),
    })
    const started = startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner, () => 'pnpm i')
    assert.deepEqual(calls, [
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup skip --json',
      'setup in /w: pnpm i',
      `orca terminal create --worktree path:/w --title feat-78-start-agent --command OPENCODE_CONFIG_CONTENT='{"model":"opencode/x"}' opencode --standalone --json`,
      'orca terminal wait --terminal term_7 --for tui-idle --timeout-ms 120000 --json',
      'orca terminal send --terminal term_7 --text BRIEF --enter --json',
    ])
    assert.equal(started.agent, 'term_7')
  })

  test('a brief is never typed into an agent that is not ready', () => {
    const { runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
      'orca terminal create': JSON.stringify({ result: { terminal: { handle: 'term_7' } } }),
      'orca terminal wait': JSON.stringify({ result: { wait: { satisfied: false } } }),
    })
    assert.throws(() => startOrca({ ...START, agent: { kind: 'opencode', model: 'opencode/x' } }, runner), /not ready/)
  })

  test('creates the Run when none is bound', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <name> [--agent <id>] [--prompt <text>]',
      'orca orchestration run-current': JSON.stringify({ ok: true, result: { run: null } }),
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/w' } } }),
    })
    startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet', effort: 'high' } }, runner)
    assert.equal(calls[0], 'orca worktree create --help', 'an older Orca: the help says no --model')
    assert.match(calls[2] as string, /^orca orchestration run-create --objective .+ --json$/)
    assert.match(calls.at(-1) as string, /--model sonnet --effort high$/)
  })
})

describe('Herdr', () => {
  test('creates the worktree on the right name, runs the setup, starts the agent, sends the brief', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { root_pane: { pane_id: 'w2:p1' } } } }),
    })
    const started = startHerdr(START, runner, () => 'pnpm install --frozen-lockfile\n')
    const path = '/repo/.worktrees/feat-78-start-agent'
    assert.deepEqual(calls, [
      `herdr worktree create --cwd /repo --branch feat/78/start-agent --base main --path ${path} --label feat-78-start-agent --no-focus`,
      'git branch --unset-upstream feat/78/start-agent',
      `setup in ${path}: pnpm install --frozen-lockfile`,
      'herdr agent start feat-78-start-agent --kind claude --pane w2:p1',
      'herdr agent prompt feat-78-start-agent BRIEF',
    ])
    assert.equal(started.agent, 'feat-78-start-agent')
  })

  test('opencode with a model: started in the pane, found by Herdr, prompted through the pane', () => {
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
    assert.deepEqual(calls.slice(2), [
      `herdr pane run w2:p1 OPENCODE_CONFIG_CONTENT='{"model":"opencode/x"}' opencode --standalone`,
      'herdr agent list',
      'herdr agent list',
      'herdr agent prompt w2:p1 BRIEF',
    ])
    assert.equal(started.agent, 'w2:p1')
  })

  test('model and effort go to the agent after --', () => {
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

  test('finds the pane through the workspace when the create reply has none', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { workspace_id: 'wF' } } }),
      'herdr pane list': JSON.stringify({ result: { panes: [{ pane_id: 'wF:p1' }] } }),
    })
    startHerdr(START, runner, () => null)
    assert.ok(calls.includes('herdr pane list --workspace wF'))
    assert.ok(calls.includes('herdr agent start feat-78-start-agent --kind claude --pane wF:p1'))
  })
})

describe('plain git', () => {
  let repo: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-worktree-')))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo ready > setup-ran\n')
    git('add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('the setup is the one orca.yaml declares', () => {
    assert.equal(setupScript(repo)?.trim(), 'echo ready > setup-ran')
  })

  test('adds the worktree on the branch, runs the setup in it, leaves the agent to the person', () => {
    // The main checkout's working copy is not what the new worktree checks out.
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo uncommitted > setup-ran\n')
    const real: Runner = {
      run: (command, args, opts) => execFileSync(command, args, { cwd: opts?.cwd ?? repo, encoding: 'utf8' }),
      shell: (script, cwd) => execFileSync('sh', ['-c', script], { cwd }),
      sleep: () => {},
    }
    const started = startGit({ ...START, root: repo, base: 'main' }, real, setupScript)
    const path = join(repo, '.worktrees', 'feat-78-start-agent')
    assert.deepEqual(started, { host: 'git', issue: 78, branch: 'feat/78/start-agent', path, agent: null })
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: path, encoding: 'utf8' }).trim(),
      'feat/78/start-agent',
    )
    assert.ok(existsSync(join(path, 'setup-ran')))
    assert.equal(readFileSync(join(path, 'setup-ran'), 'utf8').trim(), 'ready', "the new worktree's own orca.yaml")
    const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: path, encoding: 'utf8' })
    assert.notEqual(upstream.status, 0, `no upstream for a new branch, got ${upstream.stdout}`)
  })
})

describe('a tool that refuses', () => {
  test('the reason Orca writes in its JSON reply, not "Command failed"', () => {
    const stdout = JSON.stringify({
      ok: false,
      error: { code: 'invalid_argument', message: 'Agent claude model haiku does not support effort low.' },
    })
    assert.equal(
      toolFailure('orca', ['worktree', 'create', '--name', 'x'], stdout, ''),
      'orca worktree create: Agent claude model haiku does not support effort low.',
    )
  })

  test('JSON with no message falls back to what was printed', () => {
    assert.equal(
      toolFailure('orca', ['a', 'b'], '{"ok":false}', 'stderr says why'),
      'orca a b: {"ok":false} stderr says why',
    )
    assert.equal(toolFailure('orca', ['a', 'b'], 'null', ''), 'orca a b: null')
  })

  test('otherwise the last lines of what it printed', () => {
    assert.equal(toolFailure('git', ['x', 'y'], '', '1\n2\n3\n4\n5'), 'git x y: 3 4 5')
    assert.equal(toolFailure('herdr', ['pane', 'run'], '', 'boom\nno such pane\n'), 'herdr pane run: boom no such pane')
    assert.equal(toolFailure('git', ['worktree', 'add'], '', ''), 'git worktree add failed')
  })
})

describe('running a tool', () => {
  const node = (code: string) => [process.execPath, ['-e', code]] as const

  test('stdout trimmed is the result; what the tool says on stderr reaches the person', () => {
    const said: string[] = []
    const [cmd, args] = node("process.stdout.write('  out  '); process.stderr.write('note')")
    assert.equal(
      runTool(cmd, [...args], process.cwd(), (t) => said.push(t)),
      'out',
    )
    assert.deepEqual(said, ['note'])
  })

  test('a refusal is reported once, in the error, with what the tool said', () => {
    const said: string[] = []
    const [a, aa] = node(
      "process.stdout.write(JSON.stringify({ ok: false, error: { message: 'no such pane' } })); process.exit(2)",
    )
    assert.throws(() => runTool(a, [...aa], process.cwd(), (t) => said.push(t)), /: no such pane$/)
    const [b, bb] = node("process.stderr.write('error: branch has no upstream information'); process.exit(1)")
    assert.throws(() => runTool(b, [...bb], process.cwd(), (t) => said.push(t)), /no upstream information$/)
    assert.deepEqual(said, [], 'nothing reaches the person besides the error, which a caller may expect and drop')
    const [d, dd] = node('process.exit(3)')
    assert.throws(() => runTool(d, [...dd], process.cwd(), () => {}), /failed \(exit 3\)$/)
  })

  test('a tool that is not installed is an error, not an empty result', () => {
    assert.throws(() => runTool('lntt-no-such-tool', [], process.cwd()), /ENOENT/)
  })

  test('Orca whose help says nothing on stdout cannot say what it takes', () => {
    const { runner } = recorder({ 'orca worktree create --help': '' })
    assert.throws(() => startOrca({ ...START, agent: { kind: 'claude', model: 'sonnet' } }, runner), /could not tell/)
  })
})

describe('a coordinator’s worktree and its children', () => {
  const COORDINATOR: Start = { ...START, issue: null, title: 'Theme t', branch: 'chore/no-issue/t' }
  const CHILD: Start = { ...START, parent: 'current' }

  test('Orca links no issue for the coordinator, and the lineage for a child', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...COORDINATOR, agent: null }, runner)
    startOrca({ ...CHILD, agent: null }, runner)
    assert.doesNotMatch(calls[0] as string, /--issue|--parent-worktree/)
    assert.match(calls[1] as string, /--issue 78 /)
    assert.match(calls[1] as string, /--parent-worktree current /)
  })

  test('Orca’s worker route carries the lineage and names a coordinator by its title', () => {
    const { calls, runner } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <n>',
      'orca orchestration run-current': '{"result":{"run":{"id":"r"}}}',
      'orca worktree create --name': JSON.stringify({ result: { worktree: { path: '/p' } } }),
      'orca orchestration worker-start': JSON.stringify({ result: { dispatchId: 'd1' } }),
    })
    const started = startOrca({ ...CHILD, agent: { kind: 'claude', model: 'sonnet' } }, runner)
    assert.ok(calls.some((c) => /^orca worktree create .*--parent-worktree current/.test(c)))
    assert.equal(started.parent, 'current')
    const { calls: more, runner: second } = recorder({
      'orca worktree create --help': 'Usage: orca worktree create --name <n>',
      'orca orchestration run-current': '{}',
      'orca worktree create --name': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...COORDINATOR, agent: { kind: 'claude', model: 'sonnet' } }, second)
    assert.ok(more.some((c) => c.includes('--objective lntt worktree start Theme t')))
  })

  test('Herdr and git report the parent they were given, and a coordinator has no issue', () => {
    const { runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }),
    })
    const herdr = startHerdr({ ...CHILD }, runner, () => null)
    assert.equal(herdr.parent, 'current')
    assert.equal(startHerdr({ ...COORDINATOR, agent: null }, runner, () => null).issue, null)
    const git = startGit({ ...COORDINATOR, agent: null }, recorder().runner, () => null)
    assert.equal(git.issue, null)
    assert.ok(!('parent' in git))
    assert.equal(startGit({ ...CHILD, agent: null }, recorder().runner, () => null).parent, 'current')
  })
})

describe('the project configuration', () => {
  let dir: string

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-worktree-config-')))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a missing file gives the defaults', () => {
    assert.deepEqual(projectConfig(dir), {})
  })

  test('an invalid file stops with its error', () => {
    mkdirSync(join(dir, '.agents'))
    writeFileSync(join(dir, '.agents/config.jsonc'), '{ "delivery": ')
    assert.throws(() => projectConfig(dir), /config\.jsonc/)
    writeFileSync(join(dir, '.agents/config.jsonc'), JSON.stringify({ delivery: { candidate: { base: 3 } } }))
    assert.throws(() => projectConfig(dir), /schema/)
  })
})
