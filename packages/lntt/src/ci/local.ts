// `lntt ci local` on Effect: the project's CI on this machine, from the provider's own
// configuration. The arguments are parsed at the edge (src/ci/cli.ts); here the event is read from
// git, the jobs from the workflows, the ci:local lock is taken as a resource of the command's scope,
// and the jobs run (src/ci/runner.ts). An interrupt starts nothing more, stops the running step's
// process group, gives the lock back and exits 130, with no report of a run cut short
// (docs/adr/effect-in-lntt.md#how-a-command-runs-is-interrupted-and-exits).

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { defaultBranch, projectBase, remoteRef } from '../base/base.ts'
import { CANDIDATE_PREFIX } from '../branch.ts'
import { ProjectConfig, projectConfigIn } from '../config/load.ts'
import { exit } from '../exit.ts'
import { ghAt } from '../gh/gh.ts'
import { Git, GitLive, gitAt } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import { circleciJobs } from './circleci.ts'
import { candidateConfigOf, ciConfigOf } from './config.ts'
import { containerArgs, eventPayload, neededTools } from './container.ts'
import { type EventName, type EventOptions, localEvent } from './event.ts'
import { githubJobs } from './github.ts'
import { onPath, runAsks } from './host.ts'
import { ciLock } from './lock.ts'
import { holdDeadline } from './lock-rules.ts'
import { CiProcessesLive, MachineLive } from './machine.ts'
import { formatList, formatReport } from './report.ts'
import { exitCode } from './run.ts'
import { runJobs } from './runner.ts'
import { usageText } from './usage.ts'

export interface LocalInput {
  event: EventName
  // --base as given.
  base?: string
  // --job, repeatable.
  only?: string[]
  list: boolean
  strict: boolean
  container: boolean
  // false with --no-lock.
  lock: boolean
  // Read at the edge: the lock's folder, how often a waiter looks at it, the Node version.
  lockDir: string
  poll?: number
  node: string
}

// A job --job names that the configuration does not have.
export class UsageError extends Data.TaggedError('UsageError')<{ message: string }> {}

const say = (line: string) => Console.error(line)

// The event's base and its options: --base as given; else, for a pull request, the base every
// lntt command resolves (src/base/base.ts), and for a push the default branch; both as the
// remote's copy.
const resolveBase = Effect.fnUntraced(function* (event: EventName, given: string | undefined) {
  const data = yield* Effect.flatMap(ProjectConfig, (config) => config.data)
  const candidate = candidateConfigOf(data)
  const options: EventOptions = { candidatePrefix: candidate?.prefix ?? CANDIDATE_PREFIX }
  if (given !== undefined) return [given, options] as const
  if (event === 'push') {
    const branch = yield* defaultBranch(candidate)
    return [branch, { ...options, baseRef: yield* remoteRef(branch) }] as const
  }
  // The report names the base and the ref; only a base that may be wrong is said here.
  const resolved = yield* projectBase(candidate, 'head')
  if (resolved.warning) yield* say(`lntt ci: ${resolved.warning}`)
  return [resolved.branch, { ...options, baseRef: resolved.ref }] as const
})

// The run, from the root of the working tree.
const run = Effect.fnUntraced(function* (input: LocalInput, root: string) {
  const fs = yield* FileSystem.FileSystem
  const config = ciConfigOf(yield* Effect.flatMap(ProjectConfig, (project) => project.data))
  const [base, options] = yield* resolveBase(input.event, input.base)
  const event = yield* localEvent(input.event, base, options)
  // The processed CircleCI configurations and act's event file, gone with the command.
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'lntt-ci-' })
  const host = { node: input.node, dir }
  const jobs = [
    ...(yield* runAsks(githubJobs(root, event, config), host)),
    ...(yield* runAsks(circleciJobs(root, event, config), host)),
  ]
  const only = input.only
  for (const key of only ?? []) {
    if (!jobs.some((job) => job.key === key)) {
      return yield* new UsageError({ message: `no job ${key} (${jobs.map((job) => job.key).join(', ')})` })
    }
  }
  if (input.list) {
    yield* Console.log(formatList(event, jobs))
    return 0
  }
  const git = yield* Git
  const dirty = yield* git.status
  if (dirty !== '') {
    yield* say(
      `lntt ci: the working tree has uncommitted changes; ci:local checks the commit about to be pushed:\n${dirty}`,
    )
    return 1
  }
  if (input.container) {
    const missing = yield* Effect.filter(neededTools(jobs, only), (command) => Effect.map(onPath(command), (on) => !on))
    if (missing.length > 0) {
      yield* say(`lntt ci: container mode needs ${missing.join(', ')} on the PATH`)
      return 1
    }
    yield* fs.writeFileString(`${dir}/event.json`, eventPayload(event))
  }
  const lock = input.lock
    ? yield* ciLock({
        dir: input.lockDir,
        scope: config.lock,
        worktree: root,
        log: say,
        ...(input.poll ? { interval: input.poll } : {}),
      })
    : null
  const results = yield* runJobs(jobs, {
    log: (line) => Console.log(line),
    root,
    ...(only ? { only } : {}),
    ...(input.container ? { container: containerArgs(config, () => `${dir}/event.json`) } : {}),
    timeoutMs: config.timeoutMinutes * 60_000,
    ...(lock ? { deadline: holdDeadline(lock.owner), onGroup: lock.setGroup } : {}),
  })
  yield* Console.log(formatReport(event, results, { strict: input.strict }))
  return exitCode(results, { strict: input.strict })
})

// The command from the working tree's root, with the services of that root: a usage error exits 2
// with the usage; any other expected failure is one line, exit 1.
export const command = (input: LocalInput, root: string) => reported(Effect.scoped(run(input, root)))

const reported = <R>(command: Effect.Effect<number, unknown, R>) =>
  command.pipe(
    Effect.catchIf(
      (error): error is UsageError => error instanceof UsageError,
      (error) => Effect.as(Console.error(usageText(error.message).trimEnd()), 2),
    ),
    Effect.catch((error) => Effect.as(say(`lntt ci: ${(error as { message?: string }).message ?? String(error)}`), 1)),
  )

// The command from wherever it is started: the services of the working tree's root.
export const local = (input: LocalInput) =>
  reported(
    Effect.gen(function* () {
      const root = yield* Effect.flatMap(Git, (git) => git.root)
      const atRoot = Layer.mergeAll(gitAt(root), ghAt(root), projectConfigIn(root))
      return yield* command(input, root).pipe(Effect.provide(atRoot))
    }),
  )

// The signals that stop a run. SIGINT and SIGTERM interrupt the command through the runner
// (src/run-command.ts); SIGHUP (the terminal closed) and SIGQUIT do here, since the step's process
// group, detached, does not get them. Each says once what it stops.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const

const interruptible = <A, E, R>(command: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(command)
    let first: string | null = null
    const handlers = SIGNALS.map((signal) => {
      const handler = () => {
        if (first !== null) return
        first = signal
        process.stderr.write(`lntt ci: interrupted (${signal}): stopping the running step\n`)
        if (signal === 'SIGHUP' || signal === 'SIGQUIT') Effect.runFork(Fiber.interrupt(fiber))
      }
      process.on(signal, handler)
      return [signal, handler] as const
    })
    return yield* Fiber.join(fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const [signal, handler] of handlers) process.off(signal, handler)
        }),
      ),
    )
  })

// The services on the machine.
const Live = Layer.mergeAll(GitLive, MachineLive, CiProcessesLive).pipe(
  Layer.provideMerge(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, NodePath.layer)),
)

// Runs `lntt ci local` as the process's main program (src/run-command.ts): its exit code.
export function runLocal(input: LocalInput): Promise<never> {
  return runCommand(interruptible(local(input)).pipe(Effect.map(exit), Effect.provide(Live)))
}
