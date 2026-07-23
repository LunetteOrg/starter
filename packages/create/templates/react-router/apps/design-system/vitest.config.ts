import storybookTest from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/**
 * Component-test project: runs the stories co-located in `packages/ui` as real
 * browser tests (ADR-0004 — component tests). Playwright is the browser
 * ENGINE here, not the runner: `@playwright/test` stays reserved for e2e
 * (ADR-0004 — testing strategy).
 *
 * Self-arming (ADR-0002 — self-arming enforcement): the template ships no live
 * component, so at day-0 this project collects zero stories and passes
 * (`passWithNoTests`). It arms itself the moment the first real component +
 * story lands in `packages/ui`.
 */
// Top-level await, not an async factory: passing the object literal straight to
// `defineConfig` lets it contextually type the string literals ('v8',
// 'chromium'). Through a factory they widen to `string` and the config no longer
// typechecks.
const storybookPlugins = await storybookTest({ configDir: '.storybook' })

export default defineConfig({
  plugins: [storybookPlugins],
  test: {
    name: 'ui-components',
    // Day-0 the template has no live story: an empty run is the expected state,
    // not a failure. See the self-arming note above.
    passWithNoTests: true,
    // No setup file: since Storybook 10.3 the addon applies the preview
    // annotations (token CSS, a11y parameters) automatically.
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    // Off by default (kept out of the hot `pnpm test` path); enable per-run with
    // `vitest run --coverage`. `json-summary` feeds scripts/coverage-summary.mjs,
    // which merges this with the Node-side coverage into one table.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Measure the components under test, not this showcase app.
      include: ['../../packages/ui/src/**'],
    },
  },
})
