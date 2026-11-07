import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SKILLS = join(process.cwd(), 'skills')

test('the review skill forbids merging', () => {
  const text = readFileSync(join(SKILLS, 'review/SKILL.md'), 'utf8')
  assert.match(text, /Never merge on your own/)
})
