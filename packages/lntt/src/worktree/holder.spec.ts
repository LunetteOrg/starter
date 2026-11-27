import { assert, describe, it } from '@effect/vitest'
import { EMPTY_MS, FRESH_MS, judge, lockedMessage, MAX_HOLD_MS, namedPid } from './holder.ts'

const SELF = 100

describe('judge: who holds a lock, from its text and its age', () => {
  it('a live pid holds it until MAX_HOLD_MS, not at it', () => {
    assert.deepStrictEqual(judge('200 lntt review', MAX_HOLD_MS - 1, SELF, true), { pid: 200, command: 'lntt review' })
    assert.strictEqual(judge('200 lntt review', MAX_HOLD_MS, SELF, true), null)
  })

  it('a pid unseen holds it until FRESH_MS, not at it', () => {
    assert.deepStrictEqual(judge('200 lntt review', FRESH_MS - 1, SELF, false), { pid: 200, command: 'lntt review' })
    assert.strictEqual(judge('200 lntt review', FRESH_MS, SELF, false), null)
  })

  it('an empty file is held by a command starting until EMPTY_MS, not at it', () => {
    assert.deepStrictEqual(judge('', EMPTY_MS - 1, SELF, false), { pid: null, command: null })
    assert.strictEqual(judge('', EMPTY_MS, SELF, false), null)
  })

  it('this very process, or no valid pid, holds nothing', () => {
    assert.strictEqual(judge(`${SELF} lntt review`, 0, SELF, true), null)
    for (const text of ['garbage', '0 lntt review', '-3 lntt review', '1.5 lntt review'])
      assert.strictEqual(judge(text, 0, SELF, true), null, text)
  })

  it('names the command after the pid, none when the lock names only a pid', () => {
    assert.deepStrictEqual(judge('200 lntt check tests mutate\n', 0, SELF, true), {
      pid: 200,
      command: 'lntt check tests mutate',
    })
    assert.deepStrictEqual(judge('200', 0, SELF, true), { pid: 200, command: null })
    assert.strictEqual(namedPid(' 200 lntt review'), 200)
  })

  it('a refusal says the command and the pid, starting or unknown when there is none', () => {
    assert.strictEqual(
      lockedMessage({ pid: 200, command: 'lntt review' }),
      'lntt review is already running in this worktree (pid 200)',
    )
    assert.strictEqual(
      lockedMessage({ pid: null, command: null }),
      'another lntt command is already running in this worktree (pid starting)',
    )
    assert.strictEqual(lockedMessage(null), 'another lntt command is already running in this worktree (pid unknown)')
  })
})
