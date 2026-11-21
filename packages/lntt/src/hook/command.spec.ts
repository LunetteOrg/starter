import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestConsole from 'effect/testing/TestConsole'
import { command, REMOVED } from './command.ts'

describe('lntt hook typecheck', () => {
  it.effect('answers the Stop line of 0.6.4 with what to do: a systemMessage, exit 0', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* command, 0)
      assert.deepStrictEqual(
        (yield* TestConsole.logLines).map((line) => JSON.parse(String(line))),
        [{ systemMessage: REMOVED }],
      )
      assert.match(REMOVED, /run pnpm exec lntt sync/)
    }).pipe(Effect.provide(TestConsole.layer)),
  )
})
