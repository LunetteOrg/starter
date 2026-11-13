// `lntt ci candidate` and `lntt ci proved` on Effect, over the Gh, Board and Git services
// (src/ci/candidate.ts, src/ci/proved.ts). The arguments and the environment are read at the edge
// (src/ci/cli.ts); here they become the layers the automation runs on: gh with the repository's
// token, a second Gh with the Projects token for the board, git on the local clone authenticated
// through its environment in Actions, and in a dry run the layers that print the writes and the
// push instead of making them.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'
import { ProjectConfig, ProjectConfigLive } from '../config/load.ts'
import { exit } from '../exit.ts'
import { Gh, ghAt } from '../gh/gh.ts'
import { Git, gitAt } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import {
  Board,
  type CandidateConfig,
  gitAuthEnv,
  guardDecision,
  handle,
  handlePush,
  type PullRequest,
  pickBoard,
  prFromEvent,
  prFromGh,
  type Run,
} from './candidate.ts'
import { candidateConfigOf } from './config.ts'
import { proved as provedOf } from './proved.ts'
import { usageText } from './usage.ts'

type Env = Record<string, string | undefined>

// A usage error found once the configuration or the event is read: exit 2, with the usage.
export class UsageError extends Data.TaggedError('UsageError')<{ message: string }> {}

// The event GitHub wrote is no JSON object.
export class EventUnread extends Data.TaggedError('EventUnread')<{ message: string }> {}

// The event GitHub wrote: a JSON object, else an EventUnread naming the file.
const readEvent = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (error) => new EventUnread({ message: `${path}: ${(error as Error).message}` }),
      }),
    ),
    Effect.flatMap((event) =>
      Predicate.isObject(event) && !Array.isArray(event)
        ? // biome-ignore lint/suspicious/noExplicitAny: the event's fields are read where they are used
          Effect.succeed(event as Record<string, any>)
        : Effect.fail(new EventUnread({ message: `${path} holds no event object` })),
    ),
  )

// The repository: GITHUB_REPOSITORY in Actions, else the one gh works on.
const repositoryOf = (env: Env) =>
  env.GITHUB_REPOSITORY ? Effect.succeed(env.GITHUB_REPOSITORY) : Effect.flatMap(Gh, (gh) => gh.repository)

const pullRequestNumber = (pr: string) =>
  /^[1-9]\d*$/.test(pr)
    ? Effect.succeed(Number(pr))
    : Effect.fail(new UsageError({ message: `--pr takes a number, not ${pr}` }))

export interface CandidateInput {
  pr?: string
  event?: string
  headRef?: string
  labels?: string
  merged: boolean
  follow: boolean
  guard: boolean
  dryRun: boolean
  // The run's environment, read at the edge: the tokens, Actions' variables.
  env: Env
  cwd: string
  log: (line: string) => void
}

// `--guard`: the `candidate guard` check on the event's pull request, or on --pr's. It writes
// nothing and asks gh only for --pr; a failure is an error annotation and exit 1.
const guardRun = Effect.fnUntraced(function* (config: CandidateConfig, input: CandidateInput) {
  const { env, log } = input
  let pr: PullRequest
  if (input.pr !== undefined) {
    const number = yield* pullRequestNumber(input.pr)
    pr = yield* prFromGh(yield* repositoryOf(env), number)
  } else {
    if (!env.GITHUB_EVENT_PATH)
      return yield* new UsageError({ message: '--guard without --pr reads the pull request from GITHUB_EVENT_PATH' })
    const event = yield* readEvent(env.GITHUB_EVENT_PATH)
    if (!event.pull_request) return yield* new UsageError({ message: '--guard runs on a pull_request event' })
    pr = prFromEvent(event as Parameters<typeof prFromEvent>[0])
  }
  const decision = guardDecision(config, pr)
  if (decision.pass) {
    log(`candidate guard: #${pr.number} passes: ${decision.reason}.`)
    return 0
  }
  log(`::error title=Not on the candidate::${decision.reason}`)
  return 1
})

// The automation on the event, the pull request --pr names, or --follow.
export const candidate = Effect.fnUntraced(function* (input: CandidateInput) {
  const { env, log } = input
  const config = candidateConfigOf(yield* Effect.flatMap(ProjectConfig, (project) => project.data))
  if (!config) {
    log('::notice::no delivery.candidate in .agents/config: the candidate automation does nothing')
    return 0
  }
  if (input.guard) return yield* guardRun(config, input)
  const repo = yield* repositoryOf(env)
  // `--pr` from a terminal handles its pull request only: it gets no clone, so it does not follow.
  const run: Run = { repo, config, log, clone: input.pr === undefined }
  if (input.follow) {
    yield* handlePush(run)
    return 0
  }
  let action: string
  let pr: PullRequest
  if (input.pr !== undefined) {
    pr = yield* prFromGh(repo, yield* pullRequestNumber(input.pr))
    action = input.event ?? (pr.merged ? 'closed' : 'opened')
  } else {
    if (!env.GITHUB_EVENT_PATH)
      return yield* new UsageError({ message: 'without --pr or --follow, GITHUB_EVENT_PATH must name the event' })
    const event = yield* readEvent(env.GITHUB_EVENT_PATH)
    // A push to the base: the candidate follows it. Any other event has nothing to do.
    if (!event.pull_request) {
      if (event.ref !== `refs/heads/${config.base}`) {
        log(`candidate: event ${event.ref || env.GITHUB_EVENT_NAME || 'without a pull request'}, nothing to do.`)
        return 0
      }
      yield* handlePush(run)
      return 0
    }
    action = event.action
    pr = prFromEvent(event as Parameters<typeof prFromEvent>[0])
  }
  if (input.headRef !== undefined) pr.headRef = input.headRef
  if (input.labels !== undefined) pr.labels = input.labels.split(',').filter((l) => l !== '')
  if (input.merged) pr.merged = true
  yield* handle(run, action, pr)
  return 0
})

// The services of a run of the automation from `cwd`: gh, the board's gh (the Projects token in a
// workflow that has one, none in a workflow without it, the operator's own gh in a terminal), and
// git on the clone; a dry run prints the writes and the push through `log`.
export const candidateLayers = (input: Pick<CandidateInput, 'env' | 'cwd' | 'dryRun' | 'log'>) => {
  const dryRun = input.dryRun ? { dryRun: input.log } : {}
  const gh = ghAt(input.cwd, dryRun)
  const boardGh = pickBoard(input.env.PROJECTS_GH_TOKEN, Boolean(input.env.GITHUB_ACTIONS), gh, (token) =>
    ghAt(input.cwd, { token, ...dryRun }),
  )
  // Board holds the Gh its own layer gives, apart from the repository's.
  const boardLayer = boardGh
    ? Layer.effect(Board)(Effect.map(Gh, (client) => Board.of({ gh: client }))).pipe(Layer.provide(boardGh))
    : Board.none
  return Layer.mergeAll(gh, boardLayer, gitAt(input.cwd, { env: gitAuthEnv(input.env), ...dryRun }))
}

export interface ProvedCommandInput {
  jobs: string[]
  step?: string
  // The workflow file, from --workflow or GITHUB_WORKFLOW_REF.
  workflow: string
  sha?: string
  before?: string
  branch?: string
  env: Env
  cwd: string
  log: (line: string) => void
}

// The push event's previous tip, when the run has one: an unreadable event has none, and no
// previous tip is not proved.
const eventBefore = (env: Env) =>
  env.GITHUB_EVENT_PATH
    ? readEvent(env.GITHUB_EVENT_PATH).pipe(
        Effect.map((event) => (typeof event.before === 'string' ? (event.before as string) : '')),
        Effect.orElseSucceed(() => ''),
      )
    : Effect.succeed('')

// Exit 0 only when the tree is proved: any other code, a crash included, is the full run.
export const proved = Effect.fnUntraced(function* (input: ProvedCommandInput) {
  const { env, log } = input
  const repo = yield* repositoryOf(env)
  const sha =
    input.sha ??
    (env.GITHUB_SHA ||
      (yield* Effect.flatMap(Git, (git) => git.verify('HEAD')).pipe(
        Effect.flatMap((head) => (head === null ? Effect.fail(new Error('no HEAD')) : Effect.succeed(head))),
      )))
  const result = yield* provedOf({
    repo,
    sha,
    before: input.before ?? (yield* eventBefore(env)),
    branch: input.branch ?? env.GITHUB_REF_NAME ?? '',
    workflow: input.workflow,
    jobs: input.jobs,
    step: input.step,
  })
  const annotation = env.GITHUB_ACTIONS
    ? result.proved
      ? '::notice title=Tree already proved::'
      : '::notice title=Full run::'
    : ''
  log(`${annotation}${result.proved ? 'proved' : 'not proved'}: ${result.reason}`)
  return result.proved ? 0 : 1
})

// A usage error exits 2 with the usage; any other failure is one line, exit 1.
export const reported = <R>(command: Effect.Effect<number, unknown, R>) =>
  command.pipe(
    Effect.catchIf(
      (error): error is UsageError => error instanceof UsageError,
      (error) => Effect.as(Console.error(usageText(error.message).trimEnd()), 2),
    ),
    Effect.catch((error) =>
      Effect.as(Console.error(`lntt ci: ${(error as { message?: string }).message ?? String(error)}`), 1),
    ),
  )

// What every command here runs on: the spawner, the file system, the configuration.
const Machine = Layer.mergeAll(ProjectConfigLive).pipe(
  Layer.provideMerge(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, NodePath.layer)),
)

// Runs a command as the process's main program (src/run-command.ts): its exit code.
export const runCandidate = (input: CandidateInput): Promise<never> =>
  runCommand(
    reported(candidate(input)).pipe(
      Effect.map(exit),
      Effect.provide(candidateLayers(input).pipe(Layer.provideMerge(Machine))),
    ),
  )

export const runProved = (input: ProvedCommandInput): Promise<never> =>
  runCommand(
    reported(proved(input)).pipe(
      Effect.map(exit),
      Effect.provide(Layer.mergeAll(ghAt(input.cwd), gitAt(input.cwd)).pipe(Layer.provideMerge(Machine))),
    ),
  )
