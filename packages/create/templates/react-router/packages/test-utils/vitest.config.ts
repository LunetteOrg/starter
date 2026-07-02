import { defineConfig } from 'vitest/config'
import { testDbPlugin } from './src/plugin'

export default defineConfig({
  plugins: [testDbPlugin()],
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    exclude: ['**/node_modules/**', '**/__fixtures__/**'],
    // Off by default (kept out of the hot `pnpm test` path); enable per-run with
    // `vitest run --coverage`. `json-summary` feeds scripts/coverage-summary.mjs.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: './coverage',
    },
  },
})
