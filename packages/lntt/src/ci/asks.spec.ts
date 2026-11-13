import { assert, describe, it } from '@effect/vitest'
import { joinPath } from './asks.ts'

describe('joinPath', () => {
  it('joins as path.posix.join does', () => {
    assert.strictEqual(joinPath('/repo', 'packages/a'), '/repo/packages/a')
    assert.strictEqual(joinPath('/repo', './packages//a/'), '/repo/packages/a')
    assert.strictEqual(joinPath('/repo/x', '../y'), '/repo/y')
    assert.strictEqual(joinPath('/', '..', 'a'), '/a')
    assert.strictEqual(joinPath('a', '..'), '.')
  })
})
