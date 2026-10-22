import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeProject } from './probe-kit.ts'
import { assertTestProjectsAreDependencies, testProjectPackages } from './test-projects.ts'

function project(appManifest: object): string {
  return probeProject({
    'pnpm-workspace.yaml': 'packages: ["apps/*", "packages/*"]\n',
    'apps/design-system/package.json': JSON.stringify({ name: '@acme/design-system', ...appManifest }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
    'packages/icons/package.json': JSON.stringify({ name: '@acme/icons' }),
  })
}

const config = {
  test: {
    projects: [
      { test: { name: 'stories', include: ['src/**/*.stories.tsx', '../../packages/ui/src/**/*.stories.tsx'] } },
      { test: { name: { label: 'icons' }, include: ['../../packages/icons/src/**/*.test.ts'] } },
      { test: { name: 'own', include: ['**/*.spec.ts'] } },
      'packages/*',
    ],
  },
}

describe('testProjectPackages', () => {
  it('maps each include that points into another workspace to its package name', () => {
    const workspace = join(project({}), 'apps/design-system')
    expect(testProjectPackages(workspace, config)).toEqual([
      { project: 'stories', include: '../../packages/ui/src/**/*.stories.tsx', pkg: '@acme/ui' },
      { project: 'icons', include: '../../packages/icons/src/**/*.test.ts', pkg: '@acme/icons' },
    ])
  })

  it('reads a project that points at another package by its root, with the default include', () => {
    const workspace = join(project({}), 'apps/design-system')
    const byRoot = { test: { projects: [{ root: '../../packages/ui', test: { name: 'ui' } }] } }
    expect(testProjectPackages(workspace, byRoot)).toEqual([{ project: 'ui', include: '(default)', pkg: '@acme/ui' }])
    const byDir = { test: { projects: [{ test: { name: 'icons', dir: '../../packages/icons/src' } }] } }
    expect(testProjectPackages(workspace, byDir)).toEqual([
      { project: 'icons', include: '(default)', pkg: '@acme/icons' },
    ])
  })

  it('fails on an include that spans several packages, rather than skip it', () => {
    const workspace = join(project({}), 'apps/design-system')
    const braces = { test: { projects: [{ test: { name: 'all', include: ['../../packages/{ui,icons}/src/**'] } }] } }
    expect(() => testProjectPackages(workspace, braces)).toThrow(
      /project "all".*\.\.\/\.\.\/packages\/\{ui,icons\}.*one include per package/,
    )
  })

  it.each([
    ['../../libs/ui/src/**/*.test.ts', 'libs/ui/src'],
    ['../../packages/@acme/ui/src/**', 'packages/@acme/ui/src'],
    ['../../packages/docs/**', 'packages/docs'],
  ])('fails on an include into no package of apps/* or packages/*, rather than skip it: %s', (include, path) => {
    const root = probeProject({
      'pnpm-workspace.yaml': 'packages: ["apps/*", "packages/*", "libs/*"]\n',
      'apps/design-system/package.json': JSON.stringify({ name: '@acme/design-system' }),
      'libs/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
      'packages/@acme/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
      'packages/docs/README.md': '',
    })
    const config = { test: { projects: [{ test: { name: 'lib', include: ['src/**', include] } }] } }
    expect(() => testProjectPackages(join(root, 'apps/design-system'), config)).toThrow(
      new RegExp(`project "lib" includes "${include.replace(/[.*{}]/g, '\\$&')}", which points into ${path}:`),
    )
  })

  it('skips a negated include, which excludes files rather than adding a package', () => {
    const workspace = join(project({}), 'apps/design-system')
    const negated = {
      test: {
        projects: [{ root: '../../packages/ui', test: { name: 'ui', include: ['src/**', '!src/**/*.slow.ts'] } }],
      },
    }
    expect(testProjectPackages(workspace, negated)).toEqual([{ project: 'ui', include: 'src/**', pkg: '@acme/ui' }])
  })

  it('skips an include that leaves the pnpm workspace root, which is no package of it', () => {
    const workspace = join(project({}), 'apps/design-system')
    expect(testProjectPackages(workspace, { test: { include: ['../../../outside/**/*.test.ts'] } })).toEqual([])
  })

  it('names a package manifest that does not parse', () => {
    const root = probeProject({
      'pnpm-workspace.yaml': 'packages: ["apps/*", "packages/*"]\n',
      'apps/design-system/package.json': JSON.stringify({ name: '@acme/design-system' }),
      'packages/ui/package.json': '{ "name": "@acme/ui", }',
    })
    const workspace = join(root, 'apps/design-system')
    expect(() => testProjectPackages(workspace, { test: { include: ['../../packages/ui/**'] } })).toThrow(
      /Cannot read .*packages\/ui\/package\.json/,
    )
  })

  it('resolves an include from the project root it sets', () => {
    const workspace = join(project({}), 'apps/design-system')
    const rooted = { test: { projects: [{ root: '../../packages/ui', test: { name: 'ui', include: ['src/**'] } }] } }
    expect(testProjectPackages(workspace, rooted)).toEqual([{ project: 'ui', include: 'src/**', pkg: '@acme/ui' }])
  })

  it('fails on a config passed as a function, the defineConfig(() => …) shape', () => {
    const workspace = join(project({}), 'apps/design-system')
    expect(() => testProjectPackages(workspace, () => ({}))).toThrow(/config object/)
  })

  it('fails naming pnpm-workspace.yaml when the project has none', () => {
    const root = probeProject({
      'apps/design-system/package.json': JSON.stringify({ name: '@acme/design-system' }),
      'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
    })
    expect(() => testProjectPackages(join(root, 'apps/design-system'), config)).toThrow(/no pnpm-workspace\.yaml/)
  })

  it('reads the top-level include of a config with no projects', () => {
    const workspace = join(project({}), 'apps/design-system')
    expect(testProjectPackages(workspace, { test: { include: ['../../packages/ui/**/*.test.ts'] } })).toEqual([
      { project: '(root)', include: '../../packages/ui/**/*.test.ts', pkg: '@acme/ui' },
    ])
  })
})

describe('assertTestProjectsAreDependencies', () => {
  it('fails naming the project and the package missing from the manifest', () => {
    const workspace = join(project({ devDependencies: { '@acme/ui': 'workspace:*' } }), 'apps/design-system')
    expect(() => assertTestProjectsAreDependencies(workspace, config)).toThrow(
      /project "icons" → "@acme\/icons": "workspace:\*"[\s\S]*test-guards\.md/,
    )
    expect(() => assertTestProjectsAreDependencies(workspace, config)).not.toThrow(/@acme\/ui"/)
  })

  it('passes when every included package is a dependency', () => {
    const workspace = join(
      project({ dependencies: { '@acme/icons': 'workspace:*' }, devDependencies: { '@acme/ui': 'workspace:*' } }),
      'apps/design-system',
    )
    expect(() => assertTestProjectsAreDependencies(workspace, config)).not.toThrow()
  })

  it('fails when no project includes another package, rather than pass on nothing', () => {
    const workspace = join(project({}), 'apps/design-system')
    expect(() => assertTestProjectsAreDependencies(workspace, { test: { include: ['src/**/*.spec.ts'] } })).toThrow(
      /no test project includes/,
    )
  })
})
