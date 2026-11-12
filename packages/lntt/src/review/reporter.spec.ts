import { assert, describe, it } from '@effect/vitest'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import type { Subagents } from '../orca-subagents.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { Pids } from '../worktree/lock.ts'
import { reporting } from './reporter.ts'
import { ReviewStore } from './store.ts'

const GIT_DIR = '/repo/.git'
const PROGRESS = `${GIT_DIR}/lntt-review.progress`
const LABEL = 'code · claude sonnet'

function setup() {
  const fs = memoryFileSystem({ dirs: [GIT_DIR] })
  const layer = Layer.mergeAll(
    ReviewStore.memory('/store', GIT_DIR).pipe(Layer.provideMerge(fs.layer)),
    Layer.succeed(Pids)(Pids.of({ self: 7, visible: () => Effect.succeed(false) })),
    Layer.fresh(TestConsole.layer),
  )
  const events = () =>
    (fs.text(PROGRESS) ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  const running = Effect.map(TestConsole.errorLines, (lines) =>
    lines.map(String).filter((line) => line.includes('running')),
  )
  return { layer, events, running }
}

const answered = {
  type: 'end' as const,
  index: 0,
  label: LABEL,
  optional: false,
  ms: 2000,
  answer: { ok: true as const, reply: { text: 'no findings', session: 's', tokens: 1500, cost: null } },
}

describe('the reporter of lntt review', () => {
  it.effect(
    'a beat every 15 seconds in the progress file; stderr hears every second one, and only while an agent runs',
    () => {
      const { layer, events, running } = setup()
      return Effect.gen(function* () {
        yield* (yield* ReviewStore).startProgress
        const beats = () => events().map((e) => e.running)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const report = yield* reporting()
            yield* TestClock.adjust(Duration.millis(14_999))
            assert.deepStrictEqual(beats(), [], 'no beat before 15 seconds')
            yield* TestClock.adjust(Duration.millis(1))
            yield* TestClock.adjust(Duration.seconds(15))
            assert.deepStrictEqual(beats(), [0, 0])
            assert.deepStrictEqual(yield* running, [], 'nothing runs, nothing to say')

            report.progress({ type: 'start', index: 0, label: LABEL, optional: false })
            yield* report.flush
            yield* TestClock.adjust(Duration.seconds(15))
            assert.deepStrictEqual(
              events()
                .filter((e) => e.type === 'beat')
                .map((e) => e.running),
              [0, 0, 1],
            )
            assert.deepStrictEqual(yield* running, [], 'the third beat is not heard on stderr')
            yield* TestClock.adjust(Duration.seconds(15))
            assert.deepStrictEqual(yield* running, [`lntt review: running 1 (1m00s): ${LABEL}`])
          }),
        )
        const after = events().length
        yield* TestClock.adjust(Duration.seconds(30))
        assert.strictEqual(events().length, after, 'no beat once its scope is closed')
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('what askAll reports is written in order, and all of it before the scope closes', () => {
    const { layer, events } = setup()
    return Effect.gen(function* () {
      yield* (yield* ReviewStore).startProgress
      yield* Effect.scoped(
        Effect.gen(function* () {
          const report = yield* reporting()
          report.phase([LABEL])
          report.progress({ type: 'start', index: 0, label: LABEL, optional: false })
          report.progress(answered)
          report.progress({ type: 'start', index: 1, label: 'verify f1 · claude opus', optional: true })
          report.progress({
            ...answered,
            index: 1,
            label: 'verify f1 · claude opus',
            optional: true,
            answer: { ok: false, error: 'boom' },
          })
        }),
      )
      assert.deepStrictEqual(
        events().map((e) => [e.type, e.phase, e.outcome]),
        [
          ['phase', 'reviewers', undefined],
          ['start', 'reviewers', undefined],
          ['end', 'reviewers', 'done'],
          ['start', 'verify', undefined],
          ['end', 'verify', 'skipped'],
        ],
      )
      assert.deepStrictEqual((yield* TestConsole.errorLines).map(String), [
        `lntt review: start ${LABEL}`,
        `lntt review: done ${LABEL} in 2s (1.5k tokens)`,
        'lntt review: start verify f1 · claude opus',
        'lntt review: skipped verify f1 · claude opus in 2s: boom',
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('Orca hears each agent as a subagent of its own pid, and is closed once all is written', () => {
    const { layer, events } = setup()
    const heard: string[] = []
    const orca: Subagents = {
      start: (id, label) => void heard.push(`start ${id} ${label}`),
      stop: (id, _label, outcome) => void heard.push(`stop ${id} ${outcome}`),
      close: () => void heard.push(`close after ${events().length} events`),
    }
    return Effect.gen(function* () {
      yield* (yield* ReviewStore).startProgress
      yield* Effect.scoped(
        Effect.gen(function* () {
          const report = yield* reporting(orca)
          report.progress({ type: 'start', index: 0, label: LABEL, optional: false })
          report.progress(answered)
        }),
      )
      assert.deepStrictEqual(heard, [
        `start lntt-review-7-reviewers-0 ${LABEL}`,
        'stop lntt-review-7-reviewers-0 answered',
        'close after 2 events',
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('a reply is its own phase', () => {
    const { layer, events } = setup()
    return Effect.gen(function* () {
      yield* (yield* ReviewStore).startProgress
      yield* Effect.scoped(
        Effect.gen(function* () {
          const report = yield* reporting()
          report.phase(['reply f1 · claude sonnet'])
          report.progress({ type: 'start', index: 0, label: 'reply f1 · claude sonnet', optional: false })
        }),
      )
      assert.deepStrictEqual(
        events().map((e) => [e.type, e.phase]),
        [
          ['phase', 'reply'],
          ['start', 'reply'],
        ],
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect('a write that dies fails the flush with its defect, instead of leaving it waiting', () => {
    const fs = memoryFileSystem({ dirs: [GIT_DIR] })
    const dying = Layer.effect(ReviewStore)(
      Effect.map(Effect.flatMap(ReviewStore, Effect.succeed), (store) =>
        ReviewStore.of({ ...store, emit: () => Effect.die(new Error('a bug of lntt')) }),
      ),
    ).pipe(Layer.provide(ReviewStore.memory('/store', GIT_DIR)), Layer.provide(fs.layer))
    const layer = Layer.mergeAll(
      dying,
      Layer.succeed(Pids)(Pids.of({ self: 7, visible: () => Effect.succeed(false) })),
      Layer.fresh(TestConsole.layer),
    )
    return Effect.gen(function* () {
      const ending = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const report = yield* reporting()
            report.phase([LABEL])
            yield* report.flush
          }),
        ),
      )
      assert.ok(Exit.isFailure(ending))
      assert.match(String(Exit.isFailure(ending) && ending.cause), /a bug of lntt/)
    }).pipe(Effect.provide(layer))
  })
})
