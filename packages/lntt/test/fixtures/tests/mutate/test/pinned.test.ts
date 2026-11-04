import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('the pinned note has a title', () => {
  assert.match(readFileSync(join(process.cwd(), 'docs/pinned.md'), 'utf8'), /Pinned: the title/)
})
