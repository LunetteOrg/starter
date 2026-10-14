import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
