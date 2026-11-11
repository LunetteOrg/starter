import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { Exit as LnttExit } from './exit.ts'
import { teardownWith } from './run-command.ts'

// The code the teardown leaves with for the ending of a command, and what it reported.
async function end(ending: Exit.Exit<unknown, unknown>): Promise<{ code: number; reported: string }> {
  let reported = ''
  const code = await new Promise<number>((resolve) =>
    teardownWith(
      async (c) => resolve(c),
      (text) => {
        reported += text
      },
    )(ending, () => {}),
  )
  return { code, reported }
}

describe('teardownWith', () => {
  it('leaves with 0 when the command succeeds', async () => {
    assert.deepStrictEqual(await end(Exit.succeed(undefined)), { code: 0, reported: '' })
  })

  it('leaves with the code of exit(code) thrown by the command, reporting nothing', async () => {
    assert.deepStrictEqual(await end(Exit.fail(new LnttExit(4))), { code: 4, reported: '' })
    assert.deepStrictEqual(await end(Exit.fail(new LnttExit(3))), { code: 3, reported: '' })
  })

  it.effect('leaves with 130 when the command is interrupted, whichever the signal', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.never)
      const ending = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      assert.deepStrictEqual(yield* Effect.promise(() => end(ending)), { code: 130, reported: '' })
    }),
  )

  it('leaves with 1 for any other failure, and prints it', async () => {
    const { code, reported } = await end(Exit.fail(new Error('the state cannot be read')))
    assert.strictEqual(code, 1)
    assert.match(reported, /Error: the state cannot be read/)
  })

  it('leaves with 1 for a defect of lntt, and prints its stack as Node prints an uncaught error', async () => {
    const { code, reported } = await end(Exit.die(new TypeError('a bug')))
    assert.strictEqual(code, 1)
    assert.match(reported, /TypeError: a bug\n\s+at /)
  })
})
