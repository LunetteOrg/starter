import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('another test names the limits by path only', () => {
  const file = join(process.cwd(), 'src/limits.json')
  assert.ok(readFileSync(file, 'utf8').length > 0)
})
