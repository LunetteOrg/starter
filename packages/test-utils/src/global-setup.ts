import { execFileSync } from 'node:child_process'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { postgresContainer, stopAllTestDbs } from './db.ts'
import { dockerAvailable, testDbAction } from './docker.ts'

/**
 * One Postgres per vitest process, started and stopped here.
 *
 * This runs in the vitest MAIN process, once, before any worker. The server reaches
 * the workers through `TEST_DATABASE_URL`, which `createTestDb` reads, so no worker
 * starts a container: a container started in a worker is owned by a process that
 * exits before anything can stop it.
 */
let container: StartedPostgreSqlContainer | undefined

export async function setup(): Promise<void> {
  // Before any early return: a hand-registered globalSetup, without the plugin, keeps
  // the reaper off too.
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'

  const action = testDbAction({
    env: process.env,
    docker: process.env.TEST_DATABASE_URL ? false : await dockerAvailable(),
  })
  // `external`: a given server is used and never stopped. `skip`: nothing published.
  if (action !== 'start') return

  container = await postgresContainer().start()
  process.env.TEST_DATABASE_URL = container.getConnectionUri()
  // Here, not at module scope: vitest may load this module once per project, and only
  // the load that owns a container must hold handlers.
  registerKillHandlers()
}

export async function teardown(): Promise<void> {
  await stopAllTestDbs()
  if (!container) return
  try {
    await container.stop()
    container = undefined
  } catch {
    // Keep `container` set: the synchronous removal below is for exactly a stop that
    // failed (an unresponsive daemon), now or at process exit.
    removeContainerSync()
  }
}

/**
 * Removes the container when the run is KILLED rather than finished: Ctrl-C, or turbo
 * reaping this task because a sibling package failed.
 *
 * Synchronous, through the docker CLI: an `exit` handler runs synchronous code only,
 * and `container.stop()` returns a promise the closing event loop never settles.
 *
 * Not covered, and left to `lntt-clean-test`: SIGKILL, which cannot be caught, and a
 * signal during `start()`, when Docker created the container but `container` is not
 * yet assigned. Removing by label would close that window, but sibling packages of
 * the same workspace run under the same label at the same time.
 */
function removeContainerSync(): void {
  if (!container) return
  const id = container.getId()
  // Before the call: a throw must not leave us trying again.
  container = undefined
  try {
    // A signal at logout can arrive while the daemon itself shuts down; a synchronous
    // call to an unresponsive socket cannot be interrupted, hence the timeout.
    execFileSync('docker', ['rm', '--force', '--volumes', id], {
      stdio: 'ignore',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    })
  } catch {
    // No docker on PATH, or the container is already gone: nothing left to try.
  }
}

function registerKillHandlers(): void {
  process.on('exit', removeContainerSync)
  // `exit` does not run for a process felled by a signal it never caught. The
  // re-raise keeps a killed run from reporting itself clean.
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      removeContainerSync()
      process.kill(process.pid, signal)
    })
  }
}
