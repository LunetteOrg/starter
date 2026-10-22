import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// No dependency beyond Node: `lntt-clean-test` imports this module, and so does a suite
// that labels its own containers (`@lntt/test-utils/workspace`), and neither must load
// testcontainers, postgres or the drizzle peer to find a label.

/**
 * Label stamped on every container a project's tests start, valued with the workspace
 * it belongs to: the Postgres this package starts, and any other container, which
 * `assertContainerRules` requires to carry it in its builder chain. It is what makes a
 * cleanup safe: culling by image would destroy other projects' containers.
 * `lntt-clean-test` culls by this label only.
 *
 * @example
 * ```ts
 * import { WORKSPACE_LABEL, workspaceRoot } from '@lntt/test-utils/workspace'
 * new GenericContainer('vault').withLabels({ [WORKSPACE_LABEL]: workspaceRoot() })
 * ```
 */
export const WORKSPACE_LABEL = 'com.lntt.workspace'

/**
 * The root of the checkout a process belongs to: the nearest ancestor holding
 * `pnpm-workspace.yaml`, not the package directory vitest runs from. In a git
 * worktree it is the worktree. `lntt-clean-test` derives its default scope from the
 * same function, so the label and the cleanup cannot disagree.
 */
export function workspaceRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(from)
    dir = parent
  }
}
