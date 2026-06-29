import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb } from './db'

/**
 * Proof that the `withTestDb` isolation promise (ADR-0006, "never vi.mock the
 * database") actually holds — exercised against a real Postgres container, with
 * NO application schema, so it stays in the template as a permanent infra
 * guarantee rather than a domain example to be deleted by the consuming project.
 *
 * The probe is a throwaway table created INSIDE the wrapped transaction. If the
 * transaction-rollback isolation works, that table cannot survive into the next
 * `withTestDb` call.
 *
 * Integration test (`.test.ts`): needs Docker/Testcontainers.
 */
const { withTestDb } = createTestDb()

describe('withTestDb transaction-rollback isolation', () => {
  it('sees its own writes inside the transaction', async () => {
    await withTestDb(async (tx) => {
      await tx.execute(sql`CREATE TABLE rollback_probe (id integer PRIMARY KEY)`)
      await tx.execute(sql`INSERT INTO rollback_probe (id) VALUES (1)`)
      const rows = await tx.execute(sql`SELECT id FROM rollback_probe`)
      expect(rows.length).toBe(1)
    })
  })

  it('rolls back: the probe table from the previous test does not leak', async () => {
    await withTestDb(async (tx) => {
      // If the previous transaction had committed, this table would exist.
      // A clean rollback means the relation is gone.
      await expect(tx.execute(sql`SELECT id FROM rollback_probe`)).rejects.toThrow(/rollback_probe/)
    })
  })
})
