import { readFile } from 'node:fs/promises'
import { glob } from 'glob'
import { expect } from 'vitest'

/**
 * Mechanizes the migration review red-flags from ADR-0007 / ADR-0019 so they
 * don't rely on a human catching them:
 *
 *  - **No down-migrations.** Rollback is "don't deploy", never a DB revert
 *    (ADR-0007). A `*.down.sql` file or a `down/` folder is always forbidden.
 *  - **Risky statements must be acknowledged per statement.** `DROP` / `RENAME`
 *    / `SET NOT NULL` / `ALTER … TYPE` / `TRUNCATE` / `DELETE` can break a
 *    rolling deploy. Each such statement must carry a `-- contract:` (a
 *    contract-phase removal) or `-- destructive:` (any other reviewed risky op)
 *    annotation in its own statement; otherwise it must be split into
 *    expand/migrate/contract.
 *
 * It is a guard rail, not a SQL parser: detection masks comments and string
 * literals (so a keyword inside them is not a false positive) and splits on
 * `;`, but unusual formatting can still fool it. Tighten if a real migration
 * slips through.
 *
 * Pure function over (name, content) so it is unit-testable without touching the
 * filesystem; {@link assertNoMigrationSafetyViolations} applies it across the repo.
 */
export interface MigrationViolation {
  file: string
  reason: string
}

const DOWN_MIGRATION = /(^|\/)down(\/|\.)|\.down\.sql$/i

// Statements that can break a rolling/blue-green deploy (ADR-0007). Evaluated
// per statement against a comment/string-masked copy, so matches are real SQL.
const RISKY =
  /\b(?:DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX|SCHEMA|TYPE|VIEW)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[\s\S]*?\bRENAME\b|ALTER\s+COLUMN[\s\S]*?\b(?:SET\s+NOT\s+NULL|TYPE)\b)\b/i

const ANNOTATION = /--\s*(?:contract|destructive)\b/i

const blank = (s: string) => ' '.repeat(s.length)

/**
 * Replace block comments, line comments, and string/identifier literals with
 * spaces, preserving length and offsets so the masked copy can be sliced in
 * lockstep with the original.
 */
function maskForDetection(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/'(?:''|[^'])*'/g, blank)
    .replace(/"(?:""|[^"])*"/g, blank)
}

export function checkMigration(file: string, content: string): MigrationViolation[] {
  const violations: MigrationViolation[] = []

  if (DOWN_MIGRATION.test(file)) {
    violations.push({
      file,
      reason: 'down-migrations are forbidden — rollback is "don\'t deploy" (ADR-0007).',
    })
  }

  // Split into statements on the masked copy so a `;` inside a string/comment
  // doesn't create a spurious boundary. Each range carries its own leading
  // comments, so an annotation only acknowledges the statement it precedes.
  const masked = maskForDetection(content)
  const ranges: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      ranges.push([start, i + 1])
      start = i + 1
    }
  }
  if (start < content.length) ranges.push([start, content.length])

  for (const [s, e] of ranges) {
    if (RISKY.test(masked.slice(s, e)) && !ANNOTATION.test(content.slice(s, e))) {
      violations.push({
        file,
        reason:
          'risky statement (DROP/RENAME/SET NOT NULL/ALTER TYPE/TRUNCATE/DELETE) ' +
          'must be acknowledged: annotate it with `-- contract: <reason>` ' +
          '(contract-phase removal) or `-- destructive: <reason>`, or split it ' +
          'into expand/migrate/contract (ADR-0007).',
      })
    }
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
