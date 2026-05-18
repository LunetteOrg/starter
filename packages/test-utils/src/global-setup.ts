import { stopAllTestDbs } from './db'

export async function teardown() {
  await stopAllTestDbs()
}
