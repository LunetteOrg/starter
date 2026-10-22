import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { type AnyRelations, type EmptyRelations, TransactionRollbackError } from 'drizzle-orm'
import type { PgAsyncTransaction } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { type TestAPI, test } from 'vitest'
import { WORKSPACE_LABEL, workspaceRoot } from './workspace.ts'

export { WORKSPACE_LABEL, workspaceRoot }

/** Transaction type produced by a relations-aware createTestDb. */
export type TestTransaction<TRelations extends AnyRelations = EmptyRelations> = PgAsyncTransaction<
  PostgresJsQueryResultHKT,
  TRelations
>

/** The Postgres every test server runs: the major of the Lunette template. */
export const POSTGRES_IMAGE = 'postgres:17'

/**
 * The test Postgres, not yet started, labelled with the workspace. The tmpfs goes on
 * the image's DECLARED volume, which holds `PGDATA`: `/var/lib/postgresql/data` up to
 * 17. From 18 the volume is `/var/lib/postgresql` and the old path makes the
 * entrypoint refuse to start; at the next major read both off `docker image inspect`
 * (`.Config.Volumes`, `PGDATA` in `.Config.Env`).
 */
export function postgresContainer(): PostgreSqlContainer {
  return new PostgreSqlContainer(POSTGRES_IMAGE)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withLabels({ [WORKSPACE_LABEL]: workspaceRoot() })
}

/**
 * Whether this process has a test server: `testDbPlugin()`'s globalSetup publishes
 * one as `TEST_DATABASE_URL`, or none when Docker is missing locally. Database suites
 * skip on it: `describe.skipIf(!hasTestDatabase())`.
 */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.TEST_DATABASE_URL)
}

export interface TestDbOptions<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * The database this instance owns on the run's server, created on first use. All
   * instances of a run share one Postgres; the name keeps their schema and their
   * `__drizzle_migrations` journal apart. One per app or one per test file is the
   * project's choice. A plain lower-case identifier.
   */
  databaseName: string
  /**
   * Drizzle migrations folder, resolved from `process.cwd()` (the package vitest
   * runs in). A path that does not exist fails at `createTestDb()`.
   */
  migrationsFolder?: string
  /** Drizzle relations (from `defineRelations()`), for a typed `tx.query`. */
  relations?: TRelations
  /** A server to use instead of `TEST_DATABASE_URL`: one the caller manages. */
  serverUrl?: string
}

export interface TestDb<TRelations extends AnyRelations = EmptyRelations> {
  /** Runs `fn` in a transaction on the migrated database and rolls it back. */
  withTestDb: (fn: (tx: TestTransaction<TRelations>) => Promise<void>) => Promise<void>
  /**
   * The URL of this instance's database, migrated. For a test that must commit, such
   * as two transactions racing on connections of their own: what it commits stays,
   * so it removes its rows itself.
   */
  connectionString: () => Promise<string>
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]*$/
const CREATE_DATABASE_LOCK = 7354219803490735
const MIGRATE_LOCK = 7354219803490734

/** A promise made on first `get()` and kept; a rejected one is dropped, so the next call retries. */
function cached<T>(make: () => Promise<T>) {
  let promise: Promise<T> | undefined
  return {
    get(): Promise<T> {
      if (!promise) {
        const made = make()
        promise = made
        made.catch(() => {
          if (promise === made) promise = undefined
        })
      }
      return promise
    },
  }
}

/**
 * Fail loudly on a migrations folder that does not exist. Skipping it would run the
 * suite on an empty schema (`relation "…" does not exist`, read as a schema bug) or,
 * on a server that outlived its run, go green on migrations never applied.
 */
function resolveMigrationsFolder(migrationsFolder: string): string {
  const folder = resolve(process.cwd(), migrationsFolder)
  if (!existsSync(folder)) {
    throw new Error(
      `createTestDb: migrations folder not found.\n` +
        `  migrationsFolder: ${migrationsFolder}\n` +
        `  resolved to:      ${folder}\n` +
        `  cwd:              ${process.cwd()}\n` +
        `The path is resolved from the cwd of the vitest process (the package directory), ` +
        `not from the test file. Fix the path, or drop \`migrationsFolder\` if this suite has ` +
        `no migrations to apply.`,
    )
  }
  return folder
}

/**
 * An isolated test database: its own database on the run's Postgres, its own
 * migrations, and a rollback around each test.
 *
 * It never starts a server. `testDbPlugin()`'s globalSetup starts one Postgres for
 * the vitest process, publishes it as `TEST_DATABASE_URL` and removes it at the end:
 * the container's lifecycle has that one owner, and there is nothing for a test file
 * to stop. Without the plugin, a `serverUrl` or `TEST_DATABASE_URL`, `withTestDb` and
 * `connectionString` reject, naming the plugin. Construction itself needs no server,
 * so a suite that skips on `hasTestDatabase()` still loads without Docker.
 *
 * @example
 * ```ts
 * import { relations } from '#app/lib/db/relations'
 * const db = createTestDb({ databaseName: 'web', migrationsFolder: './drizzle', relations })
 * export const it = txTest(db.withTestDb)
 * ```
 */
export function createTestDb<TRelations extends AnyRelations = EmptyRelations>(
  opts: TestDbOptions<TRelations>,
): TestDb<TRelations> {
  const databaseName = opts?.databaseName
  // `CREATE DATABASE` takes an identifier, which cannot be a bound parameter: the name
  // is concatenated, so it is checked first.
  if (typeof databaseName !== 'string' || !DATABASE_NAME.test(databaseName)) {
    throw new Error(`createTestDb: databaseName must match ${DATABASE_NAME}, got ${JSON.stringify(databaseName)}`)
  }
  // At construction: a wrong path fails at once, with or without Docker.
  const migrationsFolder = opts.migrationsFolder ? resolveMigrationsFolder(opts.migrationsFolder) : undefined

  /** Read on use, not at construction: the globalSetup publishes it before the tests run. */
  function serverUrl(): Promise<string> {
    const given = opts.serverUrl ?? process.env.TEST_DATABASE_URL
    if (given) return Promise.resolve(given)
    return Promise.reject(
      new Error(
        `createTestDb(${JSON.stringify(databaseName)}): no test server.\n` +
          `Mount testDbPlugin() from '@lntt/test-utils/plugin' in this package's vitest config: ` +
          `its globalSetup starts the run's Postgres and publishes it as TEST_DATABASE_URL. ` +
          `Or pass \`serverUrl\`, or set TEST_DATABASE_URL to a server you manage. ` +
          `A suite that must run without Docker skips on hasTestDatabase().`,
      ),
    )
  }

  /** The server URL repointed at this instance's database, created once under a lock. */
  const databaseUrl = cached(async () => {
    const base = await serverUrl()
    const admin = postgres(base, { max: 1 })
    try {
      // Every worker of the run shares the server; the lock serialises the check and
      // the CREATE.
      await admin`SELECT pg_advisory_lock(${CREATE_DATABASE_LOCK})`
      try {
        const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`
        if (exists.length === 0) await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
      } finally {
        // A failing unlock must not replace the error that explains the failure; the
        // lock is session-scoped and falls with the connection anyway.
        await admin`SELECT pg_advisory_unlock(${CREATE_DATABASE_LOCK})`.catch(() => {})
      }
    } finally {
      await admin.end().catch(() => {})
    }
    const url = new URL(base)
    url.pathname = `/${databaseName}`
    return url.toString()
  })

  const migrated = cached(async () => {
    if (!migrationsFolder) return
    // `max: 1`: the advisory lock is session-scoped, so lock and unlock must land on
    // the same connection. With a pool the unlock could leave on another one.
    const client = postgres(await databaseUrl.get(), { max: 1 })
    try {
      // Two workers can both see `__drizzle_migrations` empty and race to CREATE TABLE
      // ("duplicate key in pg_type"); the lock serialises them.
      await client`SELECT pg_advisory_lock(${MIGRATE_LOCK})`
      try {
        await migrate(drizzle({ client }), { migrationsFolder })
      } finally {
        await client`SELECT pg_advisory_unlock(${MIGRATE_LOCK})`.catch(() => {})
      }
    } finally {
      await client.end().catch(() => {})
    }
  })

  async function connectionString(): Promise<string> {
    await migrated.get()
    return databaseUrl.get()
  }

  async function withTestDb(fn: (tx: TestTransaction<TRelations>) => Promise<void>): Promise<void> {
    const client = postgres(await connectionString())
    const db = opts.relations ? drizzle({ client, relations: opts.relations }) : drizzle({ client })
    let testError: unknown
    let failed = false
    try {
      await db.transaction(async (tx) => {
        try {
          await fn(tx as TestTransaction<TRelations>)
        } catch (e) {
          failed = true
          testError = e
        }
        tx.rollback()
      })
    } catch (e) {
      if (!(e instanceof TransactionRollbackError)) throw e
    } finally {
      // A teardown failure must not mask the test's own error.
      await client.end().catch(() => {})
    }
    if (failed) throw testError
  }

  return { withTestDb, connectionString }
}

/**
 * The transaction as a Vitest fixture: a test asks for `tx` in its signature, and its
 * writes are rolled back when it ends. An app builds its `it` once and its
 * integration tests use that one:
 *
 * ```ts
 * export const it = txTest(db.withTestDb)
 * it('publishes a draft', async ({ tx }) => { … })
 * ```
 *
 * Lazy: a test that does not destructure `tx` opens no transaction. Vitest resolves
 * `use` only once the test body is over, passed or failed, so the rollback inside
 * `withDb` runs in both cases. `withTestDb` stays runner-agnostic: this is the only
 * code that knows `test.extend`.
 */
export function txTest<Tx extends object>(
  withDb: (fn: (tx: Tx) => Promise<void>) => Promise<void>,
): TestAPI<{ tx: Tx }> {
  return test.extend<{ tx: Tx }>({
    // biome-ignore lint/correctness/noEmptyPattern: Vitest reads a fixture's dependencies from its first parameter and requires an object pattern there, even an empty one
    tx: async ({}, use) => {
      await withDb(use)
    },
  })
}

/**
 * Internal to the globalSetup's teardown, which calls it; not exported from the
 * package. A no-op: no `createTestDb` instance starts a container, so there is
 * nothing here to stop, and the globalSetup removes the server it started itself.
 */
export async function stopAllTestDbs(): Promise<void> {}
