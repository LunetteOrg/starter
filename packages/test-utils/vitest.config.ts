import { defineConfig } from 'vitest/config'
import { testDbPlugin } from './src/plugin.ts'

export default defineConfig({
  plugins: [testDbPlugin()],
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    exclude: ['**/node_modules/**', '**/__fixtures__/**', '**/dist/**'],
  },
})
