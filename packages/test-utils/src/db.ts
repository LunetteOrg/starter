import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { ExtractTablesWithRelations, TablesRelationalConfig } from 'drizzle-orm'
import { TransactionRollbackError } from 'drizzle-orm'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/** Transaction type produced by schema-aware createTestDb */
export type TestTransaction<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends TablesRelationalConfig = ExtractTablesWithRelations<TSchema>,
> = PgTransaction<PostgresJsQueryResultHKT, TSchema, TRelations>

export interface TestDbOptions<TSchema extends Record<string, unknown> = Record<string, never>> {
  /** Relative path to Drizzle migrations folder (resolved from process.cwd()) */
  migrationsFolder?: string
  /** Drizzle schema — pass to get typed transactions */
  schema?: TSchema
}

export interface TestDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
  TRelations extends TablesRelationalConfig = ExtractTablesWithRelations<TSchema>,
> {
  withTestDb: (
    fn: (tx: PgTransaction<PostgresJsQueryResultHKT, TSchema, TRelations>) => Promise<void>,
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
 * // Schema-aware (typed transactions)
 * import * as schema from '#app/lib/db/schema'
 * const { withTestDb } = createTestDb({ migrationsFolder: './drizzle', schema })
 *
 * // Schemaless (for packages that don't have a schema)
 * const { withTestDb } = createTestDb({ migrationsFolder: './drizzle' })
 * ```
 */
export function createTestDb<TSchema extends Record<string, unknown> = Record<string, never>>(
  opts?: TestDbOptions<TSchema>,
): TestDb<TSchema> {
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

  function runMigrations(connectionString: string): Promise<void> {
    if (!migratedPromise) {
      migratedPromise = (async () => {
        const folder = opts?.migrationsFolder
          ? resolve(process.cwd(), opts.migrationsFolder)
          : undefined
        if (folder && existsSync(folder)) {
          const client = postgres(connectionString)
          const db = drizzle(client)
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
    fn: (
      tx: PgTransaction<PostgresJsQueryResultHKT, TSchema, ExtractTablesWithRelations<TSchema>>,
    ) => Promise<void>,
  ): Promise<void> {
    const container = await getContainer()
    const connectionString = container.getConnectionUri()
    await runMigrations(connectionString)
    const client = postgres(connectionString)
    const db = opts?.schema ? drizzle(client, { schema: opts.schema }) : drizzle(client)

    let testError: unknown

    try {
      await db.transaction(async (tx) => {
        try {
          await fn(
            tx as PgTransaction<
              PostgresJsQueryResultHKT,
              TSchema,
              ExtractTablesWithRelations<TSchema>
            >,
          )
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
    // The container is started with `.withReuse()`, which intentionally keeps
    // it alive across test runs (and across packages running their tests in
    // parallel). Calling `container.stop()` here would defeat reuse and cause
    // a "marked for removal" race when a sibling package later tries to attach
    // to the same labeled container. Cleanup is delegated to the testcontainers
    // reaper (Ryuk), which culls reused containers after the grace period.
    const promise = initPromise
    if (promise) {
      try {
        await promise
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
