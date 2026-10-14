import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vitest/config'

// `.ts` in this repo, `.js` once published: the globalSetup sits beside this module.
const GLOBAL_SETUP = fileURLToPath(new URL(`./global-setup${extname(import.meta.url)}`, import.meta.url))

/**
 * For every package whose tests touch the database. It registers the globalSetup that
 * starts ONE Postgres for the vitest process, publishes it as `TEST_DATABASE_URL` and
 * stops it at the end, and it disables the testcontainers reaper.
 *
 * Without it there is no globalSetup, and every worker that calls `createTestDb`
 * starts a Postgres of its own that nobody stops.
 *
 * @example
 * ```ts
 * // vitest.config.ts
 * import { testDbPlugin } from '@lntt/test-utils/plugin'
 * export default defineConfig({ plugins: [testDbPlugin()] })
 * ```
 */
export function testDbPlugin(): Plugin {
  return {
    name: 'lntt-test-db',
    config() {
      // HERE and in `test.env` below: `config()` runs in the MAIN process, where the
      // globalSetup starts the container; `test.env` reaches the workers. Ryuk would
      // kill the run's Postgres when its last connection drops, between two files.
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'
      return {
        test: {
          globalSetup: [GLOBAL_SETUP],
          env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
        },
      }
    },
  }
}

/**
 * The Ryuk half of `testDbPlugin()`, for a package that starts other containers and
 * no test database. Ryuk is a per-MACHINE singleton: one package that leaves it on
 * starts the reaper, and every later process adopts it. Such a package stops its
 * own containers.
 */
export function ryukDisabledPlugin(): Plugin {
  return {
    name: 'lntt-ryuk-disabled',
    config() {
      process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'
      return { test: { env: { TESTCONTAINERS_RYUK_DISABLED: 'true' } } }
    },
  }
}
