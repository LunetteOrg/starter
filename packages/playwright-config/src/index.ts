import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test'

/**
 * Base config Playwright riutilizzabile dalle app (ADR-0006).
 *
 * Le app non scrivono la config a mano: chiamano `definePlaywrightConfig`
 * passando la porta e (opzionale) i path di globalSetup/teardown.
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
  /** Porta su cui il dev server dell'app ascolta (avviato in globalSetup). */
  port: number
  /** Modulo globalSetup: avvia infra effimera (testcontainers) + app server. */
  globalSetup?: string
  /** Modulo globalTeardown: ferma quanto avviato in globalSetup. */
  globalTeardown?: string
  /**
   * Path/regex a un file di warmup eseguito prima dei test (scalda l'optimizer
   * di Vite, riduce il flake da timeout al primo avvio). Opzionale.
   */
  warmupSetup?: string
  /** Locale del browser (es. 'it-IT'); default = Desktop Chrome. */
  locale?: string
  /** Header HTTP extra (es. per pinnare un middleware i18n). */
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
    // NB: nessun `webServer`. Playwright avvierebbe il webServer PRIMA del
    // globalSetup, mancando i testcontainers. Avvia il dev server dentro
    // globalSetup usando gli helper di @starter/test-utils (ADR-0006).
    ...(globalSetup ? { globalSetup } : {}),
    ...(globalTeardown ? { globalTeardown } : {}),
    use: {
      baseURL: `http://localhost:${port}`,
      trace: 'on-first-retry',
      // Stato pulito: i test che servono cookie li impostano esplicitamente.
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
