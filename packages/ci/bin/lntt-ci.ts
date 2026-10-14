#!/usr/bin/env node
// lntt-ci — the project's CI, run locally from its own configuration.
//
//   lntt-ci local [--event pull_request|push] [--base <branch>] [--job <key>]...
//                 [--list] [--strict] [--container]
//
//   --event      what the cloud would see: a ready pull request into the base (default),
//                or a push to it
//   --base       the pull request's base, or the branch pushed to (default: origin/HEAD's
//                branch, else main)
//   --job        run only this job (`ci.yml/ci`, `circleci/test`); repeatable
//   --list       per job, what the cloud runs and what the local run does; runs nothing
//   --strict     fail when a step or job the cloud runs was not run locally
//   --container  run each job in the provider's local executor (act, circleci local
//                execute) instead of on the host
//
// The run starts only on a clean working tree: it checks the commit about to be
// pushed. Exit codes: 0 green, 1 red or a configuration error, 2 usage error.

import { execFileSync } from 'node:child_process'
import { argv, cwd, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import {
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

const USAGE =
  'usage: lntt-ci local [--event pull_request|push] [--base <branch>] [--job <key>]... [--list] [--strict] [--container]'

function usage(message?: string): never {
  if (message) stderr.write(`lntt-ci: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

let parsed: ReturnType<typeof parse>
function parse() {
  return parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      event: { type: 'string', default: 'pull_request' },
      base: { type: 'string' },
      job: { type: 'string', multiple: true },
      list: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      container: { type: 'boolean', default: false },
    },
  })
}
try {
  parsed = parse()
} catch (error) {
  usage((error as Error).message)
}
const { values, positionals } = parsed
if (positionals[0] !== 'local' || positionals.length > 1) usage()
if (values.event !== 'pull_request' && values.event !== 'push')
  usage(`--event is pull_request or push, not ${values.event}`)

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

try {
  const root = git('rev-parse', '--show-toplevel')
  process.chdir(root)
  const config = ciConfig(root)
  const event = localEvent(root, values.event, values.base ?? defaultBranch(root))
  const jobs = [...(await githubJobs(root, event, config)), ...circleciJobs(root, event, config)]
  for (const key of values.job ?? []) {
    if (!jobs.some((j) => j.key === key)) usage(`no job ${key} (${jobs.map((j) => j.key).join(', ')})`)
  }
  if (values.list) {
    stdout.write(`${formatList(event, jobs)}\n`)
    exit(0)
  }
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    stderr.write(
      `lntt-ci: the working tree has uncommitted changes; ci:local checks the commit about to be pushed:\n${dirty}\n`,
    )
    exit(1)
  }
  if (values.container) {
    const missing = missingTools(jobs, values.job)
    if (missing.length > 0) {
      stderr.write(`lntt-ci: container mode needs ${missing.join(', ')} on the PATH\n`)
      exit(1)
    }
  }
  const results = await runJobs(jobs, {
    log: (line) => stdout.write(`${line}\n`),
    ...(values.job ? { only: values.job } : {}),
    ...(values.container ? { container: containerCommand(event, config) } : {}),
  })
  stdout.write(`${formatReport(event, results, { strict: values.strict })}\n`)
  exit(exitCode(results, { strict: values.strict }))
} catch (error) {
  stderr.write(`lntt-ci: ${(error as Error).message}\n`)
  exit(1)
}
