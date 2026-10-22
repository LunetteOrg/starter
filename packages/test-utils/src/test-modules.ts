import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { globSync } from 'glob'

/** Where the rules these guards enforce are recorded. */
export const TEST_GUARDS_RECORD = 'https://github.com/LunetteOrg/starter/blob/main/docs/adr/test-guards.md'

/**
 * Not test code: installed or built output, Playwright's `e2e/` (no vitest registry),
 * probes kept under `__fixtures__`, and directories vitest writes screenshots into.
 * Relative to the directory scanned: inside a workspace, never the workspace's own
 * name, so `packages/build` or `apps/e2e` is scanned like any other.
 */
const NOT_SCANNED = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/e2e/**',
  '**/storybook-static/**',
  '**/.react-router/**',
  '**/__fixtures__/**',
  '**/__screenshots__/**',
  '**/*.d.ts',
]

/**
 * The modules a test run loads as tests or test support: specs and tests, stories, a
 * `*-kit.ts(x)` next to them, and any module under a `test/` directory. A helper they
 * import shares the worker's module registry with the spec, so it obeys the same rules.
 */
const TEST_MODULES = [
  '**/*.{spec,test}.{ts,tsx,mts,cts}',
  '**/*.stories.{ts,tsx}',
  '**/*-kit.{ts,tsx}',
  '**/test/**/*.{ts,tsx,mts,cts}',
]

/** The workspaces of a project: `apps/*` and `packages/*` with a `package.json`, as `apps/web`. */
export function workspaces(root: string): string[] {
  return globSync(['apps/*/', 'packages/*/'], { cwd: root })
    .map((name) => name.replace(/\/$/, ''))
    .filter((name) => existsSync(resolve(root, name, 'package.json')))
    .sort()
}

/** The test modules under `dir`, relative to it and sorted. `ignore` globs are relative to `dir`. */
export function testModules(dir: string, ignore: string[] = []): string[] {
  return scan(dir, TEST_MODULES, ignore)
}

/**
 * The test modules of `workspace` (`apps/web`) of `root`, relative to the workspace.
 * `ignore` globs are relative to `root`.
 */
export function workspaceTestModules(root: string, workspace: string, ignore: string[] = []): string[] {
  const below = (glob: string) => `${workspace}/${glob}`
  return scan(root, TEST_MODULES.map(below), ignore, NOT_SCANNED.map(below)).map((path) =>
    path.slice(workspace.length + 1),
  )
}

/** Every test module of every workspace of `root`, relative to `root`. `ignore` globs are relative to `root`. */
export function projectTestModules(root: string, ignore: string[] = []): string[] {
  return workspaces(root).flatMap((workspace) =>
    workspaceTestModules(root, workspace, ignore).map((path) => `${workspace}/${path}`),
  )
}

function scan(cwd: string, globs: string[], ignore: string[], notScanned: string[] = NOT_SCANNED): string[] {
  return globSync(globs, { cwd, nodir: true, posix: true, ignore: [...notScanned, ...ignore] }).sort()
}

/** The 1-based line of `index` in `source`. */
export function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}
