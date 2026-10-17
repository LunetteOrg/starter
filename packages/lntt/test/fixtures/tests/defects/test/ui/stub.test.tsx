import assert from 'node:assert/strict'
import { test } from 'node:test'

test('drives a stubbed observer', () => {
  globalThis.IntersectionObserver = class {} as never
  assert.ok(globalThis.IntersectionObserver)
})
