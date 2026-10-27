// `lntt ci`: the project's CI on the local machine, and its candidate automation
// (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import {
  acquireLock,
  candidate,
  candidateConfig,
  ciConfig,
  circleciJobs,
  containerCommand,
  defaultBranch,
  exitCode,
  formatList,
  formatReport,
  githubJobs,
  holdDeadline,
  type Lock,
  localEvent,
  missingTools,
  proved,
  runJobs,
  stopRunning,
} from './index.ts'

const USAGE = [
  'usage: lntt ci local [--event pull_request|push] [--base <branch>] [--job <key>]... [--list] [--strict] [--container] [--no-lock]',
  '       lntt ci candidate [--pr <n>] [--event <action>] [--head-ref <ref>] [--labels a,b] [--merged] [--dry-run]',
  '       lntt ci proved --job <name>... [--step <name>] [--workflow <file>] [--sha <sha>] [--before <sha>] [--branch <name>]',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt ci: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// A parse error is a usage error.
function guard<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    usage((error as Error).message)
  }
}

// Gives the lock back; one that cannot be is one line, and the run's exit code stands: its
// record goes stale by the dead pid.
function giveBack(lock: Lock | null): void {
  try {
    lock?.release()
  } catch (error) {
    stderr.write(`lntt ci: cannot give the ci:local lock back (${(error as Error).message}) — ${lock?.path}\n`)
  }
}

async function local(args: string[]): Promise<number> {
  const { values } = guard(() =>
    parseArgs({
      args,
      options: {
        event: { type: 'string', default: 'pull_request' },
        base: { type: 'string' },
        job: { type: 'string', multiple: true },
        list: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        container: { type: 'boolean', default: false },
        'no-lock': { type: 'boolean', default: false },
      },
    }),
  )
  const event = values.event
  if (event !== 'pull_request' && event !== 'push') usage(`--event is pull_request or push, not ${event}`)
  const root = git('rev-parse', '--show-toplevel')
  process.chdir(root)
  const config = ciConfig(root)
  const localEv = localEvent(root, event, values.base ?? defaultBranch(root))
  const jobs = [...(await githubJobs(root, localEv, config)), ...circleciJobs(root, localEv, config)]
  const only = values.job
  for (const key of only ?? []) {
    if (!jobs.some((j) => j.key === key)) usage(`no job ${key} (${jobs.map((j) => j.key).join(', ')})`)
  }
  if (values.list) {
    stdout.write(`${formatList(localEv, jobs)}\n`)
    return 0
  }
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    stderr.write(
      `lntt ci: the working tree has uncommitted changes; ci:local checks the commit about to be pushed:\n${dirty}\n`,
    )
    return 1
  }
  const strict = values.strict
  if (values.container) {
    const missing = missingTools(jobs, only)
    if (missing.length > 0) {
      stderr.write(`lntt ci: container mode needs ${missing.join(', ')} on the PATH\n`)
      return 1
    }
  }
  // An interrupt starts nothing more, stops the running command's process group, which
  // does not get the terminal's signals, gives the lock back and exits 128 + the signal's
  // number: no report of a run cut short.
  const interrupt = new AbortController()
  let lock: Lock | null = null
  let interrupted: Promise<never> | null = null
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGQUIT', 131],
  ] as const) {
    process.on(signal, () => {
      if (interrupted) return
      stderr.write(`lntt ci: interrupted (${signal}): stopping the running step\n`)
      interrupt.abort()
      interrupted = stopRunning().then(() => {
        giveBack(lock)
        exit(code)
      })
    })
  }
  if (!values['no-lock']) lock = await acquireLock(root, config.lock, (line) => stderr.write(`${line}\n`))
  const held = lock
  try {
    const results = await runJobs(jobs, {
      log: (line) => stdout.write(`${line}\n`),
      ...(only ? { only } : {}),
      ...(values.container ? { container: containerCommand(localEv, config) } : {}),
      timeoutMs: config.timeoutMinutes * 60_000,
      signal: interrupt.signal,
      ...(held
        ? {
            deadline: holdDeadline(held.owner),
            onGroup: held.setGroup,
          }
        : {}),
    })
    if (interrupted) await interrupted
    stdout.write(`${formatReport(localEv, results, { strict })}\n`)
    return exitCode(results, { strict })
  } finally {
    giveBack(lock)
  }
}

function candidateRun(args: string[]): number {
  const { values } = guard(() =>
    parseArgs({
      args,
      options: {
        pr: { type: 'string' },
        event: { type: 'string' },
        'head-ref': { type: 'string' },
        labels: { type: 'string' },
        merged: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    }),
  )
  const log = (line: string) => stdout.write(`${line}\n`)
  const config = candidateConfig(cwd())
  if (!config) {
    log('::notice::no delivery.candidate in .agents/config: the candidate automation does nothing')
    return 0
  }
  const gh = candidate.makeGh({ dryRun: values['dry-run'], log })
  // The Projects permission is another token in the workflow (PROJECTS_GH_TOKEN); from
  // a terminal the operator's own gh login is the one in use.
  const board = candidate.pickBoard(env.PROJECTS_GH_TOKEN, Boolean(env.GITHUB_ACTIONS), gh, (token) =>
    candidate.makeGh({ dryRun: values['dry-run'], log, token }),
  )
  const repo = env.GITHUB_REPOSITORY ?? gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  let action: string
  let pr: candidate.PullRequest
  const number = values.pr
  if (number !== undefined) {
    if (!/^\d+$/.test(number)) usage(`--pr takes a number, not ${number}`)
    pr = candidate.prFromGh(gh, repo, Number(number))
    action = values.event ?? (pr.merged ? 'closed' : 'opened')
  } else {
    if (!env.GITHUB_EVENT_PATH) usage('without --pr, GITHUB_EVENT_PATH must name the pull_request event')
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    action = event.action
    pr = candidate.prFromEvent(event)
  }
  if (values['head-ref'] !== undefined) pr.headRef = values['head-ref']
  if (values.labels !== undefined) pr.labels = values.labels.split(',').filter((l) => l !== '')
  if (values.merged) pr.merged = true
  candidate.handle({ gh, ...(board ? { board } : {}), repo, config, log }, action, pr)
  return 0
}

// The push event's previous tip, when the run has one: an unreadable event has none,
// and no previous tip is not proved.
function eventBefore(): string {
  if (!env.GITHUB_EVENT_PATH) return ''
  try {
    const before = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')).before
    return typeof before === 'string' ? before : ''
  } catch {
    return ''
  }
}

// Exit 0 only when the tree is proved: any other code, a crash included, is the full run.
function provedRun(args: string[]): number {
  const { values } = guard(() =>
    parseArgs({
      args,
      options: {
        job: { type: 'string', multiple: true },
        step: { type: 'string' },
        workflow: { type: 'string' },
        sha: { type: 'string' },
        before: { type: 'string' },
        branch: { type: 'string' },
      },
    }),
  )
  if (!values.job?.length) usage('--job names a job that must be green; repeatable')
  const log = (line: string) => stdout.write(`${line}\n`)
  const gh = candidate.makeGh({ dryRun: true, log })
  const workflow = values.workflow ?? basename((env.GITHUB_WORKFLOW_REF ?? '').split('@')[0] ?? '')
  if (!workflow) usage('--workflow names the workflow file, outside Actions')
  const result = proved(gh, {
    repo: env.GITHUB_REPOSITORY ?? gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
    sha: values.sha ?? env.GITHUB_SHA ?? git('rev-parse', 'HEAD'),
    before: values.before ?? eventBefore(),
    branch: values.branch ?? env.GITHUB_REF_NAME ?? '',
    workflow,
    jobs: values.job ?? [],
    step: values.step,
  })
  const annotation = env.GITHUB_ACTIONS
    ? result.proved
      ? '::notice title=Tree already proved::'
      : '::notice title=Full run::'
    : ''
  log(`${annotation}${result.proved ? 'proved' : 'not proved'}: ${result.reason}`)
  return result.proved ? 0 : 1
}

// `lntt ci <command> [...]`: the arguments after `ci`.
export async function main([command, ...args]: string[]): Promise<never> {
  try {
    if (command === 'local') exit(await local(args))
    if (command === 'candidate') exit(candidateRun(args))
    if (command === 'proved') exit(provedRun(args))
    usage()
  } catch (error) {
    stderr.write(`lntt ci: ${(error as Error).message}\n`)
    exit(1)
  }
}
