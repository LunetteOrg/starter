// Orca shows the agents of a round of `lntt review` as subagents of the Claude Code session that
// started it, nested under it in its sidebar. Orca learns of a subagent from the SubagentStart and
// SubagentStop events Claude Code sends through Orca's hook script, with the session's pane
// variables; this adapter sends the same events for each reviewer and verifier. It follows an
// internal Orca protocol (see docs/adr/review-agents.md), so it does nothing when any piece is
// missing, and a failed send never fails the round.
//
// On Effect (docs/adr/effect-in-lntt.md): the subagents are a resource of the round's scope. Each
// event is the hook script run through the spawner, in a fiber of the scope's own; the reminder of
// the running ones a fiber that sleeps on the Clock; the scope's release stops those still running
// and waits briefly for the sends.

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import * as FileSystem from 'effect/FileSystem'
import { ChildProcess, type ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'

export type Env = Record<string, string | undefined>

// The environment lntt runs in, read at the edge (src/review/command.ts's runReview): the session's
// variables say whether Orca is there, and the hook script runs with them.
export const HostEnv = Context.Reference<Env>('@lntt/lntt/review/orca/HostEnv', { defaultValue: () => ({}) })

// The variables of a Claude Code session running in an Orca terminal.
const NEEDED = ['ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_PANE_KEY', 'CLAUDE_CODE_SESSION_ID']

// Where Orca's hook script would be for this environment, null when this is not a Claude Code
// session in Orca.
export function hookScriptPath(env: Env): string | null {
  if (NEEDED.some((name) => !env[name]) || !env.HOME) return null
  return `${env.HOME}/.orca/agent-hooks/claude-hook.sh`
}

export type SubagentEventName = 'SubagentStart' | 'SubagentStop'

// The payload Claude Code sends for a subagent, with the label as its type: Orca shows it.
export function subagentEvent(
  name: SubagentEventName,
  session: string,
  agentId: string,
  label: string,
  cwd: string,
  lastMessage?: string,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    session_id: session,
    transcript_path: '',
    cwd,
    hook_event_name: name,
    agent_id: agentId,
    agent_type: label,
  }
  if (name === 'SubagentStop') {
    Object.assign(event, {
      stop_hook_active: false,
      agent_transcript_path: '',
      last_assistant_message: lastMessage ?? '',
    })
  }
  return event
}

// What the reporter of a round calls, synchronously, as each agent starts and ends.
export interface Subagents {
  start(id: string, label: string): void
  stop(id: string, label: string, message: string): void
}

// Orca drops subagents when the parent's turn stops: a running agent's start is sent again every
// `every`, so it comes back within the interval.
export const EVERY = Duration.seconds(2)
// How long the release waits for the last events to reach Orca.
export const LAST_SENDS = Duration.seconds(2)

// The subagents of this round in Orca, or null when this is not a Claude Code session in Orca or
// its hook script is not there. Each event goes through Orca's own script, with the session's
// environment and nothing else.
export const orcaSubagents = Effect.fnUntraced(function* (cwd: string, every: Duration.Input = EVERY) {
  const env = yield* HostEnv
  const script = hookScriptPath(env)
  if (script === null) return null
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))) return null
  const session = env.CLAUDE_CODE_SESSION_ID as string
  const sends = yield* FiberSet.make()
  const run = yield* FiberSet.runtime(sends)<ChildProcessSpawner.ChildProcessSpawner>()
  const send = (event: Record<string, unknown>) =>
    Effect.scoped(
      Effect.flatMap(
        ChildProcess.make('sh', [script], {
          env,
          extendEnv: false,
          stdin: Stream.make(new TextEncoder().encode(JSON.stringify(event))),
          stdout: 'ignore',
          stderr: 'ignore',
        }),
        (hook) => hook.exitCode,
      ),
    ).pipe(Effect.ignore)
  const later = (event: Record<string, unknown>) => void run(send(event))
  const running = new Map<string, string>()
  // Released after the reminder below stops: the ones still running stop, and the sends get a
  // moment to reach Orca before the scope interrupts them.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const [id, label] of running) later(subagentEvent('SubagentStop', session, id, label, cwd, 'stopped'))
      running.clear()
      yield* FiberSet.awaitEmpty(sends).pipe(Effect.timeout(LAST_SENDS), Effect.ignore)
    }),
  )
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(every).pipe(
        Effect.andThen(
          Effect.sync(() => {
            for (const [id, label] of running) later(subagentEvent('SubagentStart', session, id, label, cwd))
          }),
        ),
      ),
    ),
  )
  return {
    start(id, label) {
      running.set(id, label)
      later(subagentEvent('SubagentStart', session, id, label, cwd))
    },
    stop(id, label, message) {
      running.delete(id)
      later(subagentEvent('SubagentStop', session, id, label, cwd, message))
    },
  } satisfies Subagents
})
