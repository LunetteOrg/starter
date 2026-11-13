// The reporter of a round or a reply: one stderr line per start and end of an agent, and every 30
// seconds the ones still running, for a person at the terminal; the same as JSON events in the
// progress file. A watcher that should wake only when it matters (the review skill's) filters
// `failed`, `error:`, `limit:` and `round N done`: every other line is routine.
//
// It is a resource of the command's scope. `progress` and `phase` are synchronous (askAll's
// progress calls them under Effect.sync, as Orca's subagents need): they queue what to write,
// and one fiber writes it in order. `flush` waits for
// what is queued; the scope's release flushes and stops the beat. Orca's subagents are a resource
// of the scope around it (src/review/orca.ts): they stop once all is written.

import * as Clock from 'effect/Clock'
import * as Console from 'effect/Console'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import type { Progress } from '../headless.ts'
import { formatTokens } from '../review.ts'
import { Pids } from '../worktree/lock.ts'
import type { Subagents } from './orca.ts'
import { ReviewStore } from './store.ts'
import { duration } from './view.ts'

// A beat every 15 seconds says lntt review is alive; stderr hears every second one.
export const BEAT = Duration.seconds(15)

function phaseOf(label: string): string {
  return label.startsWith('verify ') ? 'verify' : label.startsWith('reply ') ? 'reply' : 'reviewers'
}

export const reporting = Effect.fnUntraced(function* (orca: Subagents | null = null) {
  const store = yield* ReviewStore
  const { self } = yield* Pids
  const say = (line: string) => Console.error(`lntt review: ${line}`)
  const queue = yield* Queue.unbounded<Effect.Effect<void>>()
  const later = (effect: Effect.Effect<void>) => void Queue.offerUnsafe(queue, effect)
  const writer = yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(queue))))
  // Waits for what is queued: done once the writer reaches it, or with the writer's defect if
  // one of the writes died, which would leave nothing to reach it.
  const flush = Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    later(Deferred.succeed(done, undefined).pipe(Effect.asVoid))
    yield* Effect.raceFirst(Deferred.await(done), Fiber.join(writer))
  })

  // By question, not by label: two agents can carry the same label.
  const running = new Map<number, string>()
  const since = yield* Clock.currentTimeMillis
  let beats = 0
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(BEAT)
        yield* store.emit({ type: 'beat', running: running.size })
        if (++beats % 2 === 1 || running.size === 0) return
        const now = yield* Clock.currentTimeMillis
        yield* say(`running ${running.size} (${duration(now - since)}): ${[...running.values()].join(', ')}`)
      }),
    ),
  )
  // Released first, while the writer still runs.
  yield* Effect.addFinalizer(() => flush)

  const id = (phase: string, index: number) => `lntt-review-${self}-${phase}-${index}`
  return {
    flush,
    phase(labels: string[]) {
      if (labels.length > 0)
        later(store.emit({ type: 'phase', phase: phaseOf(labels[0] as string), total: labels.length }))
    },
    progress(event: Progress) {
      const phase = phaseOf(event.label)
      if (event.type === 'start') {
        running.set(event.index, event.label)
        orca?.start(id(phase, event.index), event.label)
        later(
          say(`start ${event.label}`).pipe(
            Effect.andThen(store.emit({ type: 'start', phase, label: event.label, optional: event.optional })),
          ),
        )
        return
      }
      running.delete(event.index)
      orca?.stop(id(phase, event.index), event.label, event.answer.ok ? 'answered' : event.answer.error)
      const took = duration(event.ms)
      if (!event.answer.ok) {
        // An optional agent's failure does not need anyone: not a `failed` line.
        const word = event.optional ? 'skipped' : 'failed'
        const error = event.answer.error
        later(
          say(`${word} ${event.label} in ${took}: ${error}`).pipe(
            Effect.andThen(store.emit({ type: 'end', phase, label: event.label, outcome: word, error, ms: event.ms })),
          ),
        )
        return
      }
      const tokens = event.answer.reply.tokens
      later(
        say(`done ${event.label} in ${took}${tokens === null ? '' : ` (${formatTokens(tokens)})`}`).pipe(
          Effect.andThen(store.emit({ type: 'end', phase, label: event.label, outcome: 'done', tokens, ms: event.ms })),
        ),
      )
    },
  }
})
