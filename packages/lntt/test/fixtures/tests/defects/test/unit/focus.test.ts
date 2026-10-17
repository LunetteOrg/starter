import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'

describe('focus', () => {
  it.only('runs alone', () => {
    assert.equal(1, 1)
  })

  it.skip('is switched off', () => {
    assert.equal(1, 2)
  })

  it.todo('one day')

  test('has no assertion', () => {
    const x = 1 + 1
    console.log(x)
  })

  test('asserts through run', () => {
    run('echo ok')
  })

  test('mentions it.only in its title and asserts', () => {
    assert.ok(true)
  })

  test('is fine', () => {
    assert.equal(2, 2)
  })
})
