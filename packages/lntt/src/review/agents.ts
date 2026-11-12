// The agents of lntt review on the machine: each one a child process in a process group of its
// own, released with its scope however its run ends (an answer, a failure, its timeout, an
// interrupt of the command): SIGTERM to the group, STOP_GRACE for it to go, then SIGKILL to the
// group. Effect's spawner does the signalling (killSignal, forceKillAfter); this module says what
// an agent is started with and what its ending means, and gives the Agents service of
// src/review/asking.ts over the spawner (docs/adr/effect-in-lntt.md).

import * as NodeChildProcessSpawner from '@effect/platform-node-shared/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import type { HeadlessAgent as Agent, Invocation } from '../headless.ts'
import { agentLabel } from '../review.ts'
import { agentEnv } from './agent-env.ts'
import { AgentFailed, Agents, unmakeable } from './asking.ts'

export { AgentFailed }

// How long an agent has between SIGTERM and SIGKILL.
export const STOP_GRACE = Duration.seconds(5)

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// One agent: the prompt on stdin, its stdout as the answer. The environment is the one given,
// without the host's hooks, and nothing else is inherited.
export const runAgent = (invocation: Invocation, options: { env: Record<string, string | undefined> }) =>
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
  )

// The agents through the spawner, with lntt's environment: what a spec provides with an
// in-memory spawner. A CLI is there when the shell finds it on the PATH.
export const AgentsProcesses = Layer.effect(Agents)(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Only a kind headlessInvocation takes (claude, opencode) reaches the shell.
    const onPath = (command: string) =>
      spawner.exitCode(ChildProcess.make('sh', ['-c', `command -v "${command}"`], { stdin: 'ignore' })).pipe(
        Effect.map((code) => code === 0),
        Effect.catch(() => Effect.succeed(false)),
      )
    const problemsOf = (agent: Agent) => {
      const refused = unmakeable(agent)
      if (refused.length > 0) return Effect.succeed(refused)
      return Effect.map(onPath(agent.kind), (there) =>
        there ? [] : [`${agentLabel(agent)}: ${agent.kind} is not on the PATH`],
      )
    }
    return Agents.of({
      run: (invocation) =>
        Effect.provideService(
          runAgent(invocation, { env: process.env }),
          ChildProcessSpawner.ChildProcessSpawner,
          spawner,
        ),
      problems: (agents) => Effect.map(Effect.forEach(agents, problemsOf), (lines) => lines.flat()),
    })
  }),
)

// Effect's spawner on Node, which resolves a working directory through the file system and the
// path services.
export const SpawnerLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

// The agents on Node, and the spawner they run on, which the command uses too (caffeinate).
export const AgentsLive = AgentsProcesses.pipe(Layer.provideMerge(SpawnerLive))
