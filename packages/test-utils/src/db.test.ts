import { existsSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb } from './db'

/**
 * Proof that the `withTestDb` isolation promise (ADR-0006, "never vi.mock the
 * database") actually holds — exercised against a real Postgres container, with
 * NO application schema, so it stays in the template as a permanent infra
 * guarantee rather than a domain example to be deleted by the consuming project.
 *
 * Integration test (`.test.ts`): needs Docker/Testcontainers. We skip (rather
 * than fail loudly) when no Docker endpoint is discoverable, so a unit-only run
 * on a machine without Docker stays green.
 */
const hasDocker = existsSync('/var/run/docker.sock') || Boolean(process.env.DOCKER_HOST)

describe.skipIf(!hasDocker)('withTestDb transaction-rollback isolation', () => {
  const { withTestDb } = createTestDb()

  // Single test, two sequential transactions: order-independent. A two-test
  // version where the second only asserts ABSENCE would pass vacuously if the
  // first never ran (test filter, `sequence.shuffle`).
  it('rolls back writes between transactions', async () => {
    await withTestDb(async (tx) => {
      await tx.execute(sql`CREATE TABLE rollback_probe (id integer PRIMARY KEY)`)
      await tx.execute(sql`INSERT INTO rollback_probe (id) VALUES (1)`)
      const rows = await tx.execute(sql`SELECT id FROM rollback_probe`)
      expect(rows.length).toBe(1)
    })

    await withTestDb(async (tx) => {
      // If the previous transaction had committed, this table would exist.
      // A clean rollback means the relation is gone.
      await expect(tx.execute(sql`SELECT id FROM rollback_probe`)).rejects.toThrow(/rollback_probe/)
    })
  })

  // Guards the error seam in `withTestDb` (db.ts): an assertion failure inside
  // `fn` must surface as a rejected promise. If the rethrow ever regresses,
  // EVERY assertion inside withTestDb would pass silently — so test it directly.
  it('rethrows an error raised inside the transaction', async () => {
    await expect(
      withTestDb(async () => {
        throw new Error('boom-from-inside')
      }),
    ).rejects.toThrow('boom-from-inside')
  })
})

describe.skipIf(!hasDocker)('createTestDb with migrations', () => {
  // Exercises the real migration path (advisory lock + drizzle `migrate()` in
  // db.ts) that the relationless default instance never touches. The fixture is
  // a drizzle rc.4 folder: `<timestamp>_<name>/migration.sql`, no _journal.json.
  const { withTestDb } = createTestDb({
    migrationsFolder: './src/__fixtures__/migrations',
  })

  it('applies migrations before running the test body', async () => {
    await withTestDb(async (tx) => {
      const rows = await tx.execute(sql`SELECT id FROM migrated_probe`)
      expect(rows.length).toBe(0)
    })
  })
})
