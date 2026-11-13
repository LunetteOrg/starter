// The synchronous forms of `lntt ci local`'s loaders and of the event, for the library
// (`@lntt/lntt/ci`, docs/adr/effect-in-lntt.md#the-bridge-while-modules-move): a thin shell over
// `node:` that answers the loaders' asks (src/ci/asks.ts) and loads no Effect. `lntt ci local`
// runs the same loaders on Effect (src/ci/host.ts). Transitional: the shell goes with #341.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultOf, highestCandidate, localRefs, repositoryOf } from '../base/names.ts'
import { localAction as localActionSteps } from './actions.ts'
import type { Ask, Asks } from './asks.ts'
import {
  CIRCLECI_MISSING,
  circleciJobs as circleciJobsSteps,
  type Processor,
  processArgs,
  processedOf,
  processFailure,
} from './circleci.ts'
import type { CiConfig } from './config.ts'
import { containerArgs, eventPayload, neededTools } from './container.ts'
import type { Event, EventName, EventOptions } from './event.ts'
import { githubJobs as githubJobsSteps } from './github.ts'
import type { Job, Local } from './plan.ts'

// --- the event ------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The branch origin/HEAD points at, else `main`.
export function defaultBranch(cwd: string): string {
  return defaultOf(git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'))
}

function changedSince(cwd: string, ref: string): string[] | null {
  const out = git(cwd, 'diff', '--name-only', `${ref}...HEAD`)
  return out === null ? null : out.split('\n').filter((line) => line !== '')
}

function localRef(cwd: string, branch: string): string | null {
  return localRefs(branch).find((ref) => git(cwd, 'rev-parse', '--verify', '-q', ref) !== null) ?? null
}

function candidateAt(cwd: string, prefix: string): string | null {
  const out = git(cwd, 'for-each-ref', '--points-at=HEAD', '--format=%(refname)', `refs/remotes/origin/${prefix}*`)
  return highestCandidate((out ?? '').split('\n').filter(Boolean), prefix)
}

// Files changed from the merge base with `branch` to HEAD; null without a local ref.
export function changedAgainst(cwd: string, branch: string): string[] | null {
  const ref = localRef(cwd, branch)
  return ref ? changedSince(cwd, ref) : null
}

// The event as src/ci/event.ts reads it on Effect.
export function localEvent(cwd: string, name: EventName, base: string, options: EventOptions = {}): Event {
  let head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD'
  if (head === 'HEAD' && options.candidatePrefix) head = candidateAt(cwd, options.candidatePrefix) ?? head
  const sha = git(cwd, 'rev-parse', 'HEAD') ?? ''
  const baseRef = options.baseRef ?? localRef(cwd, base)
  let changed = baseRef ? changedSince(cwd, baseRef) : null
  if (name === 'push' && changed?.length === 0) changed = changedSince(cwd, 'HEAD^')
  return {
    name,
    base,
    head,
    sha,
    baseRef,
    changed,
    repository: repositoryOf(git(cwd, 'remote', 'get-url', 'origin')),
    defaultBranch: defaultBranch(cwd),
  }
}

// --- the loaders ----------------------------------------------------------------

export function onPath(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v "$0"`, command], { stdio: 'ignore' }).status === 0
}

// Whether the CLI runs from `cwd`, the folder `cliProcessor` runs it in (a version
// manager's shim resolves per folder), and why not. Null when it does.
export function circleciUnavailable(cwd: string): string | null {
  try {
    execFileSync('circleci', ['--skip-update-check', 'version'], { cwd, stdio: 'ignore' })
    return null
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return CIRCLECI_MISSING
    return `the circleci CLI does not run from ${cwd}`
  }
}

// `circleci config process` from `root`, its sources and results in a temporary folder.
export function cliProcessor(root: string): Processor {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-ci-circleci-'))
  let n = 0
  return (path, text, parameters) => {
    const source = join(dir, `source-${++n}.yml`)
    writeFileSync(source, text)
    let out: string
    try {
      out = execFileSync('circleci', processArgs(source, parameters), {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const e = error as { code?: string; stderr?: string }
      if (e.code === 'ENOENT') throw new Error(CIRCLECI_MISSING)
      throw processFailure(path, e.stderr ?? String(error))
    }
    const file = join(dir, `processed-${n}.yml`)
    writeFileSync(file, out)
    return processedOf(out, file)
  }
}

interface Answers {
  root: string
  processor?: Processor
}

function answer(ask: Ask, answers: Answers): unknown {
  switch (ask.kind) {
    case 'read':
      try {
        return readFileSync(ask.path, 'utf8')
      } catch {
        return null
      }
    case 'list':
      try {
        return readdirSync(ask.dir)
      } catch {
        return null
      }
    case 'onPath':
      return onPath(ask.command)
    case 'node':
      return process.version
    case 'changed':
      return changedAgainst(answers.root, ask.branch)
    case 'process':
      answers.processor ??= cliProcessor(answers.root)
      return answers.processor(ask.path, ask.text, ask.parameters)
    case 'await':
      throw new Error('a synchronous loader cannot await')
  }
}

// Runs a loader to its end, each ask answered on the machine; what an ask throws is thrown into
// the loader.
function drive<A>(steps: Asks<A>, answers: Answers): A {
  let next = steps.next()
  while (!next.done) {
    let result: unknown
    try {
      result = answer(next.value, answers)
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(result)
  }
  return next.value
}

// The same, awaiting the promises a loader asks for.
async function driveAsync<A>(steps: Asks<A>, answers: Answers): Promise<A> {
  let next = steps.next()
  while (!next.done) {
    const ask = next.value
    let result: unknown
    try {
      result = ask.kind === 'await' ? await ask.promise() : answer(ask, answers)
    } catch (error) {
      next = steps.throw(error)
      continue
    }
    next = steps.next(result)
  }
  return next.value
}

export function localAction(uses: string, inputs: Record<string, string>, root: string, config: CiConfig): Local {
  return drive(localActionSteps(uses, inputs, root, config), { root })
}

export function githubJobs(root: string, event: Event, config: CiConfig): Promise<Job[]> {
  return driveAsync(githubJobsSteps(root, event, config), { root })
}

export function circleciJobs(root: string, event: Event, config: CiConfig, processor?: Processor): Job[] {
  return drive(circleciJobsSteps(root, event, config), { root, ...(processor ? { processor } : {}) })
}

// --- container mode -------------------------------------------------------------

export function containerCommand(event: Event, config: CiConfig): (job: Job) => string[] | null {
  return containerArgs(config, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lntt-ci-act-')), 'event.json')
    writeFileSync(file, eventPayload(event))
    return file
  })
}

// The executables container mode needs for the jobs it would run, that are not on the PATH.
export function missingTools(jobs: Job[], only?: string[], exists: (command: string) => boolean = onPath): string[] {
  return neededTools(jobs, only).filter((command) => !exists(command))
}
