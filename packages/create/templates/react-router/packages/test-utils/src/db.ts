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
   * Dedicated database NAME inside the (reused) container. Two `createTestDb`
   * instances that share a reused container would otherwise share one Postgres
   * database — and one `__drizzle_migrations` journal — so an instance that
   * applies migrations (committed, outside the rollback wrapper) would leak that
   * state to siblings. Passing a distinct name isolates this instance's schema
   * and migration journal in its own database on the same server, without
   * stopping the shared container (ADR-0004 — test database isolation).
   */
  databaseName?: string
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
      initPromise = new PostgreSqlContainer('postgres:17')
        .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
        .withReuse()
        .start()
      initPromise.catch(() => {
        initPromise = undefined
      })
    }
    return initPromise
  }

  let connectionStringPromise: Promise<string> | undefined

  /**
   * Resolve this instance's connection string. Without `databaseName` it is the
   * container's default URI. With it, the named database is created once on the
   * container (idempotent, advisory-locked to serialise parallel processes that
   * share the reused container) and the URI is repointed at it — isolating this
   * instance's schema + migration journal from any sibling instance (ADR-0004 — test database isolation).
   */
  function getConnectionString(): Promise<string> {
    if (!connectionStringPromise) {
      connectionStringPromise = (async () => {
        const container = await getContainer()
        const baseUri = container.getConnectionUri()
        if (!opts?.databaseName) return baseUri

        const admin = postgres(baseUri, { max: 1 })
        try {
          await admin`SELECT pg_advisory_lock(7354219803490735)`
          try {
            const exists = await admin`
              SELECT 1 FROM pg_database WHERE datname = ${opts.databaseName}
            `
            if (exists.length === 0) {
              await admin.unsafe(`CREATE DATABASE "${opts.databaseName}"`)
            }
          } finally {
            await admin`SELECT pg_advisory_unlock(7354219803490735)`
          }
        } finally {
          await admin.end().catch(() => {})
        }

        const url = new URL(baseUri)
        url.pathname = `/${opts.databaseName}`
        return url.toString()
      })()
      connectionStringPromise.catch(() => {
        connectionStringPromise = undefined
      })
    }
    return connectionStringPromise
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
    const connectionString = await getConnectionString()
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
    // The container is started with `.withReuse()`, which intentionally keeps it
    // alive across test runs (and across packages running their tests in
    // parallel). Calling `container.stop()` here would defeat reuse and cause a
    // "marked for removal" race when a sibling package later attaches to the
    // same labeled container. Cleanup is delegated to the testcontainers reaper
    // (Ryuk), which culls non-reused containers at session end (ADR-0004 — test database isolation).
    const promise = initPromise
    if (promise) {
      try {
        await promise
      } finally {
        initPromise = undefined
        migratedPromise = undefined
        connectionStringPromise = undefined
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
