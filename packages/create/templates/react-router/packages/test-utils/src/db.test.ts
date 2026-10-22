import { existsSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb, type TestTransaction, txTest } from './db'

/**
 * Proof that the `withTestDb` isolation promise (docs/adr/testing.md (testing strategy), "never vi.mock the
 * database") actually holds — exercised against a real Postgres container, with
 * NO application schema, so it stays in the template as a permanent infra
 * guarantee rather than a domain example to be deleted by the consuming project.
 *
 * Integration test (`.test.ts`): needs Docker/Testcontainers. Locally we skip
 * when no Docker endpoint is discoverable, so a unit-only run stays green — but
 * in CI Docker is mandatory, so a missing endpoint there is a hard failure
 * rather than a silent skip (which would be a false green).
 */
const hasDocker = existsSync('/var/run/docker.sock') || Boolean(process.env.DOCKER_HOST)

if (process.env.CI && !hasDocker) {
  throw new Error(
    'Integration tests require Docker, but no endpoint was found (checked ' +
      '/var/run/docker.sock and $DOCKER_HOST). In CI this must not be skipped.',
  )
}

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
  // db.ts) that the relationless instance above never touches. The fixture is
  // a drizzle rc.4 folder: `<timestamp>_<name>/migration.sql`, no _journal.json.
  //
  // `databaseName`: migrate() COMMITS the migration + `__drizzle_migrations`
  // outside any transaction. On the shared reused container that committed state
  // would leak across packages and collide with an app's own migrations, so this
  // instance gets its own database on the same container — isolating its journal
  // without stopping the shared container (docs/adr/testing.md — test database isolation).
  const migrated = createTestDb({
    migrationsFolder: './src/__fixtures__/migrations',
    databaseName: 'migrate_probe',
  })

  it('applies migrations before running the test body', async () => {
    await migrated.withTestDb(async (tx) => {
      const rows = await tx.execute(sql`SELECT id FROM migrated_probe`)
      expect(rows.length).toBe(0)
    })
  })

  // On the table the migration committed: a throw must not skip the rollback. A
  // random id, because the reused container keeps what an earlier run committed;
  // a fresh `withTestDb` call reads on a client of its own.
  it('rolls back the writes of a callback that throws', async () => {
    const id = Math.floor(Math.random() * 1_000_000_000) + 1
    await expect(
      migrated.withTestDb(async (tx) => {
        await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (${id})`)
        throw new Error('boom-after-insert')
      }),
    ).rejects.toThrow('boom-after-insert')

    await migrated.withTestDb(async (tx) => {
      const rows = await tx.execute(sql`SELECT id FROM migrated_probe WHERE id = ${id}`)
      expect(rows).toHaveLength(0)
    })
  })
})

// The four tests run as a group, in file order: the last two read what the first
// two did. The options pin that order against `--sequence.shuffle`,
// `--sequence.concurrent` and a retry, which would re-run a test with the flags
// already set. `-t` on one of the last two alone is red by design: the flags stay
// unset.
describe.skipIf(!hasDocker)(
  'txTest: the transaction as a fixture',
  { concurrent: false, shuffle: false, retry: 0 },
  () => {
    // A table committed OUTSIDE any transaction: the fixture migration creates
    // `migrated_probe` and commits it, so a row a test leaves behind stays visible
    // to every later transaction. A table created inside the test's own transaction
    // would vanish with the rollback and prove nothing.
    const db = createTestDb({
      migrationsFolder: './src/__fixtures__/migrations',
      databaseName: 'tx_fixture_probe',
    })

    // How many transactions the fixture opened: the laziness check reads it.
    let opened = 0
    const it = txTest<TestTransaction>((fn) => {
      opened++
      return db.withTestDb(fn)
    })

    // Ids of THIS run: the reused container keeps whatever an earlier run
    // committed, and the emptiness check must look at this run's rows only.
    const ids = [1, 2].map(() => Math.floor(Math.random() * 1_000_000_000) + 1)

    // Set by each writing test right after its insert succeeded. `it.fails` passes
    // on ANY failure, a fixture that cannot connect or an insert that throws
    // included; without these flags the emptiness check would pass on rows never
    // written.
    const inserted = { passing: false, failing: false }

    it('hands the test a transaction that sees its own writes', async ({ tx }) => {
      await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (${ids[0]})`)
      inserted.passing = true
      expect(
        await tx.execute(sql`SELECT id FROM migrated_probe WHERE id = ${ids[0]}`),
      ).toHaveLength(1)
    })

    it.fails('rolls back a failing test, too', async ({ tx }) => {
      await tx.execute(sql`INSERT INTO migrated_probe (id) VALUES (${ids[1]})`)
      expect(
        await tx.execute(sql`SELECT id FROM migrated_probe WHERE id = ${ids[1]}`),
      ).toHaveLength(1)
      inserted.failing = true
      throw new Error('deliberate failure after the insert')
    })

    it('leaves nothing committed by either test', async () => {
      expect(inserted).toEqual({ passing: true, failing: true })
      // A fresh `withTestDb` call opens a postgres client of its own: it sees only
      // what was committed.
      await db.withTestDb(async (tx) => {
        const rows = await tx.execute(
          sql`SELECT id FROM migrated_probe WHERE id IN (${ids[0]}, ${ids[1]})`,
        )
        expect(rows).toHaveLength(0)
      })
    })

    it('opens no transaction for a test that does not ask for tx', async ({ task }) => {
      expect(task.name).toMatch(/does not ask for tx/)
      // One per test that destructured `tx`, none for the two that did not.
      expect(opened).toBe(2)
    })
  },
)
