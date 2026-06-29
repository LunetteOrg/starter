import { readFile } from 'node:fs/promises'
import { glob } from 'glob'
import { expect } from 'vitest'

/**
 * Mechanizes the migration review red-flags from ADR-0007 / ADR-0019 so they
 * don't rely on a human catching them:
 *
 *  - **No down-migrations.** Rollback is "don't deploy", never a DB revert
 *    (ADR-0007). A `*.down.sql` file or a `down/` folder is always forbidden.
 *  - **Destructive statements must be an explicit contract step.** `DROP` /
 *    `RENAME` are legitimate in the contract phase but a red flag anywhere else.
 *    A migration containing them must declare intent with a `-- contract:`
 *    annotation; otherwise it must be split into expand/migrate/contract.
 *
 * Pure function over (name, content) so it is unit-testable without touching the
 * filesystem; {@link assertNoMigrationSafetyViolations} applies it across the repo.
 */
export interface MigrationViolation {
  file: string
  reason: string
}

const DESTRUCTIVE =
  /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|SCHEMA|TYPE|VIEW)\b|\bALTER\s+TABLE\b[\s\S]*?\bRENAME\b/i
const CONTRACT_ANNOTATION = /--\s*contract\b/i
const DOWN_MIGRATION = /(^|\/)down(\/|\.)|\.down\.sql$/i

export function checkMigration(file: string, content: string): MigrationViolation[] {
  const violations: MigrationViolation[] = []

  if (DOWN_MIGRATION.test(file)) {
    violations.push({
      file,
      reason: 'down-migrations are forbidden — rollback is "don\'t deploy" (ADR-0007).',
    })
  }

  if (DESTRUCTIVE.test(content) && !CONTRACT_ANNOTATION.test(content)) {
    violations.push({
      file,
      reason:
        'destructive statement (DROP/RENAME) must be an explicit contract step: ' +
        'annotate the migration with `-- contract: <reason>`, or split it into ' +
        'expand/migrate/contract (ADR-0007).',
    })
  }

  return violations
}

/**
 * Scans every migration in the repo and fails if any breaks the rules above.
 * Self-arming: with no migrations yet, it scans nothing and passes — and starts
 * guarding the moment the first `drizzle/` migration lands, without per-app setup.
 */
export async function assertNoMigrationSafetyViolations(repoRoot: string): Promise<void> {
  const files = await glob('**/drizzle/**/*.sql', {
    cwd: repoRoot,
    absolute: true,
    ignore: ['**/node_modules/**'],
  })

  const violations: MigrationViolation[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf-8')
    violations.push(...checkMigration(file, content))
  }

  expect(
    violations,
    `Migration safety violations (ADR-0007):\n${violations
      .map((v) => `  - ${v.file}: ${v.reason}`)
      .join('\n')}`,
  ).toEqual([])
}
