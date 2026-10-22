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
/** The URL this module published, which teardown takes back. */
let published: string | undefined
let handlersRegistered = false

export async function setup(): Promise<void> {
  const action = testDbAction({
    env: process.env,
    docker: process.env.TEST_DATABASE_URL ? false : await dockerAvailable(),
  })
  // `external`: a given server is used and never stopped. `skip`: nothing published.
  if (action !== 'start') return

  container = await postgresContainer().start()
  published = container.getConnectionUri()
  process.env.TEST_DATABASE_URL = published
  // Here, not at module scope: vitest may load this module once per project, and only
  // the load that owns a container must hold handlers.
  registerKillHandlers()
}

export async function teardown(): Promise<void> {
  await stopAllTestDbs()
  // Vitest's watch mode runs setup again in this process: a URL left behind would
  // read as a server given from outside, dead, and every database test would fail.
  if (published && process.env.TEST_DATABASE_URL === published) delete process.env.TEST_DATABASE_URL
  published = undefined
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
 * Not covered here: SIGKILL, which cannot be caught, and a signal during `start()`,
 * when Docker created the container but `container` is not yet assigned. Removing by
 * label would close that window, but sibling packages of the same workspace run under
 * the same label at the same time. Ryuk covers both: the container carries this
 * process's Ryuk session label from its creation, and Ryuk removes it about 10 s
 * after the last Node testcontainers process on the machine disconnects, so a killed
 * run's Postgres stays while another run is connected. `lntt-clean-test` is the net
 * for what Ryuk misses: containers left exited after the Docker daemon restarted (Ryuk
 * does not survive the restart), and runs whose user disabled Ryuk in their shell.
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
  // Once per process: the handlers read `container`, whichever run set it.
  if (handlersRegistered) return
  handlersRegistered = true
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
