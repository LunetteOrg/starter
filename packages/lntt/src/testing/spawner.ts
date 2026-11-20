// Effect's ChildProcessSpawner in memory, for the specs of commands that run short processes: each
// command answered by `answer` from its name and arguments, and what was asked recorded, with
// whether it was started detached. Not published: tsconfig.build.json leaves src/testing/ out.

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'

const encode = (text: string) => new TextEncoder().encode(text)

export type Said = { out?: string; err?: string; code?: number } | 'missing'

export interface Asked {
  command: string
  args: string[]
  detached: boolean
}

export function memorySpawner(answer: (command: string, args: string[]) => Said) {
  const asked: Asked[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      asked.push({ command: command.command, args, detached: command.options.detached === true })
      const said = answer(command.command, args)
      if (said === 'missing')
        return yield* PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
          pathOrDescriptor: command.command,
        })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(said.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(said.out ?? '')),
        stderr: Stream.make(encode(said.err ?? '')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  return { asked, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)) }
}

// `sh -c 'command -v "$0"' <command>`, as onPath asks it (src/captured.ts): found when on `path`.
export const pathAsk = (command: string, args: string[], path: string[]): Said | null =>
  command === 'sh' && args[1] === 'command -v "$0"' ? { code: path.includes(args[2] as string) ? 0 : 1 } : null
