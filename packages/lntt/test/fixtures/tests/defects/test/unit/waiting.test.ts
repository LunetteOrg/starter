import assert from 'node:assert/strict'
import { test } from 'node:test'

test('waits without saying what for', async () => {
  await waitFor(() => assert.ok(true))
})
