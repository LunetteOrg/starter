import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

test('every file of the guide skill greets politely', () => {
  const dir = join(process.cwd(), 'plugin', 'skills/guide')
  for (const name of readdirSync(dir)) assert.match(readFileSync(join(dir, name), 'utf8'), /Greet politely/)
})
