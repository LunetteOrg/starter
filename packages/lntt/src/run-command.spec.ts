import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { Exit as LnttExit } from './exit.ts'
import { teardownWith } from './run-command.ts'

// The code the teardown leaves with for the ending of a command, and what it reported.
async function end(
  ending: Exit.Exit<unknown, unknown>,
  after?: (value: unknown) => Promise<number>,
): Promise<{ code: number; reported: string }> {
  let reported = ''
  const code = await new Promise<number>((resolve) =>
    teardownWith(
      async (c) => resolve(c),
      (text) => {
        reported += text
      },
      after,
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

  it("on a success, runs `after` with the command's value and leaves with its code", async () => {
    const seen: unknown[] = []
    const after = async (value: unknown) => {
      seen.push(value)
      return 3
    }
    assert.deepStrictEqual(await end(Exit.succeed('results'), after), { code: 3, reported: '' })
    assert.deepStrictEqual(seen, ['results'])
  })

  it('`after` runs on a success only: a failure or an exit(code) leaves as without it', async () => {
    let ran = false
    const after = async () => {
      ran = true
      return 0
    }
    assert.deepStrictEqual(await end(Exit.fail(new LnttExit(2)), after), { code: 2, reported: '' })
    assert.strictEqual((await end(Exit.die(new TypeError('a bug')), after)).code, 1)
    assert.strictEqual(ran, false)
  })

  it('`after` that throws is printed and leaves with 1; one that throws exit(code) leaves with its code', async () => {
    const failing = await end(Exit.succeed(null), async () => {
      throw new Error('jq broke')
    })
    assert.strictEqual(failing.code, 1)
    assert.match(failing.reported, /Error: jq broke/)
    assert.deepStrictEqual(
      await end(Exit.succeed(null), async () => {
        throw new LnttExit(2)
      }),
      { code: 2, reported: '' },
    )
  })
})
