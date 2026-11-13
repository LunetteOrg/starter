// Starting an agent on an issue in its own worktree, on the host the session runs in. The steps
// are the same everywhere (the branch name from `lntt branch`, the setup orca.yaml declares, the
// brief from agents/brief.md); each host gets a small adapter for the calls it understands.
//
// The adapters are plain: each is a generator that yields the step it needs (a tool to run, a
// script to run, a pause, the setup of a worktree) and receives its result, so it reaches nothing
// itself. Two drivers run the same steps: the synchronous one over a Runner, which the library's
// startOrca, startHerdr and startGit use and which loads no Effect (src/worktree.ts), and the one on
// Effect, over the spawner, the Clock and the FileSystem, which `lntt worktree start` uses
// (src/worktree/steps.ts). A step that fails is thrown into the generator, so an adapter catches
// what it expects (untrack) as plain code would.

import { parse } from 'yaml'
import { fill } from '../template.ts'

export type WorktreeHost = 'orca' | 'herdr' | 'git'

type Env = Record<string, string | undefined>

export interface Start {
  // Null for a coordinator's own worktree, which is on no issue.
  issue: number | null
  title: string
  branch: string
  base: string
  // The agent to launch, or null to leave it to the person.
  agent: Agent | null
  // The main checkout: plain git and Herdr put worktrees under <root>/.worktrees/.
  root: string
  brief: string
  // The coordinator's worktree, as the host selects it. Orca draws the lineage from it; Herdr and
  // plain git have none, and the child reaches its coordinator through the mailbox.
  parent?: string
}

// kind: the agent CLI (claude, codex, opencode, …), as Orca's --agent and Herdr's --kind name it.
// model and effort: left to the agent's own configuration when absent.
export interface Agent {
  kind: string
  model?: string
  effort?: string
}

export interface Started {
  host: WorktreeHost
  issue: number | null
  branch: string
  path: string | null
  // How to reach the agent: Orca's terminal handle or dispatch id, Herdr's agent name or pane.
  agent: string | null
  // The coordinator's worktree, for a child started under one.
  parent?: string
}

// What an adapter asks of its driver, and what it gets back: `run` a tool's stdout, trimmed (a
// tool that refuses throws); `shell` runs a script in a directory and fails when it does; `sleep`
// waits; `setup` is the setup a worktree declares (setupOf), null for none.
export type Step =
  | { kind: 'run'; command: string; args: string[]; cwd?: string }
  | { kind: 'shell'; script: string; cwd: string }
  | { kind: 'sleep'; ms: number }
  | { kind: 'setup'; worktree: string }

export type Steps<A> = Generator<Step, A, unknown>

export function* run(command: string, args: string[], cwd?: string): Steps<string> {
  return (yield { kind: 'run', command, args, ...(cwd === undefined ? {} : { cwd }) }) as string
}
function* shell(script: string, cwd: string): Steps<void> {
  yield { kind: 'shell', script, cwd }
}
function* sleep(ms: number): Steps<void> {
  yield { kind: 'sleep', ms }
}
function* setupFor(worktree: string): Steps<string | null> {
  return (yield { kind: 'setup', worktree }) as string | null
}

// The innermost host creates the worktree. Herdr runs inside a terminal, so an Orca terminal can
// hold a Herdr session (both sets of variables present) and never the other way round. Wave and
// Claude desktop create no worktrees: plain git.
export function worktreeHost(env: Env): WorktreeHost {
  if (env.HERDR_ENV === '1') return 'herdr'
  if (env.TERM_PROGRAM === 'Orca' || env.ORCA_WORKTREE_ID) return 'orca'
  return 'git'
}

// The templates of the briefs, by file name in agents/ (brief.md, waiting.md, …).
export type Templates = Record<string, string>

export const template = (templates: Templates, name: string) => {
  const text = templates[name]
  if (text === undefined) throw new Error(`no template ${name} in lntt's agents/`)
  return text
}

// How a child routes every wait through the mailbox: to its coordinator with a theme, to the
// orchestrator otherwise; its issue tags the topic either way.
export function waitingSection(templates: Templates, issue: number, theme?: string): string {
  const to = theme ? `--to coordinator --theme ${theme}` : '--to orchestrator'
  const ask = `pnpm exec lntt ask ${to} --issue ${issue}`
  return fill(template(templates, 'waiting.md'), { ask, issue }).trimEnd()
}

export interface BriefValues {
  issue: number
  title: string
  branch: string
  worktree: string
}

// The brief of a plain issue, from `brief` or the shipped brief.md; a child of a coordinator gets
// childBrief (src/worktree/coordinator.ts).
export function renderBrief(templates: Templates, brief: string | undefined, values: BriefValues): string {
  return fill(brief ?? template(templates, 'brief.md'), {
    theme: '',
    reporting: '',
    workflow: '',
    waiting: waitingSection(templates, values.issue),
    ...values,
  })
}

// The setup a worktree's orca.yaml declares, null for none.
export function setupOf(text: string): string | null {
  const setup = (parse(text) as { scripts?: { setup?: unknown } } | null)?.scripts?.setup
  return typeof setup === 'string' && setup.trim() !== '' ? setup : null
}

// Model and effort as each agent CLI takes them on its interactive command line (Herdr, the
// command printed for plain git). What the agent has no flag for is an error: dropping it would
// launch a different agent than the one asked for.
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
// OPENCODE_CONFIG_CONTENT, which only a standalone server reads (the shared background service
// ignores it). Such a start is a shell command, not an executable with arguments. Null for an
// agent that starts with plain arguments.
export function shellLaunch(agent: Agent): string | null {
  if (agent.kind !== 'opencode' || !agent.model) return null
  if (!/^[\w.:-]+\/[\w.:/-]+$/.test(agent.model)) throw new Error(`opencode model ${agent.model} is not provider/model`)
  return `OPENCODE_CONFIG_CONTENT='${JSON.stringify({ model: agent.model })}' opencode --standalone`
}

// A branch name as one path segment: Orca's worktree name, Herdr's label, the folder.
export function flat(branch: string): string {
  return branch.replace(/\//g, '-')
}

// Why a tool refused, for the person: the message Orca writes in its JSON reply, else the last
// lines it printed.
export function toolFailure(command: string, args: string[], stdout: string, stderr: string): string {
  const what = [command, ...args.slice(0, 2)].join(' ')
  try {
    const message = (JSON.parse(stdout) as { error?: { message?: string } }).error?.message
    if (message) return `${what}: ${message}`
  } catch {}
  const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-3).join(' ').trim()
  return tail ? `${what}: ${tail}` : `${what} failed`
}

// A refusal with the exit code when the tool said nothing of its own.
export function refusal(command: string, args: string[], stdout: string, stderr: string, code: number | string) {
  const why = toolFailure(command, args, stdout, stderr)
  return why.endsWith(' failed') ? `${why} (exit ${code})` : why
}

// What `orca worktree create` lists in its help. A tuned agent needs it to say whether Orca takes
// the model and effort (1.4.229 does, 1.4.224 did not); an Orca that cannot say is an error for
// it: guessing the older path would fail later, for another reason.
const createHelp = () => run('orca', ['worktree', 'create', '--help'])

function orcaTakesModel(help: string): boolean {
  if (!help.trim())
    throw new Error('orca worktree create --help printed nothing: lntt could not tell whether it takes --model')
  return /--model\b/.test(help)
}

// Whether `worktree create` takes `--surface`. Without it Orca opens the agent as a chat or a
// terminal by the operator's own setting, and a coordinator reads and writes a child only through
// `orca terminal`: lntt asks for the terminal where Orca can be asked.
const orcaTakesSurface = (help: string): boolean => /--surface(?![\w-])/.test(help)

// `orca worktree create`: the name, the issue it is linked to and the coordinator it descends
// from, when there are any.
function createArgs(start: Start): string[] {
  const args = ['worktree', 'create', '--name', flat(start.branch)]
  if (start.issue !== null) args.push('--issue', String(start.issue))
  if (start.parent) args.push('--parent-worktree', start.parent)
  return args
}

const json = (text: string): unknown => JSON.parse(text || '{}')

// Orca prefixes the worktree name with the user (`<user>/feat-78-slug`); its setup (orca.yaml,
// `lntt branch rename`) reads the convention back. The agent starts after the setup
// (setupAgentStartupPolicy: wait-for-setup).
export function* startOrca(start: Start): Steps<Started> {
  const command = start.agent ? shellLaunch(start.agent) : null
  if (command) return yield* startOrcaShell(start, command)
  const tuned = Boolean(start.agent?.model || start.agent?.effort)
  // An Orca whose help cannot be run fails here, loudly, as its next call would; one whose help
  // prints nothing starts an untuned agent with no flag.
  const help = start.agent ? yield* createHelp() : ''
  if (start.agent && tuned && !orcaTakesModel(help)) return yield* startOrcaWorker(start, start.agent)
  const args = createArgs(start)
  args.push('--base-branch', start.base, '--setup', 'run', '--json')
  if (start.agent) {
    args.push('--agent', start.agent.kind, '--prompt', start.brief)
    if (start.agent.model) args.push('--model', start.agent.model)
    if (start.agent.effort) args.push('--effort', start.agent.effort)
    if (orcaTakesSurface(help)) args.push('--surface', 'terminal')
  }
  const reply = json(yield* run('orca', args)) as {
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
    ...parentOf(start),
  }
}

// The worktree with its issue linked and Orca's setup skipped, then the setup run here: Orca's
// setup terminal stays open as a shell, with no end to wait for.
function* orcaWorktree(start: Start): Steps<string> {
  const args = createArgs(start)
  args.push('--base-branch', start.base, '--setup', 'skip', '--json')
  const path = find(json(yield* run('orca', args)), 'path')
  if (typeof path !== 'string') throw new Error('orca worktree create returned no path')
  const setup = yield* setupFor(path)
  if (setup) yield* shell(setup, path)
  return path
}

// An agent started by a shell command (shellLaunch) in a terminal of its own; the brief is sent
// once its interface is idle, never before: text typed into a starting interface is lost.
function* startOrcaShell(start: Start, command: string): Steps<Started> {
  const path = yield* orcaWorktree(start)
  const created = yield* run('orca', [
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
  const handle = find(json(created), 'handle')
  if (typeof handle !== 'string') throw new Error(`orca terminal create returned no handle: ${created}`)
  const waited = yield* run('orca', [
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
  if (find(json(waited), 'satisfied') !== true) {
    throw new Error(`the agent in ${handle} is not ready; the brief was not sent`)
  }
  yield* run('orca', ['terminal', 'send', '--terminal', handle, '--text', start.brief, '--enter', '--json'])
  return { host: 'orca', issue: start.issue, branch: start.branch, path, agent: handle, ...parentOf(start) }
}

// On an Orca whose `worktree create --agent` takes no model or effort, Orca's supervised worker
// does, on a worktree that already exists (orcaWorktree). It needs a Run bound to the calling
// terminal, created when there is none; Orca wraps the brief in its own preamble and the agent
// reports `worker_done` to the Run.
function* startOrcaWorker(start: Start, agent: Agent): Steps<Started> {
  agentArgs(agent) // what the agent cannot take fails before anything is created
  const current = json(yield* run('orca', ['orchestration', 'run-current', '--json']))
  if (!find(current, 'run')) {
    yield* run('orca', [
      'orchestration',
      'run-create',
      '--objective',
      `lntt worktree start ${start.issue === null ? start.title : `#${start.issue}`}`,
      '--json',
    ])
  }
  const path = yield* orcaWorktree(start)
  const worker = ['orchestration', 'worker-start', '--spec', start.brief, '--worktree', `path:${path}`]
  worker.push('--agent', agent.kind, '--json')
  if (agent.model) worker.push('--model', agent.model)
  if (agent.effort) worker.push('--effort', agent.effort)
  const dispatch = find(json(yield* run('orca', worker)), 'dispatchId')
  return {
    host: 'orca',
    issue: start.issue,
    branch: start.branch,
    path,
    agent: typeof dispatch === 'string' ? dispatch : 'unknown',
    ...parentOf(start),
  }
}

const parentOf = (start: Start) => (start.parent ? { parent: start.parent } : {})

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

// The new workspace's pane: in the create reply when Herdr includes it, else the first pane of the
// workspace it names.
function* herdrPane(reply: unknown): Steps<string | null> {
  const pane = find(reply, 'pane_id')
  if (typeof pane === 'string') return pane
  const workspace = find(reply, 'workspace_id')
  if (typeof workspace !== 'string') return null
  const listed = find(json(yield* run('herdr', ['pane', 'list', '--workspace', workspace])), 'pane_id')
  return typeof listed === 'string' ? listed : null
}

// An agent started by a shell command is not named by Herdr: wait until Herdr detects it in the
// pane, so the brief reaches the agent and not the shell.
function* herdrAgentIn(pane: string): Steps<void> {
  for (let tries = 0; tries < 60; tries += 1) {
    const agents = find(json(yield* run('herdr', ['agent', 'list'])), 'agents')
    if (Array.isArray(agents) && agents.some((a) => (a as { pane_id?: string }).pane_id === pane)) return
    yield* sleep(1000)
  }
  throw new Error(`herdr detected no agent in ${pane}; the brief was not sent`)
}

// Herdr takes the branch name as given and has no setup hook: the setup runs here, before the
// agent starts in the new workspace's pane. `--cwd` names the repository, so the call works from
// outside a Herdr workspace too.
export function* startHerdr(start: Start): Steps<Started> {
  const name = flat(start.branch)
  const path = `${start.root}/.worktrees/${name}`
  const reply = yield* run('herdr', [
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
  yield* untrack(start)
  const setup = yield* setupFor(path)
  if (setup) yield* shell(setup, path)
  if (!start.agent)
    return { host: 'herdr', issue: start.issue, branch: start.branch, path, agent: null, ...parentOf(start) }
  const pane = yield* herdrPane(json(reply))
  if (!pane) throw new Error(`no pane found in the workspace herdr created: ${reply}`)
  let agent: string
  const command = shellLaunch(start.agent)
  if (command) {
    yield* run('herdr', ['pane', 'run', pane, command])
    yield* herdrAgentIn(pane)
    agent = pane
  } else {
    const extra = agentArgs(start.agent)
    const args = ['agent', 'start', name, '--kind', start.agent.kind, '--pane', pane]
    yield* run('herdr', [...args, ...(extra.length ? ['--', ...extra] : [])])
    agent = name
  }
  yield* run('herdr', ['agent', 'prompt', agent, start.brief])
  return { host: 'herdr', issue: start.issue, branch: start.branch, path, agent, ...parentOf(start) }
}

// Herdr creates the branch from origin/<base>, which git may record as its upstream: a pull would
// then track the base. The branch gets its upstream when it is first pushed.
function* untrack(start: Start): Steps<void> {
  try {
    yield* run('git', ['branch', '--unset-upstream', start.branch], start.root)
  } catch {
    // No upstream was set.
  }
}

// Plain git: the worktree and its setup; the person starts the agent with the brief.
export function* startGit(start: Start): Steps<Started> {
  const path = `${start.root}/.worktrees/${flat(start.branch)}`
  // From origin/<base>, git would otherwise make the base the new branch's upstream.
  yield* run('git', ['worktree', 'add', '--no-track', '-b', start.branch, path, start.base], start.root)
  const setup = yield* setupFor(path)
  if (setup) yield* shell(setup, path)
  return { host: 'git', issue: start.issue, branch: start.branch, path, agent: null, ...parentOf(start) }
}

// The adapter of a host.
export const startOn = (host: WorktreeHost, start: Start): Steps<Started> =>
  host === 'orca' ? startOrca(start) : host === 'herdr' ? startHerdr(start) : startGit(start)

// Runs the steps with `perform`, which answers each step or throws; what it throws is thrown into
// the steps, where an adapter may catch it. The synchronous driver.
export function drive<A>(steps: Steps<A>, perform: (step: Step) => unknown): A {
  let next = steps.next()
  while (!next.done) {
    let result: unknown
    try {
      result = perform(next.value)
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(result)
  }
  return next.value
}
