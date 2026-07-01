import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Reusable Playwright base config for apps (ADR-0006).
 *
 * Apps don't write the config by hand: they call `definePlaywrightConfig`
 * passing the port and (optionally) the globalSetup/teardown paths.
 *
 * @example
 * ```ts
 * // apps/web/playwright.config.ts
 * import { definePlaywrightConfig } from '@starter/playwright-config'
 *
 * export default definePlaywrightConfig({
 *   port: 3000,
 *   globalSetup: './__tests__/global-setup.ts',
 *   globalTeardown: './__tests__/global-teardown.ts',
 * })
 * ```
 */
export interface E2eConfigOptions {
  /** Port the app's dev server listens on (started in globalSetup). */
  port: number
  /** globalSetup module: starts ephemeral infra (testcontainers) + app server. */
  globalSetup?: string
  /** globalTeardown module: stops whatever globalSetup started. */
  globalTeardown?: string
  /**
   * Path/regex to a warmup file run before the tests (warms up Vite's optimizer,
   * reduces first-start timeout flake). Optional.
   */
  warmupSetup?: string
  /** Browser locale (e.g. 'it-IT'); default = Desktop Chrome. */
  locale?: string
  /** Extra HTTP headers (e.g. to pin an i18n middleware). */
  extraHTTPHeaders?: Record<string, string>
}

const isCI = Boolean(process.env.CI)

export function definePlaywrightConfig(options: E2eConfigOptions): PlaywrightTestConfig {
  const { port, globalSetup, globalTeardown, warmupSetup, locale, extraHTTPHeaders } = options

  return defineConfig({
    testDir: './__tests__',
    testMatch: '**/*.e2e.ts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: isCI,
    reporter: [['list']],
    // NB: no `webServer`. Playwright would start the webServer BEFORE
    // globalSetup, missing the testcontainers. Start the dev server inside
    // globalSetup using the @starter/test-utils helpers (ADR-0006).
    ...(globalSetup ? { globalSetup } : {}),
    ...(globalTeardown ? { globalTeardown } : {}),
    use: {
      baseURL: `http://localhost:${port}`,
      trace: 'on-first-retry',
      // Clean state: tests that need cookies set them explicitly.
      storageState: { cookies: [], origins: [] },
      ...(locale ? { locale } : {}),
      ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
    },
    projects: [
      ...(warmupSetup ? [{ name: 'warmup', testMatch: warmupSetup, retries: 2 }] : []),
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
        dependencies: warmupSetup ? ['warmup'] : [],
      },
    ],
  })
}
