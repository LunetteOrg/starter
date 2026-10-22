import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'glob'
import { JSDOM_SETUP_PATH } from './jsdom-setup-path.ts'
import { blankCommentsAndStrings } from './source-scan.ts'

/**
 * An import in any syntax (side effect, `from`, dynamic, `require`), its specifier in
 * the second group; the jsdom setup is the specifier `JSDOM_SETUP_PATH` matches.
 * Matched on the raw source, kept only when the keyword is code (comments and strings
 * blanked), so a listing in `setupFiles` (a string) or a mention is not an import.
 */
const IMPORT = /\b(?:import|from|require)\s*\(?\s*(['"`])([^'"`\n]*)\1/g

/** The record of the rule, which the message cites: no project path holds it yet. */
export const VITEST_PRESET_RECORD = 'https://github.com/LunetteOrg/starter/blob/main/docs/adr/vitest-preset.md'

const NOT_SOURCE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.react-router/**']

export interface JsdomSetupImport {
  /** Relative to the root: `apps/web/test/setup.ts`. */
  file: string
  line: number
}

/**
 * Every import of this package's jsdom setup, by name or by a path `JSDOM_SETUP_PATH`
 * matches, in the workspaces under `apps/*` and `packages/*`, sorted by file
 * (code-unit order) and line.
 */
export function findJsdomSetupImports(root: string): JsdomSetupImport[] {
  const workspaces = globSync(['apps/*/', 'packages/*/'], { cwd: root })
    .map((name) => name.replace(/\/$/, ''))
    .filter((name) => existsSync(join(root, name, 'package.json')))
  if (workspaces.length === 0) {
    throw new Error(`findJsdomSetupImports: no workspace with a package.json under apps/* or packages/* of ${root}`)
  }
  return (
    workspaces
      .flatMap((name) =>
        globSync('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', {
          cwd: join(root, name),
          absolute: true,
          nodir: true,
          ignore: NOT_SOURCE,
        }),
      )
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8')
        const code = blankCommentsAndStrings(source)
        return [...source.matchAll(IMPORT)]
          .filter(
            (match) => JSDOM_SETUP_PATH.test(match[2] ?? '') && code.startsWith(match[0].slice(0, 4), match.index),
          )
          .map((match) => ({ file: relative(root, path), line: source.slice(0, match.index).split('\n').length }))
      })
      // Code-unit order, the same on every machine: localeCompare follows the locale.
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
  )
}

/**
 * The jsdom setup is listed in `setupFiles`, never imported. Setup files run again for
 * every test file; a module they import runs once per worker, so under
 * `isolate: false` its hooks reach the first file of each worker and the rest leak
 * into one another. `appTest()` lists it; a config that does not use `appTest()`
 * lists `'@lntt/test-utils/jsdom-setup'` itself.
 *
 * @example
 * ```ts
 * // jsdom-setup.spec.ts, at a place that knows the project root
 * it('lists the jsdom setup, never imports it', () => {
 *   assertNoJsdomSetupImports(resolve(__dirname, '../../..'))
 * })
 * ```
 */
export function assertNoJsdomSetupImports(root: string): void {
  const found = findJsdomSetupImports(root)
  if (found.length > 0) {
    throw new Error(
      'These files import @lntt/test-utils/jsdom-setup: list it in setupFiles instead (appTest() does), ' +
        'or under isolate: false it tears down only the first file of each worker ' +
        `(${VITEST_PRESET_RECORD}):\n` +
        found.map((f) => `  - ${f.file}:${f.line}`).join('\n'),
    )
  }
}
