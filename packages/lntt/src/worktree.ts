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
  sleep(ms: number): void
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
  // How to reach the agent: Orca's terminal handle or dispatch id, Herdr's agent name or
  // pane.
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

// The setup a worktree gets, read from its own orca.yaml (the revision it checks out,
// not the main checkout's working copy), run by hand on the hosts that have no hook
// for it.
export type SetupFor = (worktree: string) => string | null

export function setupScript(worktree: string): string | null {
  const file = join(worktree, 'orca.yaml')
  if (!existsSync(file)) return null
  const setup = (parse(readFileSync(file, 'utf8')) as { scripts?: { setup?: unknown } } | null)?.scripts?.setup
  return typeof setup === 'string' && setup.trim() !== '' ? setup : null
}

// Model and effort as each agent CLI takes them on its interactive command line (Herdr,
// the command printed for plain git). What the agent has no flag for is an error:
// dropping it would launch a different agent than the one asked for.
export function agentArgs(agent: Agent): string[] {
  // opencode's model goes through its configuration: shellLaunch.
  if (agent.kind === 'opencode' && !agent.effort) return []
  const args = agent.model ? ['--model', agent.model] : []
  if (!agent.effort) return args
  if (agent.kind === 'claude') return [...args, '--effort', agent.effort]
  if (agent.kind === 'codex') return [...args, '-c', `model_reasoning_effort="${agent.effort}"`]
  throw new Error(`${agent.kind} takes no effort from the command line; drop --effort or set it in its configuration`)
}

// opencode's interface has no model flag; its configuration has one, inline through
// OPENCODE_CONFIG_CONTENT, which only a standalone server reads (the shared background
// service ignores it). Such a start is a shell command, not an executable with
// arguments. Null for an agent that starts with plain arguments.
export function shellLaunch(agent: Agent): string | null {
  if (agent.kind !== 'opencode' || !agent.model) return null
  if (!/^[\w.:-]+\/[\w.:/-]+$/.test(agent.model)) throw new Error(`opencode model ${agent.model} is not provider/model`)
  return `OPENCODE_CONFIG_CONTENT='${JSON.stringify({ model: agent.model })}' opencode --standalone`
}

// A branch name as one path segment: Orca's worktree name, Herdr's label, the folder.
function flat(branch: string): string {
  return branch.replace(/\//g, '-')
}

// Why a tool refused, for the person: the message Orca writes in its JSON reply, else the
// last lines it printed.
export function toolFailure(command: string, args: string[], stdout: string, stderr: string): string {
  const what = [command, ...args.slice(0, 2)].join(' ')
  try {
    const message = (JSON.parse(stdout) as { error?: { message?: string } }).error?.message
    if (message) return `${what}: ${message}`
  } catch {}
  const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join(' ').trim()
  return tail ? `${what}: ${tail}` : `${what} failed`
}

// Whether Orca's `worktree create` takes the agent's model and effort (1.4.229 does,
// 1.4.224 did not). An Orca that cannot say is an error: guessing the older path would
// fail later, for another reason.
function orcaTakesModel(runner: Runner): boolean {
  return /--model\b/.test(runner.run('orca', ['worktree', 'create', '--help']))
}

// Orca prefixes the worktree name with the user (`<user>/feat-78-slug`); its setup
// (orca.yaml, `lntt branch rename`) reads the convention back. The agent starts after
// the setup (setupAgentStartupPolicy: wait-for-setup).
export function startOrca(start: Start, runner: Runner, setupFor: SetupFor = () => null): Started {
  const shell = start.agent ? shellLaunch(start.agent) : null
  if (shell) return startOrcaShell(start, shell, runner, setupFor)
  const tuned = Boolean(start.agent?.model || start.agent?.effort)
  if (start.agent && tuned && !orcaTakesModel(runner)) return startOrcaWorker(start, start.agent, runner, setupFor)
  const args = ['worktree', 'create', '--name', flat(start.branch), '--issue', String(start.issue)]
  args.push('--base-branch', start.base, '--setup', 'run', '--json')
  if (start.agent) {
    args.push('--agent', start.agent.kind, '--prompt', start.brief)
    if (start.agent.model) args.push('--model', start.agent.model)
    if (start.agent.effort) args.push('--effort', start.agent.effort)
  }
  const reply = JSON.parse(runner.run('orca', args) || '{}') as {
    result?: {
      worktree?: { path?: string }
      launch?: { outcome?: { handle?: string } }
      agentTerminalHandle?: string
      startupTerminal?: { handle?: string }
    }
  }
  // Where the agent's handle is: launch.outcome on a current Orca, the older fields before.
  const r = reply.result
  const handle = r?.launch?.outcome?.handle ?? r?.agentTerminalHandle ?? r?.startupTerminal?.handle ?? null
  return {
    host: 'orca',
    issue: start.issue,
    branch: start.branch,
    path: reply.result?.worktree?.path ?? null,
    // Orca started the agent even when its reply names no handle.
    agent: start.agent ? (handle ?? 'unknown') : null,
  }
}

// The worktree with its issue linked and Orca's setup skipped, then the setup run here:
// Orca's setup terminal stays open as a shell, with no end to wait for.
function orcaWorktree(start: Start, runner: Runner, setupFor: SetupFor): string {
  const args = ['worktree', 'create', '--name', flat(start.branch), '--issue', String(start.issue)]
  args.push('--base-branch', start.base, '--setup', 'skip', '--json')
  const path = find(JSON.parse(runner.run('orca', args) || '{}'), 'path')
  if (typeof path !== 'string') throw new Error('orca worktree create returned no path')
  const setup = setupFor(path)
  if (setup) runner.shell(setup, path)
  return path
}

// An agent started by a shell command (shellLaunch) in a terminal of its own; the brief
// is sent once its interface is idle, never before: text typed into a starting
// interface is lost.
function startOrcaShell(start: Start, command: string, runner: Runner, setupFor: SetupFor): Started {
  const path = orcaWorktree(start, runner, setupFor)
  const created = runner.run('orca', [
    'terminal',
    'create',
    '--worktree',
    `path:${path}`,
    '--title',
    flat(start.branch),
    '--command',
    command,
    '--json',
  ])
  const handle = find(JSON.parse(created || '{}'), 'handle')
  if (typeof handle !== 'string') throw new Error(`orca terminal create returned no handle: ${created}`)
  const waited = runner.run('orca', [
    'terminal',
    'wait',
    '--terminal',
    handle,
    '--for',
    'tui-idle',
    '--timeout-ms',
    '120000',
    '--json',
  ])
  if (find(JSON.parse(waited || '{}'), 'satisfied') !== true) {
    throw new Error(`the agent in ${handle} is not ready; the brief was not sent`)
  }
  runner.run('orca', ['terminal', 'send', '--terminal', handle, '--text', start.brief, '--enter', '--json'])
  return { host: 'orca', issue: start.issue, branch: start.branch, path, agent: handle }
}

// On an Orca whose `worktree create --agent` takes no model or effort, Orca's
// supervised worker does, on
// a worktree that already exists (orcaWorktree). It needs a Run bound to the calling
// terminal, created when there is none; Orca wraps the brief in its own preamble and
// the agent reports `worker_done` to the Run.
function startOrcaWorker(start: Start, agent: Agent, runner: Runner, setupFor: SetupFor): Started {
  agentArgs(agent) // what the agent cannot take fails before anything is created
  const current = JSON.parse(runner.run('orca', ['orchestration', 'run-current', '--json']) || '{}')
  if (!find(current, 'run')) {
    runner.run('orca', ['orchestration', 'run-create', '--objective', `lntt worktree start #${start.issue}`, '--json'])
  }
  const path = orcaWorktree(start, runner, setupFor)
  const worker = ['orchestration', 'worker-start', '--spec', start.brief, '--worktree', `path:${path}`]
  worker.push('--agent', agent.kind, '--json')
  if (agent.model) worker.push('--model', agent.model)
  if (agent.effort) worker.push('--effort', agent.effort)
  const dispatch = find(JSON.parse(runner.run('orca', worker) || '{}'), 'dispatchId')
  return {
    host: 'orca',
    issue: start.issue,
    branch: start.branch,
    path,
    agent: typeof dispatch === 'string' ? dispatch : 'unknown',
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

// An agent started by a shell command is not named by Herdr: wait until Herdr detects
// it in the pane, so the brief reaches the agent and not the shell.
function herdrAgentIn(pane: string, runner: Runner): void {
  for (let tries = 0; tries < 60; tries += 1) {
    const agents = find(JSON.parse(runner.run('herdr', ['agent', 'list']) || '{}'), 'agents')
    if (Array.isArray(agents) && agents.some((a) => (a as { pane_id?: string }).pane_id === pane)) return
    runner.sleep(1000)
  }
  throw new Error(`herdr detected no agent in ${pane}; the brief was not sent`)
}

// Herdr takes the branch name as given and has no setup hook: the setup runs here,
// before the agent starts in the new workspace's pane. `--cwd` names the repository,
// so the call works from outside a Herdr workspace too.
export function startHerdr(start: Start, runner: Runner, setupFor: SetupFor): Started {
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
  untrack(start, runner)
  const setup = setupFor(path)
  if (setup) runner.shell(setup, path)
  if (!start.agent) return { host: 'herdr', issue: start.issue, branch: start.branch, path, agent: null }
  const pane = herdrPane(JSON.parse(reply || '{}'), runner)
  if (!pane) throw new Error(`no pane found in the workspace herdr created: ${reply}`)
  let agent: string
  const shell = shellLaunch(start.agent)
  if (shell) {
    runner.run('herdr', ['pane', 'run', pane, shell])
    herdrAgentIn(pane, runner)
    agent = pane
  } else {
    const extra = agentArgs(start.agent)
    const args = ['agent', 'start', name, '--kind', start.agent.kind, '--pane', pane]
    runner.run('herdr', [...args, ...(extra.length ? ['--', ...extra] : [])])
    agent = name
  }
  runner.run('herdr', ['agent', 'prompt', agent, start.brief])
  return { host: 'herdr', issue: start.issue, branch: start.branch, path, agent }
}

// Herdr creates the branch from origin/<base>, which git may record as its upstream: a
// pull would then track the base. The branch gets its upstream when it is first pushed.
function untrack(start: Start, runner: Runner): void {
  try {
    runner.run('git', ['branch', '--unset-upstream', start.branch], { cwd: start.root })
  } catch {
    // No upstream was set.
  }
}

// Plain git: the worktree and its setup; the person starts the agent with the brief.
export function startGit(start: Start, runner: Runner, setupFor: SetupFor): Started {
  const path = join(start.root, '.worktrees', flat(start.branch))
  // From origin/<base>, git would otherwise make the base the new branch's upstream.
  runner.run('git', ['worktree', 'add', '--no-track', '-b', start.branch, path, start.base], { cwd: start.root })
  const setup = setupFor(path)
  if (setup) runner.shell(setup, path)
  return { host: 'git', issue: start.issue, branch: start.branch, path, agent: null }
}
