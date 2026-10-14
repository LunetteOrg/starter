import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// No dependency beyond Node: `lntt-clean-test` imports this module and must not load
// testcontainers, postgres or the drizzle peer to find a label.

/**
 * Label stamped on every Postgres this package starts, valued with the workspace it
 * belongs to. It is what makes a cleanup safe: culling by image would destroy other
 * projects' Postgres. `lntt-clean-test` culls by this label only.
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
