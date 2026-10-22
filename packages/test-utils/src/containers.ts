import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { globSync } from 'glob'
import { blankCommentsAndStrings } from './source-scan.ts'

/**
 * What needs a container: testcontainers used directly and `postgresContainer` start
 * one; `createTestDb` starts none but needs the server `testDbPlugin()` starts.
 * Matched on code only, comments and string literals blanked, so a package that merely
 * talks about `createTestDb` is not taken for a user.
 */
const STARTS_CONTAINERS = /\b(new\s+GenericContainer|new\s+PostgreSqlContainer|postgresContainer|createTestDb)\b/

/** A vitest config must CALL a plugin, not merely import or mention it. */
const MOUNTS_PLUGIN = /\b(testDbPlugin|ryukDisabledPlugin)\s*\(/

/**
 * `nodir`: a name matching `*.tsx` is not proof of a file. Vitest's visual suite writes
 * screenshots into a DIRECTORY named after the spec, and reading it dies with EISDIR.
 */
const NOT_SOURCE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.react-router/**', '**/__screenshots__/**']

export interface ContainerUser {
  /** The workspace, relative to the root: `apps/web`, `packages/db`. */
  name: string
  /** Whether one of its vitest configs calls `testDbPlugin()` or `ryukDisabledPlugin()`. */
  mountsPlugin: boolean
}

function code(file: string): string {
  return blankCommentsAndStrings(readFileSync(file, 'utf8'))
}

/** Every workspace under `apps/*` and `packages/*` of `root` whose sources start containers. */
export function containerUsers(root: string): ContainerUser[] {
  return globSync(['apps/*/', 'packages/*/'], { cwd: root })
    .map((name) => name.replace(/\/$/, ''))
    .filter((name) => existsSync(resolve(root, name, 'package.json')))
    .sort()
    .flatMap((name) => {
      const dir = resolve(root, name)
      const sources = globSync('**/*.{ts,tsx,mts,cts}', { cwd: dir, absolute: true, nodir: true, ignore: NOT_SOURCE })
      if (!sources.some((file) => STARTS_CONTAINERS.test(code(file)))) return []
      const configs = globSync('vitest*.config.{ts,mts,js,mjs}', { cwd: dir, absolute: true, nodir: true })
      return [{ name, mountsPlugin: configs.some((file) => MOUNTS_PLUGIN.test(code(file))) }]
    })
}

/**
 * The rule that arms itself: a workspace that needs containers without mounting one
 * of the plugins fails. Without it, a package on `createTestDb` has no server: its
 * database suites reject, or skip on `hasTestDatabase()` and go green on nothing. A
 * package on testcontainers directly leaves a Postgres per worker, none stopped,
 * found days later.
 *
 * @example
 * ```ts
 * // meta-containers.spec.ts, at a place that knows the project root
 * it('every package that starts containers disables Ryuk', () => {
 *   assertContainerUsersMountAPlugin(resolve(__dirname, '..'))
 * })
 * ```
 */
export function assertContainerUsersMountAPlugin(root: string): void {
  const missing = containerUsers(root).filter((user) => !user.mountsPlugin)
  if (missing.length > 0) {
    throw new Error(
      'These workspaces start containers without mounting testDbPlugin() or ryukDisabledPlugin() ' +
        `in a vitest config:\n${missing.map((m) => `  - ${m.name}`).join('\n')}`,
    )
  }
}
