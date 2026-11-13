// The driver on Effect of the loaders' asks (src/ci/asks.ts): files through the FileSystem, the
// circleci CLI and the PATH through the spawner, the files changed through Git. What a loader or
// an ask throws is a CiFailed, reported by its message. The CircleCI configurations it processes
// stay in `dir`, a folder of the command's scope, for `circleci local execute`.

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { captured } from '../captured.ts'
import type { Ask, Asks } from './asks.ts'
import { CIRCLECI_MISSING, processArgs, processedOf, processFailure } from './circleci.ts'
import { changedAgainst } from './event.ts'

// What `lntt ci local` cannot go on from: a workflow that does not parse, a CircleCI configuration
// the CLI refuses, a CLI that is not installed.
export class CiFailed extends Data.TaggedError('CiFailed')<{ message: string }> {}

const failed = (error: unknown) =>
  error instanceof CiFailed ? error : new CiFailed({ message: error instanceof Error ? error.message : String(error) })

// What the asks are answered with besides the services: the Node version lntt runs on, the
// repository's root, where the circleci CLI runs (a version manager's shim resolves per folder), and
// the folder where the processed configurations go.
export interface HostInput {
  node: string
  root: string
  dir: string
}

// Whether `command` is on the PATH.
export const onPath = (command: string) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.exitCode(ChildProcess.make('sh', ['-c', 'command -v "$0"', command], { stdin: 'ignore' })),
  ).pipe(
    Effect.map((code) => code === 0),
    Effect.orElseSucceed(() => false),
  )

const expand = Effect.fnUntraced(function* (
  ask: Extract<Ask, { kind: 'process' }>,
  input: HostInput,
  count: { n: number },
) {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const n = ++count.n
  const source = `${input.dir}/source-${n}.yml`
  yield* fs.writeFileString(source, ask.text)
  const { out, err, code } = yield* captured(spawner, 'circleci', processArgs(source, ask.parameters), input.root).pipe(
    Effect.mapError((error) =>
      error.reason._tag === 'NotFound' ? new CiFailed({ message: CIRCLECI_MISSING }) : failed(error),
    ),
  )
  if (code !== 0) return yield* Effect.fail(failed(processFailure(ask.path, err || out)))
  const file = `${input.dir}/processed-${n}.yml`
  yield* fs.writeFileString(file, `${out}\n`)
  return yield* Effect.try({ try: () => processedOf(out, file), catch: failed })
})

const answer = (ask: Ask, input: HostInput, count: { n: number }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    switch (ask.kind) {
      case 'read':
        return yield* fs.readFileString(ask.path).pipe(Effect.orElseSucceed(() => null))
      case 'list':
        return yield* fs.readDirectory(ask.dir).pipe(Effect.orElseSucceed(() => null))
      case 'onPath':
        return yield* onPath(ask.command)
      case 'node':
        return input.node
      case 'changed':
        return yield* changedAgainst(ask.branch)
      case 'process':
        return yield* expand(ask, input, count)
      case 'await':
        return yield* Effect.tryPromise({ try: ask.promise, catch: failed })
    }
  })

// Runs a loader to its end: each ask's failure is thrown into it, where it may catch it.
export const runAsks = <A>(steps: Asks<A>, input: HostInput) =>
  Effect.gen(function* () {
    const count = { n: 0 }
    const advance = (move: () => IteratorResult<Ask, A>) => Effect.try({ try: move, catch: failed })
    let next = yield* advance(() => steps.next())
    while (!next.done) {
      const result = yield* Effect.result(answer(next.value, input, count))
      next =
        result._tag === 'Failure'
          ? yield* advance(() => steps.throw(result.failure))
          : yield* advance(() => steps.next(result.success))
    }
    return next.value
  })
