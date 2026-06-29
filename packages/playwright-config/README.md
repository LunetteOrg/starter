# @starter/playwright-config

Base config Playwright condivisa — implementa la strategia E2E di **ADR-0006**.
Le app non scrivono la config a mano: chiamano `definePlaywrightConfig`.

```ts
// apps/<app>/playwright.config.ts
import { definePlaywrightConfig } from '@starter/playwright-config'

export default definePlaywrightConfig({
  port: 3000,
  globalSetup: './__tests__/global-setup.ts',
  globalTeardown: './__tests__/global-teardown.ts',
})
```

## Cosa codifica

- `testDir: './__tests__'`, `testMatch: '**/*.e2e.ts'` — allineato al lint E2E in `biome.json`.
- **Nessun `webServer`**: Playwright lo avvierebbe *prima* del `globalSetup`, mancando i testcontainers. Il dev server va avviato dentro `globalSetup` con gli helper di `@starter/test-utils`.
- `storageState` pulito (`{ cookies: [], origins: [] }`): i test che servono cookie li impostano esplicitamente.
- `workers: 1`, `fullyParallel: false`, `retries: 0`, `forbidOnly` in CI, reporter `list`, `trace: 'on-first-retry'`.
- Project `chromium` (Desktop Chrome); `warmup` opzionale (`warmupSetup`) per scaldare l'optimizer di Vite.

> Lo starter non include un'app, quindi non c'è un E2E eseguibile: questa config
> è il punto di aggancio per la prima app del progetto derivato. Installa
> `@playwright/test` e `@starter/playwright-config` nell'app e crea
> `playwright.config.ts` come sopra.
