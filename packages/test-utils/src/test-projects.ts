import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { TEST_GUARDS_RECORD } from './test-modules.ts'
import { workspaceRoot } from './workspace.ts'

export interface TestProjectPackage {
  /** The test project's name, `(root)` for the config's own `test.include`. */
  project: string
  /** The include glob, or `(default)` for a project that keeps vitest's include under its `root` or `test.dir`. */
  include: string
  /** The name of the package the include points into. */
  pkg: string
}

type Manifest = { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
type TestOptions = { name?: string | { label?: string }; dir?: string; include?: string[]; projects?: unknown[] }
type ProjectConfig = { root?: string; test?: TestOptions }

const GLOB_CHARS = /[*?[\]{}()!]/
/** How a project with no `include` is reported: it keeps vitest's default. */
const DEFAULT_INCLUDE = '(default)'

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

/** The part of a glob before its first wildcard: the directory it can only match under. */
function staticPrefix(glob: string): string {
  const parts = glob.split('/')
  const end = parts.findIndex((part) => GLOB_CHARS.test(part))
  return parts.slice(0, end === -1 ? parts.length - 1 : end).join('/')
}

function label(name: TestOptions['name']): string {
  if (typeof name === 'string') return name
  return name?.label ?? '(unnamed)'
}

/**
 * The packages of the project that `config`'s tests include from outside `workspace`:
 * each inline project's `test.include`, and the config's own when it has no projects.
 * A project with no `include` keeps vitest's default under its `root` (and `test.dir`),
 * which is then the directory it points at. An include whose fixed part stops above a
 * package (`../../packages/{ui,icons}/**`) throws: it cannot be mapped to one package.
 * Projects given as paths (`'packages/*'`) are configs of their own and are not read.
 * Pass the config object a `vitest.config.ts` exports (`import config from '../vitest.config.ts'`).
 */
export function testProjectPackages(workspace: string, config: unknown): TestProjectPackage[] {
  if (typeof config === 'function') throw new Error('testProjectPackages: pass the config object, not a function')
  const root = workspaceRoot(workspace)
  const own = (config ?? {}) as ProjectConfig
  const inline = (own.test?.projects ?? []).filter(
    (project): project is ProjectConfig => typeof project === 'object' && project !== null,
  )
  const projects = inline.length > 0 ? inline : [{ ...own, test: { ...own.test, name: own.test?.name ?? '(root)' } }]
  return projects.flatMap((project) => {
    const base = resolve(workspace, project.root ?? '.')
    const includes = project.test?.include
    const targets: [include: string, target: string][] =
      includes === undefined
        ? [[DEFAULT_INCLUDE, resolve(base, project.test?.dir ?? '.')]]
        : includes
            .filter((include) => !include.startsWith('!'))
            .map((include) => [include, resolve(base, staticPrefix(include))])
    return targets.flatMap(([include, target]) => {
      const path = relative(root, target)
      if (target === resolve(workspace) || path.startsWith('..')) return []
      const [group, name] = path === '' ? [] : path.split(sep)
      if (group === undefined || ((group === 'apps' || group === 'packages') && name === undefined)) {
        throw new Error(
          `testProjectPackages: project "${label(project.test?.name)}" includes "${include}", ` +
            'which spans several packages: write one include per package',
        )
      }
      if ((group !== 'apps' && group !== 'packages') || name === undefined) return []
      const dir = join(root, group, name)
      if (resolve(dir) === resolve(workspace) || !existsSync(join(dir, 'package.json'))) return []
      return [{ project: label(project.test?.name), include, pkg: readManifest(dir).name ?? `${group}/${name}` }]
    })
  })
}

/**
 * Every package a test project of `workspace` includes files from is among the
 * workspace's dependencies or devDependencies, so the runner resolves what those tests
 * import and a task cache keyed on the workspace's dependencies (turbo) reruns them
 * when only that package changes.
 *
 * @example
 * ```ts
 * // apps/design-system/src/test-projects.spec.ts
 * import config from '../vitest.config.ts'
 * it('every package a test project includes is a dependency', () => {
 *   assertTestProjectsAreDependencies(resolve(__dirname, '..'), config)
 * })
 * ```
 */
export function assertTestProjectsAreDependencies(workspace: string, config: unknown): void {
  const pointers = testProjectPackages(workspace, config)
  if (pointers.length === 0) {
    throw new Error(
      `assertTestProjectsAreDependencies: no test project includes another package's files in ${workspace}: ` +
        'nothing to guard, or the config was not read',
    )
  }
  const manifest = readManifest(workspace)
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  const missing = pointers.filter(({ pkg }) => !declared.has(pkg))
  if (missing.length > 0) {
    throw new Error(
      `Test projects of ${manifest.name ?? workspace} include packages its package.json does not declare:\n` +
        missing.map(({ project, pkg }) => `  - project "${project}" → "${pkg}": "workspace:*"`).join('\n') +
        `\nAdd each to devDependencies. See ${TEST_GUARDS_RECORD} (test projects).`,
    )
  }
}
