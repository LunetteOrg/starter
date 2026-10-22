import {
  configDefaults,
  coverageConfigDefaults,
  type TestProjectInlineConfiguration,
  type TestUserConfig,
} from 'vitest/config'
import type { CoverageV8Options } from 'vitest/node'

/**
 * The preset a Lunette project's vitest configs start from: `sharedTest()` for every
 * package, `appTest()` for an app whose suite is mostly jsdom component specs. What
 * each option buys and what the shared registry of the `fast` project still leaks is
 * in the starter's ADR `docs/adr/vitest-preset.md`.
 */

/** The JUnit file a CI job collects, relative to the package vitest runs in. */
export const sharedReporters = {
  reporters: ['default', 'junit'],
  outputFile: { junit: 'test-results/junit.xml' },
} satisfies TestUserConfig

/**
 * Coverage with V8 (the project installs `@vitest/coverage-v8` to run it). `include`
 * stays with each package: only the package knows where its sources live. No
 * thresholds: a project sets them the day it decides one.
 */
export const sharedCoverage = {
  provider: 'v8',
  // Fixed, so a task runner can declare `coverage/**` as the task's output.
  reportsDirectory: './coverage',
  // `json-summary` is what a CI check reads to compare coverage.
  reporter: ['text-summary', 'html', 'json-summary'],
  exclude: [
    ...coverageConfigDefaults.exclude,
    '**/*.stories.{ts,tsx}',
    '**/*.spec.{ts,tsx}',
    '**/*.test.{ts,tsx}',
    '**/test/**',
    '**/.react-router/**',
  ],
} satisfies CoverageV8Options

export interface SharedTestOptions {
  /** The directory coverage measures, relative to the package. Default `src`. */
  sources?: string
}

/**
 * The `test` block every package starts from.
 *
 * Before each test vitest undoes every `vi.stubGlobal`, `vi.stubEnv` and `vi.spyOn`,
 * so none outlives the test that made it, even when an assertion fails before a
 * manual restore. A stub or spy made at module scope or in `beforeAll` is undone
 * before the first test runs: make it in `beforeEach` or in the test.
 *
 * @example
 * ```ts
 * export default defineConfig({ plugins: [testDbPlugin()], test: { ...sharedTest(), testTimeout: 30_000 } })
 * ```
 */
export function sharedTest({ sources = 'src' }: SharedTestOptions = {}) {
  return {
    ...sharedReporters,
    coverage: { ...sharedCoverage, include: [`${sources}/**/*.{ts,tsx}`] },
    unstubGlobals: true,
    unstubEnvs: true,
    restoreMocks: true,
  } satisfies TestUserConfig
}

/**
 * The jsdom setup by its published name, resolved from the app's root as vitest
 * resolves every setup file: the app depends on `@lntt/test-utils` itself.
 */
export const JSDOM_SETUP_FILE = '@lntt/test-utils/jsdom-setup'

/**
 * The jsdom setup of this package, by name or by path: the published name, the built
 * file under `node_modules`, or the source in a workspace. An app's own file named
 * `jsdom-setup` is not it.
 */
const JSDOM_SETUP = /(^|[/\\])(@lntt[/\\]test-utils([/\\]dist)?|test-utils[/\\]src)[/\\]jsdom-setup(\.[cm]?[jt]s)?$/

/** What no app project runs: builds, React Router's generated types, the e2e suite. */
const APP_EXCLUDE = [...configDefaults.exclude, '**/.react-router/**', '**/build/**', '**/e2e/**']

export interface AppTestOptions {
  /** The directory coverage measures. Default `app`, React Router's. */
  sources?: string
  /** Files no project runs, added to vitest's defaults and the app's builds. */
  exclude?: string[]
  /**
   * Setup files listed before the jsdom setup, such as
   * `'@testing-library/jest-dom/vitest'`. Never one that imports the jsdom setup.
   */
  setupFiles?: string[]
  /**
   * Specs too heavy to share the run (one booting a whole dev server): a project of
   * their own, with vitest's isolation, run after every other project so its memory
   * does not add to theirs. `include` holds globs relative to the app's root, as
   * vitest's own, and `fast` excludes the same globs: `vite-deps.test.ts` is only the
   * file at the root, a spec in a subdirectory needs a leading `**` segment.
   */
  last?: { name: string; include: string[] }
}

/**
 * The `test` block of an app whose suite is mostly jsdom component specs.
 *
 * - **`fast`**: worker threads and `isolate: false`. The module registry and the
 *   environment are shared by the files of a worker, so React, the router and the
 *   component library load once per worker instead of once per file. Safe only while
 *   no spec mocks a module with a hoisted `vi.mock`.
 * - **`last`**, when given: the heavy specs, isolated, after the others.
 * - **`setupFiles`** lists the jsdom setup itself: setup files run again for every
 *   test file, a module they import runs once per worker.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   test: appTest({
 *     setupFiles: ['@testing-library/jest-dom/vitest'],
 *     // The file at the app's root: a glob, relative to the root.
 *     last: { name: 'dev-server', include: ['vite-deps.test.ts'] },
 *   }),
 * })
 * ```
 */
export function appTest({ sources = 'app', exclude = [], setupFiles = [], last }: AppTestOptions = {}) {
  const listed = setupFiles.find((file) => JSDOM_SETUP.test(file))
  if (listed) {
    throw new Error(`appTest() lists ${JSDOM_SETUP_FILE} itself: remove ${listed} from its setupFiles.`)
  }
  if (last && last.include.length === 0) {
    throw new Error(`appTest(): the project ${last.name} has nothing to include.`)
  }
  const excluded = [...APP_EXCLUDE, ...exclude]
  const projects: TestProjectInlineConfiguration[] = [
    {
      extends: true,
      test: {
        name: 'fast',
        exclude: [...excluded, ...(last?.include ?? [])],
        // Threads skip the per-file spawn cost of forked processes.
        pool: 'threads',
        isolate: false,
      },
    },
  ]
  if (last) {
    projects.push({
      extends: true,
      test: { name: last.name, include: last.include, exclude: excluded, sequence: { groupOrder: 1 } },
    })
  }
  return {
    ...sharedTest({ sources }),
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: [...setupFiles, JSDOM_SETUP_FILE],
    projects,
  } satisfies TestUserConfig
}
