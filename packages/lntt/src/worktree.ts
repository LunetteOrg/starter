// Starting an agent on an issue in its own worktree, on the host the session runs in.
// The steps are the same everywhere (the branch name from `lntt branch`, the setup
// orca.yaml declares, the brief from agents/brief.md); each host gets a small adapter
// for the calls it understands.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export type WorktreeHost = 'orca' | 'herdr' | 'git'

// Runs the commands an adapter needs: `run` returns stdout, `shell` runs a script in
// a directory and fails when it does.
export interface Runner {
  run(command: string, args: string[], opts?: { cwd?: string }): string
  shell(script: string, cwd: string): void
}

export interface Start {
  issue: number
  title: string
  branch: string
  base: string
  // The agent to launch, or null to leave it to the person.
  agent: Agent | null
  // The main checkout: plain git and Herdr put worktrees under <root>/.worktrees/.
  root: string
  brief: string
}

// kind: the agent CLI (claude, codex, opencode, …), as Orca's --agent and Herdr's
// --kind name it. model and effort: left to the agent's own configuration when absent.
export interface Agent {
  kind: string
  model?: string
  effort?: string
}

export interface Started {
  host: WorktreeHost
  issue: number
  branch: string
  path: string | null
  // How to reach the agent: Orca's terminal handle or dispatch id, Herdr's agent name.
  agent: string | null
}

type Env = Record<string, string | undefined>

// The innermost host creates the worktree. Herdr runs inside a terminal, so an Orca
// terminal can hold a Herdr session (both sets of variables present) and never the
// other way round. Wave and Claude desktop create no worktrees: plain git.
export function worktreeHost(env: Env): WorktreeHost {
  if (env.HERDR_ENV === '1') return 'herdr'
  if (env.TERM_PROGRAM === 'Orca' || env.ORCA_WORKTREE_ID) return 'orca'
  return 'git'
}

const BRIEF = join(dirname(fileURLToPath(import.meta.url)), '../agents/brief.md')

export interface BriefValues {
  issue: number
  title: string
  branch: string
  worktree: string
}

export function renderBrief(template: string | undefined, values: BriefValues): string {
  const text = template ?? readFileSync(BRIEF, 'utf8')
  return text.replace(/\{\{(issue|title|branch|worktree)\}\}/g, (_, key: keyof BriefValues) => String(values[key]))
}

// The setup every new worktree gets: the one orca.yaml declares, run by hand on the
// hosts that have no hook for it.
export function setupScript(root: string): string | null {
  const file = join(root, 'orca.yaml')
  if (!existsSync(file)) return null
  const setup = (parse(readFileSync(file, 'utf8')) as { scripts?: { setup?: unknown } } | null)?.scripts?.setup
  return typeof setup === 'string' && setup.trim() !== '' ? setup : null
}

// Model and effort as each agent CLI takes them. An effort the agent has no flag for
// is an error: dropping it would launch a different agent than the one asked for.
export function agentArgs(agent: Agent): string[] {
  const args = agent.model ? ['--model', agent.model] : []
  if (!agent.effort) return args
  if (agent.kind === 'claude') return [...args, '--effort', agent.effort]
  if (agent.kind === 'codex') return [...args, '-c', `model_reasoning_effort="${agent.effort}"`]
  throw new Error(`${agent.kind} takes no effort from the command line; drop --effort or set it in its configuration`)
}

// A branch name as one path segment: Orca's worktree name, Herdr's label, the folder.
function flat(branch: string): string {
  return branch.replace(/\//g, '-')
}

// Orca prefixes the worktree name with the user (`<user>/feat-78-slug`); its setup
// (orca.yaml, `lntt branch rename`) reads the convention back. The agent starts after
// the setup (setupAgentStartupPolicy: wait-for-setup).
export function startOrca(start: Start, runner: Runner): Started {
  if (start.agent?.model || start.agent?.effort) return startOrcaWorker(start, start.agent, runner)
  const args = ['worktree', 'create', '--name', flat(start.branch), '--issue', String(start.issue)]
  args.push('--base-branch', start.base, '--setup', 'run', '--json')
  if (start.agent) args.push('--agent', start.agent.kind, '--prompt', start.brief)
  const reply = JSON.parse(runner.run('orca', args)) as {
    result?: { worktree?: { path?: string }; agentTerminalHandle?: string; startupTerminal?: { handle?: string } }
  }
  const handle = reply.result?.agentTerminalHandle ?? reply.result?.startupTerminal?.handle ?? null
  return {
    host: 'orca',
    issue: start.issue,
    branch: start.branch,
    path: reply.result?.worktree?.path ?? null,
    agent: start.agent ? handle : null,
  }
}

// `worktree create --agent` takes no model or effort; Orca's supervised worker does.
// It needs a Run bound to the calling terminal (created when there is none), wraps the
// brief in Orca's own preamble, and has the agent report `worker_done` to the Run. It
// takes no issue: the link is set once the worktree exists.
function startOrcaWorker(start: Start, agent: Agent, runner: Runner): Started {
  agentArgs(agent) // an effort the agent cannot take fails before anything is created
  const current = JSON.parse(runner.run('orca', ['orchestration', 'run-current', '--json']) || '{}')
  if (!find(current, 'run')) {
    runner.run('orca', ['orchestration', 'run-create', '--objective', `lntt worktree start #${start.issue}`, '--json'])
  }
  const name = flat(start.branch)
  const args = ['orchestration', 'worker-start', '--spec', start.brief, '--worktree', 'new-top-level']
  args.push('--agent', agent.kind, '--name', name, '--base-branch', start.base, '--setup', 'run', '--json')
  if (agent.model) args.push('--model', agent.model)
  if (agent.effort) args.push('--effort', agent.effort)
  const dispatch = find(JSON.parse(runner.run('orca', args) || '{}'), 'dispatchId')
  const shown = JSON.parse(runner.run('orca', ['worktree', 'show', '--worktree', `name:${name}`, '--json']) || '{}')
  const path = find(shown, 'path')
  if (typeof path === 'string') {
    runner.run('orca', ['worktree', 'set', '--worktree', `path:${path}`, '--issue', String(start.issue), '--json'])
  }
  return {
    host: 'orca',
    issue: start.issue,
    branch: start.branch,
    path: typeof path === 'string' ? path : null,
    agent: typeof dispatch === 'string' ? dispatch : null,
  }
}

// The first value of `key` anywhere in a JSON reply.
function find(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  if (Object.hasOwn(value, key)) return (value as Record<string, unknown>)[key]
  for (const child of Object.values(value)) {
    const found = find(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

// The new workspace's pane: in the create reply when Herdr includes it, else the first
// pane of the workspace it names.
function herdrPane(reply: unknown, runner: Runner): string | null {
  const pane = find(reply, 'pane_id')
  if (typeof pane === 'string') return pane
  const workspace = find(reply, 'workspace_id')
  if (typeof workspace !== 'string') return null
  const listed = find(JSON.parse(runner.run('herdr', ['pane', 'list', '--workspace', workspace]) || '{}'), 'pane_id')
  return typeof listed === 'string' ? listed : null
}

// Herdr takes the branch name as given and has no setup hook: the setup runs here,
// before the agent starts in the new workspace's pane. `--cwd` names the repository,
// so the call works from outside a Herdr workspace too.
export function startHerdr(start: Start, runner: Runner, setup: string | null): Started {
  const name = flat(start.branch)
  const path = join(start.root, '.worktrees', name)
  const reply = runner.run('herdr', [
    'worktree',
    'create',
    '--cwd',
    start.root,
    '--branch',
    start.branch,
    '--base',
    start.base,
    '--path',
    path,
    '--label',
    name,
    '--no-focus',
  ])
  if (setup) runner.shell(setup, path)
  let agent: string | null = null
  if (start.agent) {
    const pane = herdrPane(JSON.parse(reply || '{}'), runner)
    if (!pane) throw new Error(`no pane found in the workspace herdr created: ${reply}`)
    const extra = agentArgs(start.agent)
    runner.run('herdr', [
      'agent',
      'start',
      name,
      '--kind',
      start.agent.kind,
      '--pane',
      pane,
      ...(extra.length ? ['--', ...extra] : []),
    ])
    runner.run('herdr', ['agent', 'prompt', name, start.brief])
    agent = name
  }
  return { host: 'herdr', issue: start.issue, branch: start.branch, path, agent }
}

// Plain git: the worktree and its setup; the person starts the agent with the brief.
export function startGit(start: Start, runner: Runner, setup: string | null): Started {
  const path = join(start.root, '.worktrees', flat(start.branch))
  runner.run('git', ['worktree', 'add', '-b', start.branch, path, start.base], { cwd: start.root })
  if (setup) runner.shell(setup, path)
  return { host: 'git', issue: start.issue, branch: start.branch, path, agent: null }
}
