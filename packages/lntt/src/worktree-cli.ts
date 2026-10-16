// `lntt worktree start`: an agent on an issue, in its own worktree, on the host the
// session runs in (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { checkBranch } from './branch.ts'
import { nameFromIssue, readIssue, rules } from './branch-cli.ts'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
import {
  type Runner,
  renderBrief,
  type Start,
  type Started,
  setupScript,
  startGit,
  startHerdr,
  startOrca,
  type WorktreeHost,
  worktreeHost,
} from './worktree.ts'

const USAGE =
  'usage: lntt worktree start --issue <n> [--issue <n>]... [--host orca|herdr|git] [--agent <id> | --no-agent] [--base <branch>] [--prompt <text>]'
const HOSTS: WorktreeHost[] = ['orca', 'herdr', 'git']

function usage(message?: string): never {
  if (message) stderr.write(`lntt worktree: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

const runner: Runner = {
  run: (command, args, opts) =>
    execFileSync(command, args, {
      cwd: opts?.cwd ?? cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim(),
  shell: (script, dir) => {
    execFileSync('bash', ['-e', '-c', script], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] })
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
      agent: { type: 'string', default: 'claude' },
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

  const root = mainCheckout()
  const base = values.base ?? configuredBase()
  const setup = setupScript(root)
  const ruleset = rules()
  const results: Started[] = []
  for (const raw of issues) {
    const issue = Number(raw)
    const data = readIssue(issue)
    const branch = nameFromIssue(issue, {}, data)
    const check = checkBranch(branch, ruleset)
    if (!check.ok) throw new Error(`#${issue}: ${check.reason}`)
    const worktree =
      host === 'orca' ? 'the worktree this session starts in' : `${root}/.worktrees/${branch.replace(/\//g, '-')}`
    const brief = values.prompt ?? renderBrief(undefined, { issue, title: data.title, branch, worktree })
    const job: Start = {
      issue,
      title: data.title,
      branch,
      base: host === 'orca' ? base : gitBase(root, base),
      agent: values['no-agent'] || host === 'git' ? null : values.agent,
      root,
      brief,
    }
    const started =
      host === 'orca'
        ? startOrca(job, runner)
        : host === 'herdr'
          ? startHerdr(job, runner, setup)
          : startGit(job, runner, setup)
    results.push(started)
    stdout.write(`${JSON.stringify(started)}\n`)
    // Nobody started an agent: the brief is for the person who will.
    if (started.agent === null) stdout.write(`\n${brief}\n`)
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
