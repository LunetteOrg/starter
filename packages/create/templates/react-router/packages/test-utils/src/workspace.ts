import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// No dependency beyond Node: a suite that labels its own containers imports this
// module, and must not load testcontainers, postgres or drizzle to find a label.

/**
 * Label stamped on every container the tests start, valued with the workspace it
 * belongs to. It is what finds this checkout's test containers among every other
 * project's on the machine: `docker ps --filter "label=com.lntt.workspace=<root>"`.
 * Culling by image instead would destroy other projects' Postgres.
 */
export const WORKSPACE_LABEL = 'com.lntt.workspace'

/**
 * The root of the checkout a process belongs to: the nearest ancestor holding
 * `pnpm-workspace.yaml`, not the package directory vitest runs from. In a git
 * worktree it is the worktree.
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
