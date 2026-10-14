# @lntt/playwright-config

The Playwright base config every Lunette app's e2e suite is built on. Apps don't write
the config by hand: they call `definePlaywrightConfig`.

```sh
pnpm add -D @lntt/playwright-config @playwright/test
```

```ts
// apps/<app>/playwright.config.ts
import { definePlaywrightConfig } from '@lntt/playwright-config'

export default definePlaywrightConfig({
  port: 3000,
  globalSetup: './__tests__/global-setup.ts',
  globalTeardown: './__tests__/global-teardown.ts',
})
```

## What it encodes

- `testDir: './__tests__'`, `testMatch: '**/*.e2e.ts'`.
- **No `webServer`**: Playwright would start it *before* `globalSetup`, before the
  containers the app needs. The app's `globalSetup` starts its containers, then the
  dev server.
- A clean `storageState` (`{ cookies: [], origins: [] }`): tests that need cookies set
  them explicitly.
- `workers: 1`, `fullyParallel: false`, `retries: 0`, `forbidOnly` when `CI` is set,
  the `list` reporter, `trace: 'on-first-retry'`.
- A `chromium` project (Desktop Chrome), and an optional `warmup` project
  (`warmupSetup`) that runs first to warm up Vite's optimizer.
- Optional `locale` and `extraHTTPHeaders` for the browser context.

`@playwright/test` is a peer dependency: the app installs it, so there is one copy of
the runner.
