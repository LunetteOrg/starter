import { getContainerRuntimeClient } from 'testcontainers'

export type TestDbAction = 'external' | 'start' | 'skip'

/**
 * What the globalSetup does about the run's database:
 * - `external`: `TEST_DATABASE_URL` is already set, so a server was given; start nothing.
 * - `start`: Docker answers; start one Postgres for the run.
 * - `skip`: no Docker on a developer machine; publish nothing, so unit tests run and
 *   database suites skip (`hasTestDatabase()`).
 *
 * In CI a missing Docker throws: a skipped integration tier there is a false green.
 */
export function testDbAction({ env, docker }: { env: NodeJS.ProcessEnv; docker: boolean }): TestDbAction {
  if (env.TEST_DATABASE_URL) return 'external'
  if (docker) return 'start'
  if (env.CI) {
    throw new Error(
      'Integration tests require Docker, but testcontainers found no container runtime. ' +
        'In CI the database suites must not be skipped.',
    )
  }
  return 'skip'
}

/** Whether testcontainers finds a container runtime, the way it would to start one. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await getContainerRuntimeClient()
    return true
  } catch {
    return false
  }
}
