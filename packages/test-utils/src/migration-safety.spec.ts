import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertNoMigrationSafetyViolations, checkMigration } from './migration-safety'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')

describe('checkMigration', () => {
  it('passes a plain expand migration', () => {
    const sql = 'ALTER TABLE users ADD COLUMN email text;'
    expect(checkMigration('0001_add_email/migration.sql', sql)).toEqual([])
  })

  it('flags an unannotated DROP', () => {
    const sql = 'ALTER TABLE users DROP COLUMN legacy_email;'
    const v = checkMigration('0002_drop/migration.sql', sql)
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toMatch(/contract step/)
  })

  it('flags an unannotated RENAME', () => {
    const sql = 'ALTER TABLE users RENAME COLUMN email TO email_address;'
    expect(checkMigration('0003_rename/migration.sql', sql)).toHaveLength(1)
  })

  it('allows a DROP annotated as a contract step', () => {
    const sql =
      '-- contract: drop legacy_email, nothing reads it since v3\nALTER TABLE users DROP COLUMN legacy_email;'
    expect(checkMigration('0004_contract/migration.sql', sql)).toEqual([])
  })

  it('forbids a down-migration regardless of content', () => {
    const v = checkMigration('0005_init.down.sql', 'SELECT 1;')
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toMatch(/down-migrations are forbidden/)
  })
})

describe('repo migrations', () => {
  // Self-arming: no migrations today → scans nothing → passes. Guards every
  // real migration the moment one lands (ADR-0007, ADR-0019).
  it('have no safety violations', async () => {
    await assertNoMigrationSafetyViolations(REPO_ROOT)
  })
})
