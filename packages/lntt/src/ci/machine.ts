// The machine `lntt ci local` runs on, as its services see it on Node: the load average and the
// cores (src/ci/runner.ts's Machine), from `node:os`, and the processes the ci:local lock judges.

import { availableParallelism, hostname, loadavg } from 'node:os'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { CiProcesses } from './lock.ts'
import { Machine } from './runner.ts'

export const MachineLive = Layer.succeed(Machine)(
  Machine.of({ load: Effect.sync(() => loadavg()), cores: availableParallelism() }),
)

// Whether a process is running: EPERM is a process of another user.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// The processes the ci:local lock judges (src/ci/lock.ts), through process.kill.
export const CiProcessesLive = Layer.succeed(CiProcesses)(
  CiProcesses.of({
    self: process.pid,
    host: hostname(),
    alive: (pid) => Effect.sync(() => alive(pid)),
    groupAlive: (group) => Effect.sync(() => alive(-group)),
  }),
)
