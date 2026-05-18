import { defineConfig } from 'vitest/config'
import { testDbPlugin } from './src/plugin'

export default defineConfig({
  plugins: [testDbPlugin()],
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    exclude: ['**/node_modules/**', '**/__fixtures__/**'],
  },
})
