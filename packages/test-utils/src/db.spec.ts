import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, workspaceRoot } from './db.ts'

/**
 * Unit tests: no Docker. The guards they cover fire at CONSTRUCTION, before anything
 * starts, so they hold on a machine with no container runtime; under a Docker skip
 * they would be the silent green they exist to abolish.
 */
describe('createTestDb at construction', () => {
  it('fails when migrationsFolder does not exist, naming the resolved path and the cwd', () => {
    let message = ''
    try {
      createTestDb({ databaseName: 'app', migrationsFolder: './does-not-exist' })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toMatch(/migrations folder not found/i)
    expect(message).toContain(resolve(process.cwd(), './does-not-exist'))
    expect(message).toContain(process.cwd())
  })

  it('accepts an existing migrations folder, and none at all', () => {
    const fixture = relative(process.cwd(), resolve(__dirname, '__fixtures__/migrations'))
    expect(() => createTestDb({ databaseName: 'app', migrationsFolder: fixture })).not.toThrow()
    expect(() => createTestDb({ databaseName: 'app' })).not.toThrow()
  })

  it('refuses a databaseName that is not a plain identifier', () => {
    for (const name of ['App', 'a-b', '1a', 'a"; drop database x; --', '']) {
      expect(() => createTestDb({ databaseName: name }), name).toThrow(/databaseName/)
    }
  })

  it('requires databaseName: without it the call does not compile', () => {
    // @ts-expect-error databaseName is required; `pnpm typecheck` fails if it is optional
    expect(() => createTestDb({})).toThrow(/databaseName/)
  })
})

/**
 * Where the server comes from, without one: a URL on a closed localhost port is
 * refused at once (`ECONNREFUSED`, with the port), so the error says which URL the
 * instance tried. Construction stays silent, for the suites that skip on
 * hasTestDatabase() without Docker.
 */
describe('createTestDb on use', () => {
  const NO_SERVER = /no test server[\s\S]*testDbPlugin\(\).*@lntt\/test-utils\/plugin/

  let published: string | undefined
  beforeEach(() => {
    published = process.env.TEST_DATABASE_URL
    delete process.env.TEST_DATABASE_URL
  })
  afterEach(() => {
    if (published === undefined) delete process.env.TEST_DATABASE_URL
    else process.env.TEST_DATABASE_URL = published
  })

  /** Ports nothing listens on: bound together so they differ, then released. */
  async function closedPorts(count: number): Promise<number[]> {
    const servers = Array.from({ length: count }, () => createServer())
    const ports = await Promise.all(
      servers.map(
        (server) =>
          new Promise<number>((done) => {
            server.listen(0, '127.0.0.1', () => {
              const address = server.address()
              done(typeof address === 'object' && address ? address.port : 0)
            })
          }),
      ),
    )
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))))
    return ports
  }

  const urlOn = (port: number) => `postgres://test:test@127.0.0.1:${port}/postgres`

  it('rejects without a server, naming testDbPlugin()', async () => {
    const db = createTestDb({ databaseName: 'app', serverUrl: undefined })
    await expect(db.withTestDb(async () => {})).rejects.toThrow(NO_SERVER)
    await expect(db.connectionString()).rejects.toThrow(/serverUrl.*TEST_DATABASE_URL/s)
  })

  it('treats an empty TEST_DATABASE_URL as no server', async () => {
    process.env.TEST_DATABASE_URL = ''
    await expect(createTestDb({ databaseName: 'app' }).connectionString()).rejects.toThrow(NO_SERVER)
  })

  it('connects to serverUrl, not to TEST_DATABASE_URL, when both are set', async () => {
    const [given, published] = (await closedPorts(2)) as [number, number]
    process.env.TEST_DATABASE_URL = urlOn(published)
    const db = createTestDb({ databaseName: 'app', serverUrl: urlOn(given) })
    await expect(db.connectionString()).rejects.toMatchObject({ code: 'ECONNREFUSED', port: given })
  })

  // The globalSetup publishes the server before the tests run: a first call that
  // found none must not stay rejected.
  it('finds a server published after a rejection', async () => {
    const [port] = (await closedPorts(1)) as [number]
    const db = createTestDb({ databaseName: 'app' })
    await expect(db.connectionString()).rejects.toThrow(NO_SERVER)
    process.env.TEST_DATABASE_URL = urlOn(port)
    await expect(db.connectionString()).rejects.toMatchObject({ code: 'ECONNREFUSED', port })
  })
})

describe('workspaceRoot', () => {
  it('is the nearest directory holding pnpm-workspace.yaml, not the package directory', () => {
    expect(workspaceRoot()).toBe(resolve(__dirname, '../../..'))
  })

  it('falls back to the starting directory outside a pnpm workspace', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-root-')))
    mkdirSync(join(dir, 'a/b'), { recursive: true })
    expect(workspaceRoot(join(dir, 'a/b'))).toBe(join(dir, 'a/b'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(workspaceRoot(join(dir, 'a/b'))).toBe(dir)
  })
})
