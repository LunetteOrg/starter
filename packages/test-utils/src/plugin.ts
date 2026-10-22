import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vitest/config'

// `.ts` in this repo, `.js` once published: the globalSetup sits beside this module.
const GLOBAL_SETUP = fileURLToPath(new URL(`./global-setup${extname(import.meta.url)}`, import.meta.url))

/**
 * For every package whose tests touch the database. It registers the globalSetup that
 * starts ONE Postgres for the vitest process, publishes it as `TEST_DATABASE_URL` and
 * stops it at the end. Nothing else: no environment variable, in this process or in
 * the workers.
 *
 * Ryuk, the testcontainers reaper, stays on. The globalSetup runs in the MAIN vitest
 * process, which holds Ryuk's connection from the first file to the last, and no
 * worker starts a container; so Ryuk removes the Postgres only once the run itself is
 * gone, which is what makes a `SIGKILL`ed run clean up after itself. A machine that
 * cannot run Ryuk (offline without its image, a runtime that does not let it mount
 * the Docker socket) sets `TESTCONTAINERS_RYUK_DISABLED=true` in its own shell; this
 * plugin neither sets nor clears it.
 *
 * Without the plugin there is no globalSetup, and every worker that calls
 * `createTestDb` starts a Postgres of its own.
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
      return { test: { globalSetup: [GLOBAL_SETUP] } }
    },
  }
}
