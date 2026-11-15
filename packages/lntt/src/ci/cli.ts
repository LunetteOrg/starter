// `lntt ci`: the project's CI on the local machine, and its candidate automation
// (usage: bin/lntt.ts).

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { cwd, env, stderr, stdout, version } from 'node:process'
import { parseArgs } from 'node:util'
import { Exit, exit } from '../exit.ts'
import type { LocalInput } from './local.ts'
import { lockDir, pollInterval } from './lock-rules.ts'
import { usageText } from './usage.ts'

function usage(message?: string): never {
  stderr.write(usageText(message))
  exit(2)
}

// A parse error is a usage error.
function guard<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    usage((error as Error).message)
  }
}

// What `lntt ci local` runs with, from its arguments and the environment; a usage error is its
// message.
export function localInput(
  args: string[],
  environment: Record<string, string | undefined>,
  home: string,
  node: string,
): LocalInput | { usage: string } {
  let values: {
    event: string
    base?: string | undefined
    job?: string[] | undefined
    list: boolean
    strict: boolean
    container: boolean
    'no-lock': boolean
  }
  try {
    values = parseArgs({
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
    }).values
  } catch (error) {
    return { usage: (error as Error).message }
  }
  const event = values.event
  if (event !== 'pull_request' && event !== 'push') return { usage: `--event is pull_request or push, not ${event}` }
  const poll = pollInterval(environment)
  return {
    event,
    ...(values.base !== undefined ? { base: values.base } : {}),
    ...(values.job ? { only: values.job } : {}),
    list: values.list,
    strict: values.strict,
    container: values.container,
    lock: !values['no-lock'],
    lockDir: lockDir(environment, home),
    ...(poll ? { poll } : {}),
    node,
  }
}

// `lntt ci local`: the arguments and the environment are read here, then the command runs on
// Effect (src/ci/local.ts), which this edge loads only for it.
async function local(args: string[]): Promise<never> {
  const input = localInput(args, env, homedir(), version)
  if ('usage' in input) usage(input.usage)
  const { runLocal } = await import('./local.ts')
  return runLocal(input)
}

// `lntt ci candidate`: the flags are checked here, then the automation runs on Effect
// (src/ci/candidate-command.ts), which this edge loads only for it.
async function candidateRun(args: string[]): Promise<never> {
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
  const { runCandidate } = await import('./candidate-command.ts')
  return runCandidate({
    ...(values.pr !== undefined ? { pr: values.pr } : {}),
    ...(values.event !== undefined ? { event: values.event } : {}),
    ...(values['head-ref'] !== undefined ? { headRef: values['head-ref'] } : {}),
    ...(values.labels !== undefined ? { labels: values.labels } : {}),
    merged: values.merged,
    follow: values.follow,
    guard: values.guard,
    dryRun: values['dry-run'],
    env,
    cwd: cwd(),
    log: (line) => stdout.write(`${line}\n`),
  })
}

// `lntt ci proved`: exit 0 only when the tree is proved: any other code, a crash included, is the
// full run.
async function provedRun(args: string[]): Promise<never> {
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
  const workflow = values.workflow ?? basename((env.GITHUB_WORKFLOW_REF ?? '').split('@')[0] ?? '')
  if (!workflow) usage('--workflow names the workflow file, outside Actions')
  const { runProved } = await import('./candidate-command.ts')
  return runProved({
    jobs: values.job,
    workflow,
    ...(values.step !== undefined ? { step: values.step } : {}),
    ...(values.sha !== undefined ? { sha: values.sha } : {}),
    ...(values.before !== undefined ? { before: values.before } : {}),
    ...(values.branch !== undefined ? { branch: values.branch } : {}),
    env,
    cwd: cwd(),
    log: (line) => stdout.write(`${line}\n`),
  })
}

// `lntt ci <command> [...]`: the arguments after `ci`.
export async function main([command, ...args]: string[]): Promise<never> {
  try {
    if (command === 'local') return await local(args)
    if (command === 'candidate') return await candidateRun(args)
    if (command === 'proved') return await provedRun(args)
    usage()
  } catch (error) {
    if (error instanceof Exit) throw error
    stderr.write(`lntt ci: ${(error as Error).message}\n`)
    exit(1)
  }
}
