import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fill } from '../src/template.ts'

describe('fill', () => {
  test('replaces every placeholder in one pass: a value holding braces is not read again', () => {
    assert.equal(fill('{{a}} and {{b}}', { a: '{{b}}', b: 'x' }), '{{b}} and x')
  })

  test('a placeholder with no value is an error, not literal braces', () => {
    assert.throws(() => fill('{{missing}}', {}), /\{\{missing\}\}/)
  })

  test('an empty slot on a line of its own goes away with the blank line before it', () => {
    assert.equal(fill('one\n\n{{slot}}\n\ntwo\n', { slot: '' }), 'one\n\ntwo\n')
    assert.equal(fill('one\n\n{{slot}}\n', { slot: undefined }), 'one\n')
  })

  test('an empty slot as a list item goes away alone', () => {
    assert.equal(fill('- a\n- {{slot}}\n- b\n', { slot: null }), '- a\n- b\n')
  })

  test('a slot with a value stays where it is', () => {
    assert.equal(fill('one\n\n{{slot}}\n', { slot: 'two' }), 'one\n\ntwo\n')
  })
})
