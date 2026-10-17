// `lntt worktree start`: an agent on an issue, in its own worktree, on the host the
// session runs in (usage: bin/lntt.ts).

import { execFileSync, spawnSync } from 'node:child_process'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { checkBranch } from './branch.ts'
import { nameFromIssue, readIssue, rules } from './branch-cli.ts'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
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

const USAGE =
  'usage: lntt worktree start --issue <n> [--issue <n>]... [--host orca|herdr|git] [--kind <agent>] [--model <id>] [--effort <level>] [--no-agent] [--base <branch>] [--prompt <text>]'
const HOSTS: WorktreeHost[] = ['orca', 'herdr', 'git']

function usage(message?: string): never {
  if (message) stderr.write(`lntt worktree: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// One call to a tool: its stdout, trimmed, is the result. What it says on stderr reaches
// the person as it says it (a long setup shows its progress); a refusal's reason comes
// from its reply on stdout (Orca's JSON), else its exit code points at what it printed.
// A tool that is not installed is an error.
export function runTool(command: string, args: string[], dir: string): string {
  const r = spawnSync(command, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (r.error) throw r.error
  if (r.status !== 0) {
    const why = toolFailure(command, args, r.stdout ?? '', '')
    throw new Error(why.endsWith(' failed') ? `${why} (exit ${r.status ?? r.signal}; its output is above)` : why)
  }
  return (r.stdout ?? '').trim()
}

const runner: Runner = {
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

// delivery.candidate.base, else main.
function configuredBase(): string {
  try {
    const delivery = loadConfig(cwd()).data.delivery as { candidate?: { base?: string } } | undefined
    return delivery?.candidate?.base ?? 'main'
  } catch (error) {
    if (error instanceof ConfigError) return 'main'
    throw error
  }
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

function start(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      issue: { type: 'string', multiple: true },
      host: { type: 'string' },
      kind: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'no-agent': { type: 'boolean', default: false },
      base: { type: 'string' },
      prompt: { type: 'string' },
    },
  })
  const issues = values.issue ?? []
  if (issues.length === 0) usage('give at least one --issue')
  for (const issue of issues) if (!/^[1-9]\d*$/.test(issue)) usage(`--issue takes a number, not ${issue}`)
  const host = (values.host ?? worktreeHost(env)) as WorktreeHost
  if (!HOSTS.includes(host)) usage(`--host is ${HOSTS.join(', ')}, not ${values.host}`)

  const agent: Agent = {
    kind: values.kind,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
  }
  // Refused before anything is created: what the agent cannot take.
  agentArgs(agent)
  shellLaunch(agent)
  const root = mainCheckout()
  const base = values.base ?? configuredBase()
  const ruleset = rules()
  // Every issue is read and named before anything is created: a batch either starts
  // whole or not at all.
  const jobs: Start[] = issues.map((raw) => {
    const issue = Number(raw)
    const data = readIssue(issue)
    const branch = nameFromIssue(issue, {}, data)
    const check = checkBranch(branch, ruleset)
    if (!check.ok) throw new Error(`#${issue}: ${branch} is not a valid name: ${check.reason}`)
    const worktree =
      host === 'orca' ? 'the worktree this session starts in' : `${root}/.worktrees/${branch.replace(/\//g, '-')}`
    return {
      issue,
      title: data.title,
      branch,
      base: host === 'orca' ? base : gitBase(root, base),
      agent: values['no-agent'] || host === 'git' ? null : agent,
      root,
      brief: values.prompt ?? renderBrief(undefined, { issue, title: data.title, branch, worktree }),
    }
  })
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
