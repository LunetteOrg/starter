// `lntt branch`: the branch name an issue gets, a check of the current branch, and
// the rename that fixes the name a tool gave it (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { type BranchRules, branchName, branchRules, checkBranch, fromToolName, slugify, typeFor } from './branch.ts'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
import { detectHost } from './viewer.ts'

const USAGE = [
  'usage: lntt branch name (--issue <n> | --type <type> --slug <slug>) [--type <type>] [--slug <slug>]',
  '       lntt branch check [--branch <name>]',
  '       lntt branch rename',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt branch: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// A project without a configuration file still gets the default rules.
export function rules(): BranchRules {
  try {
    return branchRules(loadConfig(cwd()).data)
  } catch (error) {
    if (error instanceof ConfigError && /no \.agents\/config/.test(error.message)) return branchRules({})
    throw error
  }
}

export interface Issue {
  title: string
  labels: { name: string }[]
  type?: { name: string } | null
}

export function readIssue(issue: number): Issue {
  return JSON.parse(run('gh', ['api', `repos/{owner}/{repo}/issues/${issue}`])) as Issue
}

export function nameFromIssue(
  issue: number,
  overrides: { type?: string; slug?: string },
  data = readIssue(issue),
): string {
  const type = overrides.type ?? typeFor({ type: data.type?.name ?? null, labels: data.labels.map((l) => l.name) })
  return branchName(type, issue, overrides.slug ?? slugify(data.title))
}

// The issue Orca linked to this worktree, when the session runs in Orca.
function orcaIssue(): number | null {
  if (detectHost(env) !== 'orca') return null
  try {
    const reply = JSON.parse(run('orca', ['worktree', 'current', '--json']))
    const issue = reply?.result?.worktree?.linkedIssue
    return typeof issue === 'number' ? issue : null
  } catch {
    return null
  }
}

function name(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { issue: { type: 'string' }, type: { type: 'string' }, slug: { type: 'string' } },
  })
  const overrides = {
    ...(values.type ? { type: values.type } : {}),
    ...(values.slug ? { slug: values.slug } : {}),
  }
  let result: string
  if (values.issue !== undefined) {
    if (!/^[1-9]\d*$/.test(values.issue)) usage(`--issue takes a number, not ${values.issue}`)
    result = nameFromIssue(Number(values.issue), overrides)
  } else {
    if (!values.type || !values.slug) usage('without --issue, give --type and --slug')
    result = branchName(values.type, null, values.slug)
  }
  const check = checkBranch(result, rules())
  if (!check.ok) {
    stderr.write(`lntt branch: ${result} is not a valid name: ${check.reason}; give --slug (or --type)\n`)
    exit(1)
  }
  stdout.write(`${result}\n`)
}

function check(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { branch: { type: 'string' }, 'pre-push': { type: 'boolean', default: false } },
  })
  const ruleset = rules()
  const branches = values['pre-push']
    ? pushedBranches(readFileSync(0, 'utf8'))
    : [values.branch || run('git', ['branch', '--show-current'])]
  let failed = false
  for (const branch of branches) {
    const result = checkBranch(branch, ruleset)
    if (result.ok) continue
    const fix = result.expected
      ? `rename it: git branch -m ${result.expected}`
      : 'rename it to the name lntt branch name --issue <n> prints'
    stderr.write(`lntt branch: ${branch} does not follow type/issue/slug: ${result.reason}; ${fix}\n`)
    failed = true
  }
  if (failed) exit(1)
}

// The branches a push creates or updates, from the lines git gives the pre-push hook
// (`<local ref> <local sha> <remote ref> <remote sha>`): tags and deletions are not
// branch names to check.
function pushedBranches(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, localSha, remoteRef]) => localSha && !/^0+$/.test(localSha) && remoteRef?.startsWith('refs/heads/'))
    .map(([, , remoteRef]) => (remoteRef as string).slice('refs/heads/'.length))
}

// Never fails: it runs in a worktree's setup, where a name it cannot fix is reported,
// not fatal. CI and the pre-push hook stop the branch if it stays wrong.
function rename(): void {
  const current = run('git', ['branch', '--show-current'])
  if (current === '') {
    stderr.write('lntt branch: HEAD is detached; nothing to rename\n')
    return
  }
  const ruleset = rules()
  if (checkBranch(current, ruleset).ok) return
  let target = fromToolName(current, ruleset)
  if (!target) {
    const issue = orcaIssue()
    if (issue !== null) {
      try {
        target = nameFromIssue(issue, {})
      } catch (error) {
        stderr.write(`lntt branch: could not read issue #${issue}: ${(error as Error).message}\n`)
      }
    }
  }
  const valid = target ? checkBranch(target, ruleset) : null
  if (target && valid && !valid.ok) {
    stderr.write(
      `lntt branch: ${target}, built from the issue, is not a valid name: ${valid.reason}; ${current} stays\n`,
    )
    return
  }
  if (!target) {
    stderr.write(
      `lntt branch: ${current} does not follow type/issue/slug and holds nothing to rebuild it from; ` +
        'rename it with git branch -m "$(lntt branch name --issue <n>)"\n',
    )
    return
  }
  try {
    run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`])
    stderr.write(`lntt branch: ${target} already exists; ${current} stays as it is\n`)
    return
  } catch {
    // No branch by that name: free to take it.
  }
  run('git', ['branch', '-m', target])
  stdout.write(`${current} → ${target}\n`)
}

export function main([command, ...args]: string[]): void {
  try {
    if (command === 'name') name(args)
    else if (command === 'check') check(args)
    else if (command === 'rename') rename()
    else usage()
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    stderr.write(`lntt branch: ${(error as Error).message}\n`)
    exit(1)
  }
}
