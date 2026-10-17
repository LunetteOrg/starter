import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discount, label } from '../src/price.ts'

test('a member gets ten percent off', () => {
  assert.equal(discount(200, true), 180)
})

test('a visitor pays the total', () => {
  assert.equal(discount(200, false), 200)
})

test('nothing to pay is nothing', () => {
  assert.equal(discount(0, true), 0)
})

test('a small basket is small', () => {
  assert.equal(label(50), 'small')
})
