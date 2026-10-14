// Container mode: each job runs whole in the provider's own local executor instead of
// step by step on the host. CircleCI: `circleci local execute` on the processed
// configuration, one job at a time, with the fake secrets as `-e`. GitHub Actions:
// `act`, with an event file describing the same pull request or push and the fake
// secrets as `-s`.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CiConfig } from './config.ts'
import type { Event } from './event.ts'
import type { Job } from './plan.ts'

function eventFile(event: Event): string {
  const payload =
    event.name === 'pull_request'
      ? { action: 'synchronize', pull_request: { draft: false, base: { ref: event.base }, head: { ref: event.head } } }
      : { ref: `refs/heads/${event.base}` }
  const file = join(mkdtempSync(join(tmpdir(), 'lntt-ci-act-')), 'event.json')
  writeFileSync(file, JSON.stringify(payload))
  return file
}

export function containerCommand(event: Event, config: CiConfig): (job: Job) => string[] | null {
  let payload: string | undefined
  return (job) => {
    if (!job.container) return null
    if (job.provider === 'circleci') {
      return [...job.container, ...Object.entries(config.fake.secrets).flatMap(([k, v]) => ['-e', `${k}=${v}`])]
    }
    payload ??= eventFile(event)
    return [
      ...job.container,
      '-e',
      payload,
      ...Object.entries(config.fake.secrets).flatMap(([k, v]) => ['-s', `${k}=${v}`]),
      ...Object.entries(config.fake.vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]),
    ]
  }
}

export function onPath(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v "$0"`, command], { stdio: 'ignore' }).status === 0
}

// The executables container mode needs for the jobs it would run, that are not on the
// PATH: the provider's executor, and Docker behind it.
export function missingTools(jobs: Job[], only?: string[], exists: (command: string) => boolean = onPath): string[] {
  const needed = new Set<string>()
  for (const job of jobs) {
    if (job.state.state !== 'run' || !job.container || (only && !only.includes(job.key))) continue
    needed.add(job.container[0])
    needed.add('docker')
  }
  return [...needed].filter((command) => !exists(command))
}
