#!/usr/bin/env node
// lntt-ci — the project's CI on the local machine, and its candidate automation.
//
//   lntt-ci local [--event pull_request|push] [--base <branch>] [--job <key>]...
//                 [--list] [--strict] [--container]
//
//     --event      what the cloud would see: a ready pull request into the base
//                  (default), or a push to it
//     --base       the pull request's base, or the branch pushed to (default:
//                  origin/HEAD's branch, else main)
//     --job        run only this job (`ci.yml/ci`, `circleci/test`); repeatable
//     --list       per job, what the cloud runs and what the local run does; runs nothing
//     --strict     fail when a step or job the cloud runs was not run locally
//     --container  run each job in the provider's local executor (act, circleci local
//                  execute) instead of on the host
//
//   The run starts only on a clean working tree: it checks the commit about to be pushed.
//
//   lntt-ci candidate [--pr <n>] [--event opened|ready_for_review|closed]
//                     [--head-ref <ref>] [--labels a,b] [--merged] [--dry-run]
//
//     In Actions it reads the pull_request event (GITHUB_EVENT_PATH). From a terminal,
//     --pr reads the pull request with gh and does what the workflow would do on its
//     event; --head-ref, --labels and --merged override what was read, to try a case
//     without creating it; --dry-run prints every write instead of making it. Without
//     delivery.candidate in the configuration it does nothing.
//
// Exit codes: 0 green, 1 red or a configuration error, 2 usage error.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { argv, cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import {
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
  localEvent,
  missingTools,
  runJobs,
} from '../src/index.ts'

const USAGE = [
  'usage: lntt-ci local [--event pull_request|push] [--base <branch>] [--job <key>]... [--list] [--strict] [--container]',
  '       lntt-ci candidate [--pr <n>] [--event <action>] [--head-ref <ref>] [--labels a,b] [--merged] [--dry-run]',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt-ci: ${message}\n`)
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

async function local(): Promise<number> {
  const { values } = guard(() =>
    parseArgs({
      args: argv.slice(3),
      options: {
        event: { type: 'string', default: 'pull_request' },
        base: { type: 'string' },
        job: { type: 'string', multiple: true },
        list: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        container: { type: 'boolean', default: false },
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
      `lntt-ci: the working tree has uncommitted changes; ci:local checks the commit about to be pushed:\n${dirty}\n`,
    )
    return 1
  }
  const strict = values.strict
  if (values.container) {
    const missing = missingTools(jobs, only)
    if (missing.length > 0) {
      stderr.write(`lntt-ci: container mode needs ${missing.join(', ')} on the PATH\n`)
      return 1
    }
  }
  const results = await runJobs(jobs, {
    log: (line) => stdout.write(`${line}\n`),
    ...(only ? { only } : {}),
    ...(values.container ? { container: containerCommand(localEv, config) } : {}),
  })
  stdout.write(`${formatReport(localEv, results, { strict })}\n`)
  return exitCode(results, { strict })
}

function candidateRun(): number {
  const { values } = guard(() =>
    parseArgs({
      args: argv.slice(3),
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
  candidate.handle({ gh, repo, config, log }, action, pr)
  return 0
}

try {
  const command = argv[2]
  if (command === 'local') exit(await local())
  else if (command === 'candidate') exit(candidateRun())
  else usage()
} catch (error) {
  stderr.write(`lntt-ci: ${(error as Error).message}\n`)
  exit(1)
}
