import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { beforeAll, describe, expect } from 'vitest'
import { createTestDb, hasTestDatabase, type TestTransaction, txTest } from './db.ts'

/**
 * The fixture against a table committed OUTSIDE any transaction: the fixture
 * migration creates `migrated_probe` and commits it, so a row a test leaves behind
 * is visible from any other connection. A table created inside the test's own
 * transaction would vanish with the rollback and prove nothing.
 */
const db = createTestDb({ databaseName: 'tx_fixture_probe', migrationsFolder: './src/__fixtures__/migrations' })

/** How many transactions the fixture opened: the laziness check reads it. */
let opened = 0
const it = txTest<TestTransaction>((fn) => {
  opened++
  return db.withTestDb(fn)
})

/**
 * Set by each writing test right after its insert succeeded. `it.fails` passes on ANY
 * failure, a fixture that cannot connect or an insert that throws included; without
 * these flags the emptiness check below would pass on rows never written.
 */
const inserted = { passing: false, failing: false }

async function committedIds(): Promise<number[]> {
  // A connection of its own, outside the fixture: it sees only what was committed.
  const client = postgres(await db.connectionString(), { max: 1 })
  try {
    return (await client<{ id: number }[]>`SELECT id FROM migrated_probe`).map((row) => row.id)
  } finally {
    await client.end()
  }
}

/**
 * The four tests run as a group, in file order: the last two read what the first two
 * did. The options pin that order against `--sequence.shuffle`,
 * `--sequence.concurrent` and a retry, which would re-run a test with the flags
 * already set. `-t` on one of the last two alone is red by design: the flags stay
 * unset.
 */
describe.skipIf(!hasTestDatabase())('txTest', { concurrent: false, shuffle: false, retry: 0 }, () => {
  // A server that outlived an earlier run could hold rows already; the final check
  // must start from an empty table, or it fails for the wrong reason.
  beforeAll(async () => {
    const client = postgres(await db.connectionString(), { max: 1 })
    try {
      await client`DELETE FROM migrated_probe`
    } finally {
      await client.end()
    }
  })

  it('hands the test a transaction that sees its own writes', async ({ tx }) => {
    await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (1)`)
    inserted.passing = true
    expect(await tx.execute(sql`SELECT id FROM migrated_probe`)).toHaveLength(1)
  })

  it.fails('rolls back a failing test, too', async ({ tx }) => {
    await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (2)`)
    expect(await tx.execute(sql`SELECT id FROM migrated_probe WHERE id = 2`)).toHaveLength(1)
    inserted.failing = true
    throw new Error('deliberate failure after the insert')
  })

  it('leaves nothing committed by either test', async () => {
    expect(inserted).toEqual({ passing: true, failing: true })
    expect(await committedIds()).toEqual([])
  })

  it('opens no transaction for a test that does not ask for tx', async ({ task }) => {
    expect(task.name).toMatch(/does not ask for tx/)
    // One per test that destructured `tx`, none for the two that did not.
    expect(opened).toBe(2)
  })
})
