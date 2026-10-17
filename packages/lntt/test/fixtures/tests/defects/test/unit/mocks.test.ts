import assert from 'node:assert/strict'
import { test, vi } from 'node:test'

vi.mock('./db')

test('uses the mock', () => {
  assert.ok(vi)
})
