import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { createTestDb, hasTestDatabase } from './db.ts'

/**
 * Against the run's real Postgres, started by the globalSetup this package's vitest
 * config mounts. Without Docker the globalSetup publishes no server and these
 * suites skip locally; in CI it fails the run instead.
 */
describe.skipIf(!hasTestDatabase())('withTestDb', () => {
  const { withTestDb } = createTestDb({ databaseName: 'rollback_probe' })
  const throwProbe = createTestDb({ databaseName: 'throw_probe', migrationsFolder: './src/__fixtures__/migrations' })

  // Two sequential transactions in one test: a version where a second test only
  // asserts ABSENCE would pass vacuously if the first never ran.
  it('rolls back writes between tests', async () => {
    await withTestDb(async (tx) => {
      await tx.execute(sql`CREATE TABLE rollback_probe (id integer PRIMARY KEY)`)
      await tx.execute(sql`INSERT INTO rollback_probe (id) VALUES (1)`)
      expect(await tx.execute(sql`SELECT id FROM rollback_probe`)).toHaveLength(1)
    })
    await withTestDb(async (tx) => {
      await expect(tx.execute(sql`SELECT id FROM rollback_probe`)).rejects.toThrow(/rollback_probe/)
    })
  })

  // If the rethrow regressed, every assertion inside withTestDb would pass silently.
  it('rethrows an error raised inside the transaction', async () => {
    await expect(
      withTestDb(async () => {
        throw new Error('boom-from-inside')
      }),
    ).rejects.toThrow('boom-from-inside')
  })

  // On a table committed by the migration, read back from a connection of its own: a
  // throw must not skip the rollback. The table is emptied first: a row committed by
  // an earlier broken run on a server that outlived it would fail this one for an old
  // cause.
  it('rolls back the writes of a callback that throws', async () => {
    const reader = postgres(await throwProbe.connectionString(), { max: 1 })
    try {
      await reader`DELETE FROM migrated_probe`
      await expect(
        throwProbe.withTestDb(async (tx) => {
          await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (7)`)
          throw new Error('boom-after-insert')
        }),
      ).rejects.toThrow('boom-after-insert')
      expect(await reader`SELECT id FROM migrated_probe`).toEqual([])
    } finally {
      await reader.end()
    }
  })
})

describe.skipIf(!hasTestDatabase())('databaseName', () => {
  it('gives each instance its own database on the run server', async () => {
    const names: string[] = []
    for (const databaseName of ['probe_one', 'probe_two']) {
      await createTestDb({ databaseName }).withTestDb(async (tx) => {
        const rows = await tx.execute<{ name: string }>(sql`SELECT current_database() AS name`)
        names.push(rows[0]?.name ?? '')
      })
    }
    expect(names).toEqual(['probe_one', 'probe_two'])
  })
})

describe.skipIf(!hasTestDatabase())('migrations', () => {
  it('are applied before the test body', async () => {
    const db = createTestDb({ databaseName: 'migrate_probe', migrationsFolder: './src/__fixtures__/migrations' })
    await db.withTestDb(async (tx) => {
      expect(await tx.execute(sql`SELECT id FROM migrated_probe`)).toHaveLength(0)
    })
  })

  // Two instances on one database race to migrate it; the advisory lock serialises
  // them, so neither sees a half-built schema or fails on a duplicate CREATE.
  it('run once per database when instances race', async () => {
    const folder = './src/__fixtures__/migrations'
    const instances = [1, 2, 3].map(() => createTestDb({ databaseName: 'migrate_race', migrationsFolder: folder }))
    await Promise.all(
      instances.map((db) =>
        db.withTestDb(async (tx) => {
          expect(await tx.execute(sql`SELECT id FROM migrated_probe`)).toHaveLength(0)
        }),
      ),
    )
  })

  it('surface their own error when one fails', async () => {
    const db = createTestDb({
      databaseName: 'migrate_broken',
      migrationsFolder: './src/__fixtures__/broken-migrations',
    })
    // The migration's own query, not the unlock that follows it in `finally`.
    await expect(db.withTestDb(async () => {})).rejects.toThrow(/Failed query: CREATE TABLE broken_probe/)
  })
})

describe.skipIf(!hasTestDatabase())('connectionString', () => {
  // For tests that must commit, such as two transactions racing on connections of
  // their own: what they commit stays, so they remove it themselves.
  it('points at the migrated database, where commits are visible to other connections', async () => {
    const db = createTestDb({ databaseName: 'commit_probe', migrationsFolder: './src/__fixtures__/migrations' })
    const url = await db.connectionString()
    expect(new URL(url).pathname).toBe('/commit_probe')

    const writer = postgres(url, { max: 1 })
    const reader = postgres(url, { max: 1 })
    try {
      await writer`INSERT INTO migrated_probe (id) VALUES (42)`
      expect(await reader`SELECT id FROM migrated_probe`).toEqual([{ id: 42 }])
    } finally {
      await writer`DELETE FROM migrated_probe`
      await writer.end()
      await reader.end()
    }
  })
})
