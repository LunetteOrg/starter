// The agents asked at once, on Effect: the reviewers and verifiers of a round, the reviewers
// a reply resumes, and whatever calls the library's askAll (docs/adr/effect-in-lntt.md).
//
// An agent is reached through the Agents service: on the machine a process (AgentsLive in
// src/review/agents.ts), in a spec an answer in memory, from the library a Spawn its caller
// gives. askAll is the logic over it: a slot per provider, each answer in its question's
// place, the optional agents stopped a grace after the others answered, every agent stopped
// when the caller says so (the round's deadline). An agent stopped or interrupted is released
// before askAll goes on: its fiber is interrupted, and an interrupt waits for its finalizers.
//
// This module loads no Node service: headless.ts imports it only when askAll is called.

import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import * as Semaphore from 'effect/Semaphore'
import {
  type HeadlessAgent as Agent,
  type Answer,
  headlessInvocation,
  type Invocation,
  type Progress,
  type AskOptions as PromiseOptions,
  parseReply,
  providerOf,
  type Question,
  type Spawn,
  timerMs,
} from '../headless.ts'
import { agentLabel } from '../review.ts'

// An agent that exited non-zero: its code and the last lines it wrote.
export class AgentFailed extends Data.TaggedError('AgentFailed')<{ command: string; code: number; output: string }> {
  get message() {
    return `${this.command} exited ${this.code}: ${this.output}`
  }
}

// A Spawn of the library's caller that rejected: its message is the answer's error.
export class SpawnRejected extends Data.TaggedError('SpawnRejected')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

// What headlessInvocation refused for the agent, or parseReply for its reply.
export class AnswerUnread extends Data.TaggedError('AnswerUnread')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

// What kept an agent from answering: the process's own failure, a process that could not
// start, a Spawn of the library's caller that rejected.
export type AgentError = AgentFailed | PlatformError | SpawnRejected

// An agent still running when its minutes were over: it was released first.
export class AgentTimedOut extends Data.TaggedError('AgentTimedOut')<{ minutes: number }> {
  get message() {
    return `timed out after ${this.minutes} minutes`
  }
}

export class Agents extends Context.Service<
  Agents,
  {
    // One agent, the prompt on stdin: its stdout, the answer. Interrupted, it is released.
    readonly run: (invocation: Invocation) => Effect.Effect<string, AgentError>
    // What keeps each agent from starting, a line each: a CLI that is not installed, or one
    // that cannot be made read-only.
    readonly problems: (agents: Agent[]) => Effect.Effect<string[]>
  }
>()('@lntt/lntt/review/asking/Agents') {
  // The agents of the library's caller: its Spawn, which an interrupt aborts through the
  // signal. Whether a CLI is there is the Spawn's to say: the problems are what cannot be
  // made read-only.
  static fromSpawn(spawn: Spawn) {
    return Layer.succeed(Agents)(
      Agents.of({
        run: (invocation) =>
          Effect.tryPromise({
            try: (signal) => spawn(invocation, signal),
            catch: (cause) => new SpawnRejected({ cause }),
          }),
        problems: (agents) => Effect.sync(() => agents.flatMap((agent) => unmakeable(agent))),
      }),
    )
  }
}

// What headlessInvocation refuses for an agent: none, or its line.
export function unmakeable(agent: Agent): string[] {
  try {
    headlessInvocation(agent, '')
    return []
  } catch (error) {
    return [`${agentLabel(agent)}: ${(error as Error).message}`]
  }
}

export interface AskOptions {
  // How many agents of one provider run at once; the rest wait their turn.
  readonly perProvider?: number
  // How long optional agents may go on once every required agent has answered; then they
  // are stopped, and those still waiting never start. Without it, they are awaited.
  readonly optionalGraceMs?: number
  // How long each agent may run; then it is released and its answer is the timeout.
  readonly timeoutMinutes?: number
  // Done with a reason when every agent must stop, required ones too: those running are
  // released, those waiting never start, and each answer is the reason. A Deferred, so that
  // one already done is seen before any agent starts.
  readonly stop?: Deferred.Deferred<string>
  // Each start, when the agent starts, and each end.
  readonly progress?: (event: Progress) => Effect.Effect<void>
}

// One agent's answer: a failure in its place, never a failure of askAll.
const answerOf = (q: Question, timeoutMinutes: number | undefined) =>
  Effect.gen(function* () {
    const agents = yield* Agents
    const invocation = yield* Effect.try({
      try: () => headlessInvocation(q.agent, q.prompt, q.session),
      catch: (cause) => new AnswerUnread({ cause }),
    })
    const run = agents.run(invocation)
    const stdout = yield* timeoutMinutes === undefined
      ? run
      : run.pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timerMs(timeoutMinutes * 60_000)),
            orElse: () => Effect.fail(new AgentTimedOut({ minutes: timeoutMinutes })),
          }),
        )
    const reply = yield* Effect.try({
      try: () => parseReply(q.agent.kind, stdout),
      catch: (cause) => new AnswerUnread({ cause }),
    })
    return { ok: true, reply } as Answer
  }).pipe(Effect.catch((error) => Effect.succeed<Answer>({ ok: false, error: error.message })))

// Every question runs as soon as its provider has a free slot; each answer stays in its
// question's place.
export const askAll = Effect.fnUntraced(function* (questions: Question[], options: AskOptions = {}) {
  const progress = options.progress ?? (() => Effect.void)
  const limit = options.perProvider ?? Number.POSITIVE_INFINITY
  // Optional agents queue apart: a slow one never holds a required agent's turn.
  const slotOf = (agent: Agent) => `${providerOf(agent)}${agent.optional ? ' (optional)' : ''}`
  const slots = new Map<string, Semaphore.Semaphore>()
  for (const q of questions) if (!slots.has(slotOf(q.agent))) slots.set(slotOf(q.agent), yield* Semaphore.make(limit))
  // Done with the reason the agents stop: every one, or the optional ones.
  const all = options.stop ?? (yield* Deferred.make<string>())
  const optionals = yield* Deferred.make<string>()
  const required = questions.filter((q) => !q.agent.optional).length
  let answered = 0
  const grace = options.optionalGraceMs

  const ask = (q: Question, index: number) =>
    Effect.gen(function* () {
      const label = q.label ?? q.agent.kind
      const optional = q.agent.optional === true
      const stops = optional ? Effect.raceFirst(Deferred.await(all), Deferred.await(optionals)) : Deferred.await(all)
      const stopped = () => Deferred.isDoneUnsafe(all) || (optional && Deferred.isDoneUnsafe(optionals))
      const answer = yield* (slots.get(slotOf(q.agent)) as Semaphore.Semaphore).withPermits(1)(
        Effect.gen(function* () {
          if (stopped()) {
            const reason = yield* stops
            const answer: Answer = { ok: false, error: reason }
            yield* progress({ type: 'end', index, label, optional, answer, ms: 0 })
            return answer
          }
          const started = yield* Clock.currentTimeMillis
          yield* progress({ type: 'start', index, label, optional })
          // The agent in a fiber of this scope: a stop interrupts it, and the interrupt waits
          // for its release.
          const running = yield* Effect.forkScoped(answerOf(q, options.timeoutMinutes))
          const first = yield* Effect.raceFirst(
            Fiber.join(running),
            Effect.map(stops, (reason) => ({ stopped: reason })),
          )
          let answer: Answer
          if ('stopped' in first) {
            yield* Fiber.interrupt(running)
            answer = { ok: false, error: first.stopped }
          } else answer = first
          const ms = (yield* Clock.currentTimeMillis) - started
          yield* progress({ type: 'end', index, label, optional, answer, ms })
          return answer
        }).pipe(Effect.scoped),
      )
      if (!optional && ++answered === required && grace !== undefined) {
        const reason = `stopped: the other agents answered ${Math.round(grace / 1000)}s before`
        yield* Effect.forkScoped(
          Effect.sleep(Duration.millis(timerMs(grace))).pipe(Effect.andThen(Deferred.succeed(optionals, reason))),
        )
      }
      return answer
    })

  return yield* Effect.forEach(questions, ask, { concurrency: 'unbounded' })
}, Effect.scoped)

// The library's askAll (src/headless.ts): its Spawn as the agents, its signal as the stop,
// its progress called as each event happens.
export function askWithSpawn(
  questions: Question[],
  spawn: Spawn,
  progress: (event: Progress) => void,
  options: PromiseOptions,
): Promise<Answer[]> {
  const signal = options.signal
  const stop = signal === undefined ? undefined : Deferred.makeUnsafe<string>()
  const abort = () => {
    if (stop && signal) Deferred.doneUnsafe(stop, Effect.succeed(String(signal.reason)))
  }
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return Effect.runPromise(
    askAll(questions, {
      ...(options.perProvider === undefined ? {} : { perProvider: options.perProvider }),
      ...(options.optionalGraceMs === undefined ? {} : { optionalGraceMs: options.optionalGraceMs }),
      ...(stop === undefined ? {} : { stop }),
      progress: (event) => Effect.sync(() => progress(event)),
    }).pipe(Effect.provide(Agents.fromSpawn(spawn))),
  ).finally(() => signal?.removeEventListener('abort', abort))
}
