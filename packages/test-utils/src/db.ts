import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { type AnyRelations, type EmptyRelations, TransactionRollbackError } from 'drizzle-orm'
import type { PgAsyncTransaction } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/** Transaction type produced by relations-aware createTestDb */
export type TestTransaction<TRelations extends AnyRelations = EmptyRelations> = PgAsyncTransaction<
  PostgresJsQueryResultHKT,
  TRelations
>

export interface TestDbOptions<TRelations extends AnyRelations = EmptyRelations> {
  /** Relative path to Drizzle migrations folder (resolved from process.cwd()) */
  migrationsFolder?: string
  /** Drizzle relations (from `defineRelations()`) — pass to get typed `tx.query` */
  relations?: TRelations
  /**
   * Share the container across runs/packages via testcontainers `withReuse()`.
   * Defaults to `true` (fast). Set `false` for an isolated, disposable container
   * — required when the instance COMMITS state (e.g. real migrations), so it
   * can't leak into a reused container shared by other suites. With `reuse:
   * false`, `stopTestDb()` actually stops the container.
   */
  reuse?: boolean
}

export interface TestDb<TRelations extends AnyRelations = EmptyRelations> {
  withTestDb: (
    fn: (tx: PgAsyncTransaction<PostgresJsQueryResultHKT, TRelations>) => Promise<void>,
  ) => Promise<void>
  stopTestDb: () => Promise<void>
}

const registry = new Set<() => Promise<void>>()

/**
 * Creates an isolated test-database instance: its own Postgres container,
 * migration state, and transaction-rollback wrapper.
 *
 * Call multiple times for multi-database scenarios — each instance gets
 * its own container.
 *
 * @example
 * ```ts
 * // Relations-aware (typed `tx.query`)
 * import { relations } from '#app/lib/db/relations'
 * const { withTestDb } = createTestDb({ migrationsFolder: './drizzle', relations })
 *
 * // Relationless (for packages that don't define relations)
 * const { withTestDb } = createTestDb({ migrationsFolder: './drizzle' })
 * ```
 */
export function createTestDb<TRelations extends AnyRelations = EmptyRelations>(
  opts?: TestDbOptions<TRelations>,
): TestDb<TRelations> {
  let initPromise: Promise<StartedPostgreSqlContainer> | undefined
  let migratedPromise: Promise<void> | undefined

  function getContainer(): Promise<StartedPostgreSqlContainer> {
    if (!initPromise) {
      const base = new PostgreSqlContainer('postgres:17').withTmpFs({
        '/var/lib/postgresql/data': 'rw',
      })
      initPromise = (opts?.reuse === false ? base : base.withReuse()).start()
      initPromise.catch(() => {
        initPromise = undefined
      })
    }
    return initPromise
  }

  function runMigrations(connectionString: string): Promise<void> {
    if (!migratedPromise) {
      migratedPromise = (async () => {
        const folder = opts?.migrationsFolder
          ? resolve(process.cwd(), opts.migrationsFolder)
          : undefined
        if (folder && existsSync(folder)) {
          const client = postgres(connectionString)
          const db = drizzle({ client })
          try {
            // Advisory lock serialises migrations across parallel test processes
            // that share the same container via withReuse(). Without the lock,
            // two processes can both see __drizzle_migrations as empty and race
            // to CREATE TABLE, causing a "duplicate key in pg_type" failure.
            await client`SELECT pg_advisory_lock(7354219803490734)`
            try {
              await migrate(db, { migrationsFolder: folder })
            } finally {
              await client`SELECT pg_advisory_unlock(7354219803490734)`
            }
          } finally {
            await client.end().catch(() => {})
          }
        }
      })()
      migratedPromise.catch(() => {
        migratedPromise = undefined
      })
    }
    return migratedPromise
  }

  async function withTestDb(
    fn: (tx: PgAsyncTransaction<PostgresJsQueryResultHKT, TRelations>) => Promise<void>,
  ): Promise<void> {
    const container = await getContainer()
    const connectionString = container.getConnectionUri()
    await runMigrations(connectionString)
    const client = postgres(connectionString)
    const db = opts?.relations
      ? drizzle({ client, relations: opts.relations })
      : drizzle({ client })

    let testError: unknown

    try {
      await db.transaction(async (tx) => {
        try {
          await fn(tx as PgAsyncTransaction<PostgresJsQueryResultHKT, TRelations>)
        } catch (e) {
          testError = e
        }
        tx.rollback()
      })
    } catch (e) {
      if (!(e instanceof TransactionRollbackError)) {
        throw e
      }
    } finally {
      try {
        await client.end()
      } catch {
        // teardown failure must not mask the original test error
      }
    }

    if (testError) {
      throw testError
    }
  }

  async function stopTestDb(): Promise<void> {
    // Reused containers (the default) are intentionally kept alive across runs
    // and packages — calling `container.stop()` would defeat reuse and cause a
    // "marked for removal" race when a sibling package re-attaches; the
    // testcontainers reaper (Ryuk) culls them after the grace period.
    //
    // A non-reused container (`reuse: false`) is private to this instance, so
    // we stop it here to dispose of any state it committed (e.g. migrations).
    const promise = initPromise
    if (promise) {
      try {
        const container = await promise
        if (opts?.reuse === false) await container.stop()
      } finally {
        initPromise = undefined
        migratedPromise = undefined
        registry.delete(stopTestDb)
      }
    }
  }

  registry.add(stopTestDb)
  return { withTestDb, stopTestDb }
}

// Default instance (no migrations) — backward-compatible exports
const defaultInstance = createTestDb()

export const { withTestDb, stopTestDb } = defaultInstance

/**
 * Stops all containers created by any createTestDb instance.
 * Used in globalSetup teardown.
 */
export async function stopAllTestDbs(): Promise<void> {
  const stops = [...registry].map((stop) => stop())
  await Promise.allSettled(stops)
  registry.clear()
}
