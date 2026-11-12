import { assert, describe, it } from '@effect/vitest'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import type { ReviewState } from '../review.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { ReviewStore } from './store.ts'

const GIT_DIR = '/repo/.git'
const DIR = '/repo/.git/lntt-review'
const PROGRESS = `${GIT_DIR}/lntt-review.progress`
const STATE = `${DIR}/state/feat%2F1%2Fx.json`
const LEDGER = `${DIR}/ledger/feat%2F1%2Fx.json`

function setup(dirs = [GIT_DIR]) {
  const fs = memoryFileSystem({ dirs })
  const layer = Layer.mergeAll(
    ReviewStore.memory(DIR, GIT_DIR).pipe(Layer.provideMerge(fs.layer)),
    Layer.fresh(TestConsole.layer),
  )
  return { fs, layer }
}

const state = { branch: 'feat/1/x', round: 1, reviewed: 'c2', result: { findings: [] } } as unknown as ReviewState

describe('the review state store', () => {
  it.effect("a branch's state is written in a file of its own, its folders created, and read back", () => {
    const { fs, layer } = setup()
    return Effect.gen(function* () {
      const store = yield* ReviewStore
      assert.strictEqual(yield* store.readState('feat/1/x'), null, 'no state yet')
      yield* store.writeState(state)
      assert.strictEqual(fs.text(STATE), `${JSON.stringify(state, null, 2)}\n`)
      assert.deepStrictEqual(yield* store.readState('feat/1/x'), state)
    }).pipe(Effect.provide(layer))
  })

  it.effect('a state file that names another branch, or is not JSON, fails: never a round on a guess', () => {
    const { fs, layer } = setup()
    return Effect.gen(function* () {
      const store = yield* ReviewStore
      yield* fs.put(STATE, JSON.stringify({ ...state, branch: 'feat/2/y' }))
      const other = yield* Effect.exit(store.readState('feat/1/x'))
      assert.ok(Exit.isFailure(other))
      assert.match(
        String(Exit.isFailure(other) && other.cause),
        /cannot be read: pnpm exec lntt review status --clear removes it/,
      )
      yield* fs.put(STATE, '{"branch": "feat/1/x", "rou')
      assert.ok(Exit.isFailure(yield* Effect.exit(store.readState('feat/1/x'))))
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'a ledger of another branch is none, unsaid; one that cannot be read is none, and said when a round reads it',
    () => {
      const { fs, layer } = setup()
      return Effect.gen(function* () {
        const store = yield* ReviewStore
        assert.deepStrictEqual(yield* store.readLedger('feat/1/x'), [], 'no ledger yet')
        yield* fs.put(LEDGER, JSON.stringify({ branch: 'feat/2/y', closed: [{ id: 'f1' }] }))
        assert.deepStrictEqual(yield* store.readLedger('feat/1/x'), [])
        for (const text of ['{"branch": "feat/1/x", "clo', '{"branch": "feat/1/x"}']) {
          yield* fs.put(LEDGER, text)
          assert.deepStrictEqual(yield* store.closed('feat/1/x'), [])
          assert.deepStrictEqual(yield* store.readLedger('feat/1/x'), [])
        }
        assert.deepStrictEqual((yield* TestConsole.errorLines).map(String), [
          `lntt review: ${LEDGER} cannot be read: the branch starts a new ledger`,
          `lntt review: ${LEDGER} cannot be read: the branch starts a new ledger`,
        ])
        const closed = [{ id: 'f1' }] as never
        yield* store.writeLedger('feat/1/x', closed)
        assert.deepStrictEqual(yield* store.closed('feat/1/x'), closed)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('the progress file: nothing before a start; a start empties it; each event a line with its time', () => {
    const { fs, layer } = setup()
    return Effect.gen(function* () {
      const store = yield* ReviewStore
      yield* fs.put(PROGRESS, '{"type":"done"}\n')
      yield* store.emit({ type: 'beat' })
      assert.strictEqual(fs.text(PROGRESS), '{"type":"done"}\n', "an event before a start leaves the last round's file")
      assert.strictEqual(yield* store.started, false)
      yield* store.startProgress
      assert.strictEqual(fs.text(PROGRESS), '')
      yield* TestClock.adjust(Duration.millis(1500))
      yield* store.emit({ type: 'round', round: 1 })
      yield* store.emit({ type: 'done' })
      assert.strictEqual(fs.text(PROGRESS), '{"t":1500,"type":"round","round":1}\n{"t":1500,"type":"done"}\n')
      assert.strictEqual(yield* store.started, true)
    }).pipe(Effect.provide(layer))
  })

  it.effect('a progress file that cannot be written is no failure: the command goes on, its events unwritten', () => {
    const { fs, layer } = setup([])
    return Effect.gen(function* () {
      const store = yield* ReviewStore
      yield* store.startProgress
      yield* store.emit({ type: 'round' })
      assert.strictEqual(yield* store.started, false)
      assert.strictEqual(fs.text(PROGRESS), undefined)
    }).pipe(Effect.provide(layer))
  })
})
