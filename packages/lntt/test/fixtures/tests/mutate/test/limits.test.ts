import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('the limit is read as text', () => {
  assert.match(readFileSync(new URL('../src/limits.json', import.meta.url), 'utf8'), /"max": 3/)
})
