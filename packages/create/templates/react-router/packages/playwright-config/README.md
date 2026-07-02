# @starter/playwright-config

Shared Playwright base config — implements the E2E strategy of [ADR-0004 (Testing)](../../docs/adr/0004-testing.md#testing-strategy).
Apps don't write the config by hand: they call `definePlaywrightConfig`.

```ts
// apps/<app>/playwright.config.ts
import { definePlaywrightConfig } from '@starter/playwright-config'

export default definePlaywrightConfig({
  port: 3000,
  globalSetup: './__tests__/global-setup.ts',
  globalTeardown: './__tests__/global-teardown.ts',
})
```

## What it encodes

- `testDir: './__tests__'`, `testMatch: '**/*.e2e.ts'` — aligned with the E2E lint in `biome.json`.
- **No `webServer`**: Playwright would start it *before* `globalSetup`, missing the testcontainers. The dev server must be started inside `globalSetup` with the `@starter/test-utils` helpers.
- Clean `storageState` (`{ cookies: [], origins: [] }`): tests that need cookies set them explicitly.
- `workers: 1`, `fullyParallel: false`, `retries: 0`, `forbidOnly` in CI, `list` reporter, `trace: 'on-first-retry'`.
- `chromium` project (Desktop Chrome); optional `warmup` (`warmupSetup`) to warm up Vite's optimizer.

> The starter ships no app, so there's no runnable E2E: this config is the
> hook-in point for the derived project's first app. Install `@playwright/test`
> and `@starter/playwright-config` in the app and create `playwright.config.ts`
> as above.
