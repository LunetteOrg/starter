// `lntt worktree start`: an agent on an issue, in its own worktree, on the host the
// session runs in (usage: bin/lntt.ts).

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { branchName, checkBranch } from './branch.ts'
import { nameFromIssue, readIssue, rules } from './branch-cli.ts'
import {
  agentFor,
  approvals,
  approve,
  type Config,
  childBrief,
  coordinatorBrief,
  gateOf,
  isApproval,
} from './coordinator.ts'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
import { send, waitForAnswer } from './messages.ts'
import { messagesRoot, pollInterval, systemMailbox } from './messages-cli.ts'
import {
  type Agent,
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
  type WorktreeHost,
  worktreeHost,
} from './worktree.ts'

const USAGE = [
  'usage: lntt worktree start --issue <n> [--issue <n>]... [--host orca|herdr|git] [--kind <agent>] [--model <id>] [--effort <level>] [--no-agent] [--base <branch>] [--prompt <text>]',
  '                           [--theme <slug> [--parent <worktree>] [--context <file>] [--size XS|S|M|L|XL] [--workflow]]',
  '       lntt worktree start --coordinator --theme <slug> --issue <n> [--issue <n>]... [--approve <n>]... [same options]',
].join('\n')
const HOSTS: WorktreeHost[] = ['orca', 'herdr', 'git']

function usage(message?: string): never {
  if (message) stderr.write(`lntt worktree: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// One call to a tool. stdout, trimmed, is the result. When the call succeeds, what the
// tool said on stderr reaches the person after it; when it fails, the error carries the
// reason (Orca's JSON message, else what the tool printed, else its exit code), once,
// and a failure the caller expects (removing an upstream that is not there) stays
// silent. The setup goes through runner.shell, which shows its output as it runs; the
// long calls here (Orca creating a worktree, waiting on a terminal) show their work in
// Orca. stderr is never filtered by its words, which change with the tool's version: a
// call whose stderr is noise would say so itself.
export function runTool(
  command: string,
  args: string[],
  dir: string,
  say: (text: string) => void = (text) => stderr.write(text),
): string {
  const r = spawnSync(command, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const why = toolFailure(command, args, r.stdout ?? '', r.stderr ?? '')
    throw new Error(why.endsWith(' failed') ? `${why} (exit ${r.status ?? r.signal})` : why)
  }
  if (r.stderr) say(r.stderr)
  return (r.stdout ?? '').trim()
}

// The real tools; exported for the upstream tests (test/upstream-*.test.ts), which run
// lntt's adapters against them.
export const runner: Runner = {
  run: (command, args, opts) => runTool(command, args, opts?.cwd ?? cwd()),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  shell: (script, dir) => {
    // The setup's output goes to stderr: stdout carries one JSON line per worktree.
    execFileSync('bash', ['-e', '-c', script], { cwd: dir, stdio: ['ignore', process.stderr, 'inherit'] })
  },
}

// The main checkout, also from a linked worktree: new worktrees go next to the others.
function mainCheckout(): string {
  const common = runner.run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return common.replace(/\/\.git$/, '')
}

// The project's configuration; a project without one has the defaults.
function projectConfig(): Config & { delivery?: { candidate?: { base?: string } } } {
  try {
    return loadConfig(cwd()).data as Config & { delivery?: { candidate?: { base?: string } } }
  } catch (error) {
    if (error instanceof ConfigError) return {}
    throw error
  }
}

// delivery.candidate.base, else main.
function configuredBase(config = projectConfig()): string {
  return config.delivery?.candidate?.base ?? 'main'
}

// git and Herdr branch from the remote's copy when there is one: the local base may be behind.
function gitBase(root: string, base: string): string {
  try {
    runner.run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], { cwd: root })
    return `origin/${base}`
  } catch {
    return base
  }
}

// The orca binary by absolute path, which every brief uses: a PATH that reaches it from
// one session does not from another. Null when Orca is not the host.
function orcaPath(host: WorktreeHost): string | null {
  if (host !== 'orca') return null
  try {
    return runner.run('sh', ['-c', 'command -v orca']) || null
  } catch {
    return null
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

// A coordinator's child waits for the person's go before anything is created, unless the
// theme's approved list already has it: the gate is the project's setting
// (coordinator.gate), not a sentence in a brief. The proposal is one message for the batch.
function passTheGate(config: Config, theme: string, jobs: Start[], size: string | undefined): void {
  if (gateOf(config) === 'free') return
  const root = messagesRoot()
  const approved = approvals(root, theme)
  const proposed = jobs.filter((job) => job.issue !== null && !approved.has(job.issue))
  if (proposed.length === 0) return
  const list = proposed.map((job) => `- #${job.issue}: ${job.title} (on ${job.base})`).join('\n')
  const box = systemMailbox()
  const issues = proposed.map((job) => job.issue as number)
  const sent = send(
    box,
    'orchestrator',
    `Coordinator ${theme} proposes to start${size ? ` (size ${size})` : ''}:\n${list}\nAnswer "approve" (or "yes", "ok") alone to start; anything else declines.`,
    {
      topic: `start-${issues.join('-')}`,
    },
  )
  stderr.write(`lntt worktree: ${sent.id} sent to the orchestrator; no child is created until it approves\n`)
  const reply = waitForAnswer(box, sent, { intervalMs: pollInterval() })
  if (!isApproval(reply)) throw new Error(`not approved by the orchestrator: ${reply.trim()}`)
  approve(root, theme, issues)
}

function start(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      issue: { type: 'string', multiple: true },
      host: { type: 'string' },
      kind: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'no-agent': { type: 'boolean', default: false },
      base: { type: 'string' },
      prompt: { type: 'string' },
      coordinator: { type: 'boolean', default: false },
      theme: { type: 'string' },
      approve: { type: 'string', multiple: true },
      parent: { type: 'string' },
      context: { type: 'string' },
      size: { type: 'string' },
      workflow: { type: 'boolean', default: false },
    },
  })
  const issues = values.issue ?? []
  if (issues.length === 0) usage('give at least one --issue')
  for (const issue of issues) if (!/^[1-9]\d*$/.test(issue)) usage(`--issue takes a number, not ${issue}`)
  const host = (values.host ?? worktreeHost(env)) as WorktreeHost
  if (!HOSTS.includes(host)) usage(`--host is ${HOSTS.join(', ')}, not ${values.host}`)

  const coordinator = values.coordinator
  const theme = values.theme
  if (theme !== undefined && !SLUG.test(theme)) usage(`--theme is a slug (a-z, 0-9, -), not ${theme}`)
  if (coordinator && !theme) usage('--coordinator needs the theme: --theme <slug>')
  for (const flag of ['parent', 'context', 'size', 'workflow'] as const) {
    if (coordinator && values[flag]) usage(`--${flag} is a child’s: a coordinator has none`)
  }
  if (!coordinator && values.approve) usage('--approve is the coordinator’s: the children it may start at once')
  for (const flag of ['parent', 'context', 'size', 'workflow'] as const) {
    if (!coordinator && !theme && values[flag]) usage(`--${flag} needs the theme the child belongs to: --theme <slug>`)
  }
  if (values.prompt !== undefined && (values.context || values.workflow)) {
    usage('--prompt replaces the whole brief, so --context and --workflow have nothing to add to')
  }
  const approved = (values.approve ?? []).map((raw) => {
    if (!issues.includes(raw)) usage(`--approve ${raw} is not one of the --issue of the theme`)
    return Number(raw)
  })

  const config = projectConfig()
  const given: Partial<Agent> = {
    ...(values.kind ? { kind: values.kind } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
  }
  const agent: Agent = coordinator
    ? agentFor(config, { role: 'coordinator' }, given)
    : agentFor(config, { role: 'child', ...(values.size ? { size: values.size } : {}) }, given)
  // Refused before anything is created: what the agent cannot take.
  agentArgs(agent)
  shellLaunch(agent)
  const context = values.context ? readFileSync(values.context, 'utf8') : undefined
  if (values.context && !context?.trim()) usage(`--context ${values.context} is empty`)
  const root = mainCheckout()
  const base = values.base ?? configuredBase(config)
  const ruleset = rules()
  const orca = orcaPath(host)
  const wherever = (branch: string) =>
    host === 'orca' ? 'the worktree this session starts in' : `${root}/.worktrees/${branch.replace(/\//g, '-')}`
  const launched = values['no-agent'] || host === 'git' ? null : agent

  // Every issue is read and named before anything is created: a batch either starts
  // whole or not at all.
  const jobs: Start[] = []
  if (coordinator) {
    const themeName = theme as string
    const branch = branchName('chore', null, themeName)
    const check = checkBranch(branch, ruleset)
    if (!check.ok) throw new Error(`${branch} is not a valid name: ${check.reason}`)
    const listed = issues.map((raw) => ({ issue: Number(raw), title: readIssue(Number(raw)).title }))
    jobs.push({
      issue: null,
      title: `Theme ${themeName}`,
      branch,
      base: host === 'orca' ? base : gitBase(root, base),
      agent: launched,
      root,
      brief:
        values.prompt ??
        coordinatorBrief({
          theme: themeName,
          worktree: wherever(branch),
          branch,
          issues: listed,
          approved,
          config,
          orca,
        }),
    })
  } else {
    for (const raw of issues) {
      const issue = Number(raw)
      const data = readIssue(issue)
      const branch = nameFromIssue(issue, {}, data)
      const check = checkBranch(branch, ruleset)
      if (!check.ok) throw new Error(`#${issue}: ${branch} is not a valid name: ${check.reason}`)
      const worktree = wherever(branch)
      const common = { issue, title: data.title, branch, worktree }
      jobs.push({
        issue,
        title: data.title,
        branch,
        base: host === 'orca' ? base : gitBase(root, base),
        agent: launched,
        root,
        ...(values.parent ? { parent: values.parent } : {}),
        brief:
          values.prompt ??
          (theme
            ? childBrief(common, { theme, ...(context ? { context } : {}), workflow: values.workflow, orca })
            : renderBrief(undefined, common)),
      })
    }
  }
  if (coordinator && approved.length > 0) approve(messagesRoot(), theme as string, approved)
  if (!coordinator && theme) passTheGate(config, theme, jobs, values.size)

  for (const job of jobs) {
    const started =
      host === 'orca'
        ? startOrca(job, runner, setupScript)
        : host === 'herdr'
          ? startHerdr(job, runner, setupScript)
          : startGit(job, runner, setupScript)
    stdout.write(`${JSON.stringify(started)}\n`)
    // Nobody was asked to start an agent: the command and the brief are for the person who will.
    if (job.agent === null) {
      const launch = shellLaunch(agent) ?? [agent.kind, ...agentArgs(agent)].join(' ')
      const command = host === 'git' ? `${launch}  # in ${started.path}\n\n` : ''
      stdout.write(`\n${command}${job.brief}\n`)
    }
  }
}

export function main([command, ...args]: string[]): void {
  try {
    if (command === 'start') start(args)
    else usage()
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    stderr.write(`lntt worktree: ${(error as Error).message}\n`)
    exit(1)
  }
}
