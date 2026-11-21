// The driver on Effect of the worktree adapters' steps (src/worktree/hosts.ts): a tool through the
// spawner, the setup's script through bash, a pause on the Clock, a worktree's orca.yaml through
// the FileSystem. What a step or an adapter throws is a ToolFailed, reported by its message.

import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import { captured } from '../captured.ts'
import { refusal, type Step, type Steps, setupOf } from './hosts.ts'

// A tool that refused or could not start, a setup that failed, what an adapter threw.
export class ToolFailed extends Data.TaggedError('ToolFailed')<{ message: string }> {}

const failure = (error: unknown) =>
  error instanceof ToolFailed
    ? error
    : new ToolFailed({ message: error instanceof Error ? error.message : String(error) })

// stdout, trimmed, is the result. When the call succeeds, what the tool said on stderr reaches the
// person after it; when it fails, the error carries the reason, once.
const run = Effect.fnUntraced(function* (command: string, args: string[], cwd: string | undefined) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const { out, err, code } = yield* captured(spawner, command, args, cwd).pipe(
    Effect.mapError((error) => new ToolFailed({ message: `${command} could not start: ${error.message}` })),
  )
  if (code !== 0) return yield* new ToolFailed({ message: refusal(command, args, out, err, code) })
  if (err) yield* Console.error(err)
  return out.trim()
})

// The setup's output goes to stderr, line by line: stdout carries one JSON line per worktree.
const shell = (script: string, cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const setup = yield* ChildProcess.make('bash', ['-e', '-c', script], { cwd, stdin: 'ignore', stderr: 'inherit' })
      const [, code] = yield* Effect.all(
        [
          Stream.runForEach(Stream.splitLines(Stream.decodeText(setup.stdout)), (line) => Console.error(line)),
          setup.exitCode,
        ],
        { concurrency: 'unbounded' },
      )
      if (code !== 0) return yield* new ToolFailed({ message: `the setup in ${cwd} failed (exit ${code})` })
    }),
  ).pipe(Effect.mapError(failure))

const setup = (worktree: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`${worktree}/orca.yaml`)).pipe(
    Effect.option,
    Effect.flatMap((text) =>
      text._tag === 'None' ? Effect.succeed(null) : Effect.try({ try: () => setupOf(text.value), catch: failure }),
    ),
  )

const perform = (
  step: Step,
): Effect.Effect<unknown, ToolFailed, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> => {
  if (step.kind === 'run') return run(step.command, step.args, step.cwd)
  if (step.kind === 'shell') return shell(step.script, step.cwd)
  if (step.kind === 'sleep') return Effect.sleep(Duration.millis(step.ms))
  return setup(step.worktree)
}

// Runs the steps: each step's failure is thrown into them, where an adapter may catch it.
export const runSteps = <A>(steps: Steps<A>) =>
  Effect.gen(function* () {
    const advance = (move: () => IteratorResult<Step, A>) => Effect.try({ try: move, catch: failure })
    let next = yield* advance(() => steps.next())
    while (!next.done) {
      const result = yield* Effect.result(perform(next.value))
      next =
        result._tag === 'Failure'
          ? yield* advance(() => steps.throw(result.failure))
          : yield* advance(() => steps.next(result.success))
    }
    return next.value
  })
