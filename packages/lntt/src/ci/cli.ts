// `lntt ci`: the project's CI on the local machine, and its candidate automation
// (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { cwd, env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { defaultBranch, projectBase, remoteRef } from '../base.ts'
import { CANDIDATE_PREFIX } from '../branch.ts'
import { Exit, exit, leave } from '../exit.ts'
import {
  acquireLock,
  candidate,
  candidateConfig,
  ciConfig,
  circleciJobs,
  containerCommand,
  type EventOptions,
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
  '       lntt ci candidate --follow [--dry-run]',
  '       lntt ci candidate --guard [--pr <n>]',
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

// The event's base and its options: --base as given; else, for a pull request, the base
// every lntt command resolves (src/base.ts), and for a push the default branch; both as
// the remote's copy.
function base(root: string, event: 'pull_request' | 'push', given: string | undefined): [string, EventOptions] {
  const candidate = candidateConfig(root)
  const options: EventOptions = { candidatePrefix: candidate?.prefix ?? CANDIDATE_PREFIX }
  if (given !== undefined) return [given, options]
  if (event === 'push') {
    const branch = defaultBranch(root, candidate)
    return [branch, { ...options, baseRef: remoteRef(root, branch) }]
  }
  // The report names the base and the ref; only a base that may be wrong is said here.
  const resolved = projectBase(root, 'head')
  if (resolved.warning) stderr.write(`lntt ci: ${resolved.warning}\n`)
  return [resolved.branch, { ...options, baseRef: resolved.ref }]
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
  const localEv = localEvent(root, event, ...base(root, event, values.base))
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
        return leave(code)
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
        follow: { type: 'boolean', default: false },
        guard: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    }),
  )
  if (values.follow) {
    const flag = ['pr', 'event', 'head-ref', 'labels'].find((name) => values[name as keyof typeof values] !== undefined)
    if (flag !== undefined || values.merged)
      usage(`--follow takes no --${flag ?? 'merged'}: it handles no pull request`)
  }
  if (values.guard) {
    const flag = ['follow', 'event', 'head-ref', 'labels', 'merged', 'dry-run'].find(
      (name) => values[name as keyof typeof values] === true || typeof values[name as keyof typeof values] === 'string',
    )
    if (flag !== undefined) usage(`--guard takes no --${flag}: it only reads the pull request`)
  }
  const log = (line: string) => stdout.write(`${line}\n`)
  const config = candidateConfig(cwd())
  if (!config) {
    log('::notice::no delivery.candidate in .agents/config: the candidate automation does nothing')
    return 0
  }
  if (values.guard) return guardRun(config, values.pr, log)
  const gh = candidate.makeGh({ dryRun: values['dry-run'], log })
  // The Projects permission is another token in the workflow (PROJECTS_GH_TOKEN); from
  // a terminal the operator's own gh login is the one in use.
  const board = candidate.pickBoard(env.PROJECTS_GH_TOKEN, Boolean(env.GITHUB_ACTIONS), gh, (token) =>
    candidate.makeGh({ dryRun: values['dry-run'], log, token }),
  )
  const repo = env.GITHUB_REPOSITORY ?? gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  // The local clone: the candidate follows the base through it (fetch, merge or rebase,
  // push). In Actions it authenticates with GH_TOKEN through its environment. `--pr`
  // from a terminal handles its pull request only: it gets no git, so it does not follow.
  const git =
    values.pr === undefined ? candidate.makeGit({ dryRun: values['dry-run'], log, cwd: cwd(), env }) : undefined
  const run: candidate.Run = { gh, ...(board ? { board } : {}), ...(git ? { git } : {}), repo, config, log }
  if (values.follow) {
    candidate.handlePush(run)
    return 0
  }
  let action: string
  let pr: candidate.PullRequest
  const number = values.pr
  if (number !== undefined) {
    if (!/^[1-9]\d*$/.test(number)) usage(`--pr takes a number, not ${number}`)
    pr = candidate.prFromGh(gh, repo, Number(number))
    action = values.event ?? (pr.merged ? 'closed' : 'opened')
  } else {
    if (!env.GITHUB_EVENT_PATH) usage('without --pr or --follow, GITHUB_EVENT_PATH must name the event')
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    // A push to the base: the candidate follows it. Any other event has nothing to do.
    if (!event.pull_request) {
      if (event.ref !== `refs/heads/${config.base}`) {
        log(`candidate: event ${event.ref || env.GITHUB_EVENT_NAME || 'without a pull request'}, nothing to do.`)
        return 0
      }
      candidate.handlePush(run)
      return 0
    }
    action = event.action
    pr = candidate.prFromEvent(event)
  }
  if (values['head-ref'] !== undefined) pr.headRef = values['head-ref']
  if (values.labels !== undefined) pr.labels = values.labels.split(',').filter((l) => l !== '')
  if (values.merged) pr.merged = true
  candidate.handle(run, action, pr)
  return 0
}

// `--guard`: the `candidate guard` check on the event's pull request, or on --pr's. It
// writes nothing and asks gh only for --pr; a failure is an error annotation and exit 1.
function guardRun(config: candidate.CandidateConfig, number: string | undefined, log: (line: string) => void): number {
  let pr: candidate.PullRequest
  if (number !== undefined) {
    if (!/^[1-9]\d*$/.test(number)) usage(`--pr takes a number, not ${number}`)
    const gh = candidate.makeGh({ dryRun: true, log })
    const repo = env.GITHUB_REPOSITORY || gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    pr = candidate.prFromGh(gh, repo, Number(number))
  } else {
    if (!env.GITHUB_EVENT_PATH) usage('--guard without --pr reads the pull request from GITHUB_EVENT_PATH')
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    if (!event.pull_request) usage('--guard runs on a pull_request event')
    pr = candidate.prFromEvent(event)
  }
  const decision = candidate.guardDecision(config, pr)
  if (decision.pass) {
    log(`candidate guard: #${pr.number} passes: ${decision.reason}.`)
    return 0
  }
  log(`::error title=Not on the candidate::${decision.reason}`)
  return 1
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
    repo: env.GITHUB_REPOSITORY || gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']),
    sha: values.sha ?? (env.GITHUB_SHA || git('rev-parse', 'HEAD')),
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
    if (error instanceof Exit) throw error
    stderr.write(`lntt ci: ${(error as Error).message}\n`)
    exit(1)
  }
}
