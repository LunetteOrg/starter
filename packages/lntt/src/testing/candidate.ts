// The candidate automation's steps (src/ci/candidate-steps.ts) run for a spec: its steps on Effect over Gh,
// Board and Git layers that answer gh's and git's arguments from records, the way a test of the
// automation has always written GitHub (a read answered by the first key its command line holds,
// a write recorded). A step runs to its end synchronously; its failure is thrown with its message.
// Not published: tsconfig.build.json leaves src/testing/ out.

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { CandidateConfig } from '../ci/candidate.ts'
import * as Steps from '../ci/candidate-steps.ts'
import { Board, type Run as CandidateRun } from '../ci/candidate-steps.ts'
import { GhError, Gh as GhService } from '../gh/gh.ts'
import { followOperations, GitError, type GitResult, Git as GitService } from '../git/git.ts'
import { memoryFileSystem } from './file-system.ts'

// gh as a test writes it: its stdout for a command line, a write recorded.
export interface Gh {
  read: (args: string[]) => string
  write: (args: string[], input?: string) => string
}

// git as a test writes it: each command's outcome.
export interface Git {
  run: (args: string[]) => GitResult
  push: (args: string[]) => { status: number; stderr: string }
}

// A run with its clients: the repository's gh, the Projects token's, the clone.
export interface Run {
  gh: Gh
  board?: Gh
  git?: Git
  repo: string
  config: CandidateConfig
  log: (line: string) => void
}

const ghOver = (client: Gh) =>
  GhService.over((args, { input, write } = {}) =>
    Effect.try({
      try: () => (write ? client.write(args, input) : client.read(args)),
      catch: (error) => new GhError({ args, output: (error as Error).message }),
    }),
  )

// The follow's operations over a test's git (git.ts's own, over its `run`): a push goes to the
// client's `push`, without the arguments that turn the hooks off.
const gitOver = (client: Git) => {
  const run = (args: string[]) =>
    Effect.try({
      try: (): GitResult => {
        const at = args.indexOf('push')
        if (at >= 0 && args[at - 1] === 'core.hooksPath=/dev/null')
          return { stdout: '', ...client.push(args.slice(at + 1)) }
        return client.run(args)
      },
      catch: (error) => new GitError({ args, output: (error as Error).message }),
    })
  const done = (args: string[]) =>
    Effect.flatMap(run(args), (r) =>
      r.status === 0 ? Effect.void : Effect.fail(new GitError({ args, output: r.stderr || r.stdout })),
    )
  return GitService.memory({
    verify: (rev) =>
      Effect.map(run(['rev-parse', '--verify', '--quiet', rev]), (r) => (r.status === 0 ? r.stdout : null)),
    // The worktree's addition and removal, git.ts's own over `run`: a git that refuses is a GitError.
    addWorktree: (dir, path, { rev = 'HEAD', hooks = true } = {}) =>
      done([
        '-C',
        dir,
        ...(hooks ? [] : ['-c', 'core.hooksPath=/dev/null']),
        'worktree',
        'add',
        '--detach',
        '--quiet',
        path,
        rev,
      ]),
    removeWorktree: (dir, path) => done(['-C', dir, 'worktree', 'remove', '--force', path]),
    ...followOperations(run),
  })
}

// The layers of `run`: its gh, its board (none without one), its git (none without one), a file
// system in memory.
export function layersOf(
  run: Pick<Run, 'gh' | 'board' | 'git'>,
  files: Layer.Layer<FileSystem.FileSystem> = memoryFileSystem({ dirs: ['/tmp'] }).layer,
) {
  const board = run.board
    ? Layer.effect(Board)(Effect.map(GhService, (gh) => Board.of({ gh }))).pipe(Layer.provide(ghOver(run.board)))
    : Board.none
  return Layer.mergeAll(ghOver(run.gh), board, run.git ? gitOver(run.git) : GitService.memory({}), files)
}

// Runs a step to its end; its failure is thrown, as the step's message.
export function go<A>(
  step: Effect.Effect<A, unknown, GhService | Board | GitService | FileSystem.FileSystem>,
  run: Pick<Run, 'gh' | 'board' | 'git'>,
): A {
  const exit = Effect.runSyncExit(step.pipe(Effect.provide(layersOf(run))))
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

// Runs a step to its end on the machine's file system (the follow's worktree): its failure rejects.
export function goOn<A>(
  step: Effect.Effect<A, unknown, GhService | Board | GitService | FileSystem.FileSystem>,
  run: Pick<Run, 'gh' | 'board' | 'git'>,
  files: Layer.Layer<FileSystem.FileSystem>,
): Promise<A> {
  return Effect.runPromiseExit(step.pipe(Effect.provide(layersOf(run, files)))).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  })
}

export const runOf = (run: Run): CandidateRun => ({
  repo: run.repo,
  config: run.config,
  log: run.log,
  clone: Boolean(run.git),
})

// A step of the automation, taking a test's run.
const step =
  <Args extends unknown[], A>(
    of: (
      run: CandidateRun,
      ...args: Args
    ) => Effect.Effect<A, unknown, GhService | Board | GitService | FileSystem.FileSystem>,
  ) =>
  (run: Run, ...args: Args): A =>
    go(of(runOf(run), ...args), run)

export const retarget = step(Steps.retarget)
export const carryOver = step(Steps.carryOver)
export const setBoardStatus = step(Steps.setBoardStatus)
export const closeCandidateIssues = step(Steps.closeCandidateIssues)
export const announce = step(Steps.announce)
export const record = step(Steps.record)
export const sweep = step(Steps.sweep)
export const follow = step(Steps.follow)
export const readyAfterMerge = step(Steps.readyAfterMerge)
export const candidateMerged = step(Steps.candidateMerged)
export const handle = step(Steps.handle)
export const handlePush = step(Steps.handlePush)

// The same dry run as `lntt ci candidate --dry-run`'s: a write printed, never made.
export function dryGh(client: Gh, log: (line: string) => void): Gh {
  return {
    read: client.read,
    write: (args, input) => {
      log(`[dry-run] gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
      if (input !== undefined) log(`[dry-run] stdin:\n${input}`)
      return ''
    },
  }
}
