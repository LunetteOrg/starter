import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import type { HeadlessAgent, Progress, Question } from '../headless.ts'
import { Agents, askAll } from './asking.ts'

// Agents in memory: each answers its prompt after the minutes `after` gives it on the Clock,
// with `reply` as its stdout. `ran` names the prompts whose agent ran, `released` those
// released before they answered.
function memoryAgents(after: Record<string, number> = {}, reply = (prompt: string) => ok(prompt)) {
  const ran: string[] = []
  const released: string[] = []
  const layer = Layer.succeed(Agents)(
    Agents.of({
      run: (invocation) =>
        Effect.gen(function* () {
          ran.push(invocation.stdin)
          yield* Effect.sleep(Duration.minutes(after[invocation.stdin] ?? 0))
          return reply(invocation.stdin)
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => released.push(invocation.stdin)))),
      problems: () => Effect.succeed([]),
    }),
  )
  return { ran, released, layer }
}

const ok = (text: string) => JSON.stringify({ result: `re ${text}`, session_id: 's', is_error: false })
const claude: HeadlessAgent = { kind: 'claude' }
const optional: HeadlessAgent = { kind: 'claude', optional: true }
const q = (prompt: string, agent = claude): Question => ({ agent, prompt, label: prompt })

const recorded = () => {
  const events: string[] = []
  const progress = (event: Progress) =>
    Effect.sync(() => {
      events.push(`${event.type} ${event.label}${event.type === 'end' ? ` ${event.ms}` : ''}`)
    })
  return { events, progress }
}

describe('askAll', () => {
  it.effect('a stop already done starts no agent: each answer is its reason, with no start', () => {
    const agents = memoryAgents()
    return Effect.gen(function* () {
      const stop = yield* Deferred.make<string>()
      yield* Deferred.succeed(stop, 'the round took longer than 60 minutes')
      const { events, progress } = recorded()
      const answers = yield* askAll([q('A'), q('B')], { stop, progress })
      assert.deepStrictEqual(answers, [
        { ok: false, error: 'the round took longer than 60 minutes' },
        { ok: false, error: 'the round took longer than 60 minutes' },
      ])
      assert.deepStrictEqual(agents.ran, [])
      assert.deepStrictEqual(events, ['end A 0', 'end B 0'])
    }).pipe(Effect.provide(agents.layer))
  })

  it.effect('a stop releases the running agent, and the one waiting for its slot never starts', () => {
    const agents = memoryAgents({ A: 30, B: 30 })
    return Effect.gen(function* () {
      const stop = yield* Deferred.make<string>()
      const { events, progress } = recorded()
      const fiber = yield* Effect.forkChild(askAll([q('A'), q('B')], { stop, perProvider: 1, progress }))
      yield* TestClock.adjust(Duration.minutes(10))
      yield* Deferred.succeed(stop, 'stopped')
      const answers = yield* Fiber.join(fiber)
      assert.deepStrictEqual(answers, [
        { ok: false, error: 'stopped' },
        { ok: false, error: 'stopped' },
      ])
      assert.deepStrictEqual(agents.ran, ['A'])
      assert.deepStrictEqual(agents.released, ['A'])
      assert.deepStrictEqual(events, ['start A', `end A ${10 * 60_000}`, 'end B 0'])
    }).pipe(Effect.provide(agents.layer))
  })

  it.effect('the grace starts when the last required agent answers, not the first', () => {
    const agents = memoryAgents({ fast: 1, slow: 10, extra: 60 })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        askAll([q('fast'), q('slow'), q('extra', optional)], { optionalGraceMs: 2 * 60_000 }),
      )
      // The first required answered 2 minutes ago: the optional one still runs.
      yield* TestClock.adjust(Duration.minutes(3))
      assert.deepStrictEqual(agents.released, [])
      // The last required answers at 10, the grace ends at 12.
      yield* TestClock.adjust(Duration.minutes(8.5))
      assert.deepStrictEqual(agents.released, [])
      yield* TestClock.adjust(Duration.minutes(0.5))
      const answers = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        answers.map((a) => (a.ok ? a.reply.text : a.error)),
        ['re fast', 're slow', 'stopped: the other agents answered 120s before'],
      )
      assert.deepStrictEqual(agents.released, ['extra'])
    }).pipe(Effect.provide(agents.layer))
  })

  it.effect('a reply that cannot be read, or an agent that cannot be made read-only, is a failure in its place', () => {
    const agents = memoryAgents({}, (prompt) => (prompt === 'A' ? 'not json' : ok(prompt)))
    return Effect.gen(function* () {
      const answers = yield* askAll([q('A'), q('B', { kind: 'codex' }), q('C')])
      assert.deepStrictEqual(
        answers.map((a) => (a.ok ? a.reply.text : a.error)),
        [
          'claude printed no JSON: not json',
          'codex has no read-only headless mode here; the agents are claude, opencode',
          're C',
        ],
      )
      assert.deepStrictEqual(agents.ran, ['A', 'C'], 'the codex agent never runs')
    }).pipe(Effect.provide(agents.layer))
  })
})
