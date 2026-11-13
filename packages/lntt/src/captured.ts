// A short command run through Effect's ChildProcessSpawner to its end, `input` on its stdin when
// given, `env` added to the inherited environment when given: its stdout without the trailing newline, its stderr trimmed, its exit code. What lntt's own services over a CLI (Git,
// Gh) share; a command that cannot start is the spawner's PlatformError.

import * as Effect from 'effect/Effect'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

export interface Captured {
  readonly out: string
  readonly err: string
  readonly code: number
}

export const captured = (
  spawner: ChildProcessSpawner.ChildProcessSpawner['Service'],
  command: string,
  args: readonly string[],
  cwd?: string,
  input?: string,
  env?: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stdin: input === undefined ? 'ignore' : Stream.make(new TextEncoder().encode(input)),
          ...(cwd === undefined ? {} : { cwd }),
          ...(env === undefined ? {} : { env, extendEnv: true }),
        }),
      )
      const [out, err, code] = yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], {
        concurrency: 'unbounded',
      })
      return { out: out.trimEnd(), err: err.trim(), code: Number(code) } satisfies Captured
    }),
  )
