import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vitest/config'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Vitest plugin that injects globalSetup for container teardown.
 *
 * Migration configuration moved to `createTestDb({ migrationsFolder })`.
 *
 * @example
 * ```ts
 * // vitest.config.ts
 * import { testDbPlugin } from '@starter/test-utils/plugin'
 *
 * export default defineConfig({
 *   plugins: [testDbPlugin()],
 * })
 * ```
 */
export function testDbPlugin(): Plugin {
  return {
    name: 'test-db',
    config() {
      return {
        test: {
          globalSetup: [resolve(__dirname, 'global-setup.ts')],
        },
      }
    },
  }
}
