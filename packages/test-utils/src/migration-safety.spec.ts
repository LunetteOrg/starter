import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoMigrationSafetyViolations, checkMigration } from './migration-safety.ts'

describe('checkMigration', () => {
  it('passes a plain expand migration', () => {
    expect(checkMigration('0001_add_email/migration.sql', 'ALTER TABLE users ADD COLUMN email text;')).toEqual([])
  })

  it('does not flag DROP NOT NULL (making a column nullable is expand-safe)', () => {
    expect(checkMigration('0001/migration.sql', 'ALTER TABLE users ALTER COLUMN email DROP NOT NULL;')).toEqual([])
  })

  it('flags an unannotated DROP', () => {
    const v = checkMigration('0002_drop/migration.sql', 'ALTER TABLE users DROP COLUMN legacy_email;')
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toMatch(/risky statement/)
  })

  it('flags an unannotated RENAME, SET NOT NULL, ALTER TYPE, TRUNCATE, DELETE', () => {
    const samples = [
      'ALTER TABLE users RENAME COLUMN email TO email_address;',
      'ALTER TABLE users ALTER COLUMN email SET NOT NULL;',
      'ALTER TABLE users ALTER COLUMN age TYPE bigint;',
      'TRUNCATE users;',
      'DELETE FROM users;',
    ]
    for (const sql of samples) {
      expect(checkMigration('m/migration.sql', sql), sql).toHaveLength(1)
    }
  })

  it('allows a DROP annotated as a contract step', () => {
    const sql = '-- contract: drop legacy_email, nothing reads it since v3\nALTER TABLE users DROP COLUMN legacy_email;'
    expect(checkMigration('0004_contract/migration.sql', sql)).toEqual([])
  })

  it('allows a risky op annotated as reviewed destructive', () => {
    const sql = '-- destructive: backfill done in 0003, safe to delete\nDELETE FROM staging;'
    expect(checkMigration('0005/migration.sql', sql)).toEqual([])
  })

  it('annotation is per-statement: it does not whitewash a sibling statement', () => {
    const sql = [
      '-- contract: drop a, unread since v2',
      'ALTER TABLE t DROP COLUMN a;',
      'ALTER TABLE t DROP COLUMN b;', // unannotated — must still be flagged
    ].join('\n')
    const v = checkMigration('0006/migration.sql', sql)
    expect(v).toHaveLength(1)
  })

  it('does not false-positive on keywords inside strings or comments', () => {
    expect(checkMigration('0007/migration.sql', "INSERT INTO log (msg) VALUES ('DROP TABLE x');")).toEqual([])
    expect(
      checkMigration('0008/migration.sql', '-- TODO: maybe DROP TABLE old later\nALTER TABLE t ADD COLUMN c int;'),
    ).toEqual([])
  })

  it('forbids a down-migration regardless of content', () => {
    const v = checkMigration('0009_init.down.sql', 'SELECT 1;')
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toMatch(/down-migrations are forbidden/)
  })
})

describe('assertNoMigrationSafetyViolations', () => {
  // A project calls it on its own root; here a throwaway root holds the migrations.
  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'lntt-migrations-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }

  it('passes a repo with no migrations, and one with safe ones', async () => {
    await assertNoMigrationSafetyViolations(repo({}))
    await assertNoMigrationSafetyViolations(
      repo({ 'apps/web/drizzle/0001_add/migration.sql': 'ALTER TABLE users ADD COLUMN email text;' }),
    )
  })

  it('fails on a down-migration anywhere under a drizzle folder', async () => {
    const root = repo({ 'apps/web/drizzle/0001_init.down.sql': 'SELECT 1;' })
    await expect(assertNoMigrationSafetyViolations(root)).rejects.toThrow(/down-migrations are forbidden/)
  })
})
