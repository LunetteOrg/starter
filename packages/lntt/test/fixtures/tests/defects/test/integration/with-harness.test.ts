import assert from 'node:assert/strict'
import { test } from 'node:test'

test('opens the transaction', async ({ tx }: { tx: unknown }) => {
  assert.ok(tx)
})
