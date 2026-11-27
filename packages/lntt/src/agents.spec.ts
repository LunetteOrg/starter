import { assert, describe, it } from '@effect/vitest'
import { holdsManagedBlock, managedBlock, withManagedBlock } from './agents.ts'

const BLOCK = managedBlock('# Rules\n\nGive criteria before options.\n')

describe('the managed block', () => {
  it('is wrapped in the lunette markers, naming the command that writes it', () => {
    assert.match(BLOCK, /^<!-- lunette:start — managed by lntt sync:/)
    assert.match(BLOCK, /\nGive criteria before options\.\n<!-- lunette:end -->\n$/)
  })

  it('is the whole of a new AGENTS.md', () => {
    assert.strictEqual(withManagedBlock(null, BLOCK), BLOCK)
  })

  it('goes on top of an AGENTS.md that has none, keeping its text', () => {
    assert.strictEqual(
      withManagedBlock('# My project\n\nOur own rule.\n', BLOCK),
      `${BLOCK}\n# My project\n\nOur own rule.\n`,
    )
  })

  it('replaces only what is between the markers', () => {
    const text = '<!-- lunette:start -->\nold rules\n<!-- lunette:end -->\n\n# Mine\n\nKeep me.\n'
    assert.strictEqual(withManagedBlock(text, BLOCK), `${BLOCK}\n# Mine\n\nKeep me.\n`)
  })

  it('is held once written, and not after a hand edit inside it', () => {
    const written = withManagedBlock('# Mine\n', BLOCK)
    assert.isTrue(holdsManagedBlock(written, BLOCK))
    assert.isFalse(holdsManagedBlock(written.replace('Give criteria', 'Give options'), BLOCK))
  })

  it('is not held when AGENTS.md or the block is missing', () => {
    assert.isFalse(holdsManagedBlock(null, BLOCK))
    assert.isFalse(holdsManagedBlock('# Mine\n', BLOCK))
  })
})
