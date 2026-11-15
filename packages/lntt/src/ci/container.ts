// Container mode: each job runs whole in the provider's own local executor instead of
// step by step on the host. CircleCI: `circleci local execute` on the processed
// configuration, one job at a time, with the fake secrets as `-e`. GitHub Actions:
// `act`, with an event file describing the same pull request or push and the fake
// secrets as `-s`. The event file is written by the caller: `lntt ci local` in a folder of
// its scope (src/ci/local.ts), the library's `containerCommand` in the system's temporary
// folder (src/ci/sync.ts).

import type { CiConfig } from './config.ts'
import type { Event } from './event.ts'
import type { Job } from './plan.ts'

// The event `act` reads: the same pull request or push as the local run's.
export function eventPayload(event: Event): string {
  return JSON.stringify(
    event.name === 'pull_request'
      ? { action: 'synchronize', pull_request: { draft: false, base: { ref: event.base }, head: { ref: event.head } } }
      : { ref: `refs/heads/${event.base}` },
  )
}

// How container mode starts each job, null for one the provider cannot run locally; `payload`
// gives the event file's path, asked for once, at the first GitHub Actions job.
export function containerArgs(config: CiConfig, payload: () => string): (job: Job) => string[] | null {
  let file: string | undefined
  return (job) => {
    if (!job.container) return null
    if (job.provider === 'circleci') {
      return [...job.container, ...Object.entries(config.fake.secrets).flatMap(([k, v]) => ['-e', `${k}=${v}`])]
    }
    file ??= payload()
    return [
      ...job.container,
      '-e',
      file,
      ...Object.entries(config.fake.secrets).flatMap(([k, v]) => ['-s', `${k}=${v}`]),
      ...Object.entries(config.fake.vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]),
    ]
  }
}

// The executables container mode needs for the jobs it would run: the provider's executor, and
// Docker behind it.
export function neededTools(jobs: Job[], only?: string[]): string[] {
  const needed = new Set<string>()
  for (const job of jobs) {
    if (job.state.state !== 'run' || !job.container || (only && !only.includes(job.key))) continue
    needed.add(job.container[0])
    needed.add('docker')
  }
  return [...needed]
}
