// The agents of lntt review: each one a child process in a process group of its own, released
// with its scope however its run ends (an answer, a failure, its timeout, an interrupt of the
// command): SIGTERM to the group, STOP_GRACE for it to go, then SIGKILL to the group. Effect's
// spawner does the signalling (killSignal, forceKillAfter); this module says what an agent is
// started with and what its ending means (docs/adr/effect-in-lntt.md).

import * as NodeChildProcessSpawner from '@effect/platform-node-shared/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import { type Invocation, type Spawn, timerMs } from '../headless.ts'
import { agentEnv } from './agent-env.ts'

// How long an agent has between SIGTERM and SIGKILL.
export const STOP_GRACE = Duration.seconds(5)

// An agent that exited non-zero: its code and the last lines it wrote.
export class AgentFailed extends Data.TaggedError('AgentFailed')<{ command: string; code: number; output: string }> {
  get message() {
    return `${this.command} exited ${this.code}: ${this.output}`
  }
}

// An agent still running when its minutes were over: it was released first.
export class AgentTimedOut extends Data.TaggedError('AgentTimedOut')<{ minutes: number }> {
  get message() {
    return `timed out after ${this.minutes} minutes`
  }
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// One agent: the prompt on stdin, its stdout as the answer. The environment is the one given,
// without the host's hooks, and nothing else is inherited.
export const runAgent = (
  invocation: Invocation,
  options: { timeoutMinutes: number; env: Record<string, string | undefined> },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const agent = yield* ChildProcess.make(invocation.command, invocation.args, {
        env: agentEnv(options.env, invocation.env),
        extendEnv: false,
        stdin: Stream.make(new TextEncoder().encode(invocation.stdin)),
        killSignal: 'SIGTERM',
        forceKillAfter: STOP_GRACE,
      })
      const [out, err, code] = yield* Effect.all([text(agent.stdout), text(agent.stderr), agent.exitCode], {
        concurrency: 'unbounded',
      })
      if (code !== 0) {
        const output = (err.trim() || out.trim()).split('\n').slice(-3).join(' ')
        return yield* new AgentFailed({ command: invocation.command, code, output })
      }
      return out
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timerMs(options.timeoutMinutes * 60_000)),
      orElse: () => Effect.fail(new AgentTimedOut({ minutes: options.timeoutMinutes })),
    }),
  )

// The agents on Node: Effect's spawner, which resolves a working directory through the file
// system and the path services.
export const AgentsLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

// The bridge for the code still on Promises (askAll and the round): a Spawn whose agents run
// as fibers of the command's scope. An abort of the Spawn's signal interrupts its agent and
// rejects with the abort's reason once the agent is released; an interrupt of the command
// interrupts every agent still running and ends once they are all released.
export const withAgents = <A, E, R>(
  use: (tools: { spawner: (timeoutMinutes: number) => Spawn }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const run = yield* FiberSet.makeRuntimePromise<ChildProcessSpawner.ChildProcessSpawner>()
      const spawner =
        (timeoutMinutes: number): Spawn =>
        (invocation, signal) =>
          run(runAgent(invocation, { timeoutMinutes, env: process.env }), { signal }).catch((error: unknown) => {
            throw signal?.aborted ? new Error(String(signal.reason)) : error
          })
      return yield* use({ spawner })
    }),
  )
