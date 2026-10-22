import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blankCommentsAndStrings } from './source-scan.ts'
import { lineAt, projectTestModules, TEST_GUARDS_RECORD } from './test-modules.ts'

/** A call of `withTestDb`, bare or as a method; passing it by reference is no call. */
const DIRECT_CALL = /\bwithTestDb\s*\(/g

export interface TxFixtureOptions {
  /** Globs relative to the root that are not scanned, on top of build output, `e2e/` and `__fixtures__/`. */
  ignore?: string[]
}

/**
 * The lines of `source` that call `withTestDb` directly. Comments and strings do not
 * count, and `txTest(db.withTestDb)`, which passes the function, is no call.
 */
export function findDirectTestDbCalls(source: string): number[] {
  const code = blankCommentsAndStrings(source)
  return [...code.matchAll(DIRECT_CALL)].map((match) => lineAt(code, match.index))
}

/**
 * Fails on every test module that reaches the test database by calling `withTestDb`
 * itself instead of taking `tx` from the fixture `txTest(db.withTestDb)` builds, in
 * the specs, tests, stories and test helpers (`*-kit.ts(x)`, anything under `test/`)
 * of the workspaces under `apps/*` and `packages/*` of `root`.
 *
 * @example
 * ```ts
 * it('integration tests take the transaction from the tx fixture', () => {
 *   assertTestsUseTxFixture(resolve(__dirname, '../../..'))
 * })
 * ```
 */
export function assertTestsUseTxFixture(root: string, options: TxFixtureOptions = {}): void {
  const files = projectTestModules(root, options.ignore)
  if (files.length === 0) {
    throw new Error(`assertTestsUseTxFixture: no test file found under apps/* or packages/* of ${root}`)
  }
  const offenders = files.flatMap((file) =>
    findDirectTestDbCalls(readFileSync(resolve(root, file), 'utf8')).map((line) => `  - ${file}:${line}`),
  )
  if (offenders.length > 0) {
    throw new Error(
      `These test modules call withTestDb directly:\n${offenders.join('\n')}\n` +
        'Build the fixture once, `export const it = txTest(db.withTestDb)` with txTest from @lntt/test-utils, ' +
        `and take the transaction in the test's signature: \`it('…', async ({ tx }) => …)\`. ` +
        `See ${TEST_GUARDS_RECORD} (tx fixture).`,
    )
  }
}
