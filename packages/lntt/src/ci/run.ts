// What a run of `lntt ci local` gives back, and the plain logic around it: the order of the jobs,
// what a job's needs ended with, the exit code, the timeout and load lines. The run itself is on
// Effect (src/ci/runner.ts); `runJobs`, `stopRunning` and `machineLoad` here are the library's
// Promise forms (`@lntt/lntt/ci`), which load it when called.

import type { Job, NeedsOutcome } from './plan.ts'

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'noop' | 'blocked'
export type JobStatus = 'passed' | 'failed' | 'skipped' | 'cloud-only' | 'blocked' | 'not-selected'

export interface StepResult {
  label: string
  status: StepStatus
  reason?: string
  ms?: number
  timedOut?: boolean
}

export interface JobResult {
  key: string
  status: JobStatus
  reason?: string
  steps: StepResult[]
  ms: number
  timedOut?: boolean
}

export interface RunOptions {
  log: (line: string) => void
  // Where the commands' output goes: the terminal, or nowhere (tests).
  output?: 'inherit' | 'ignore'
  // Run only these job keys; the others are reported as skipped.
  only?: string[]
  onJob?: (key: string) => void
  // Container mode: the job runs whole through this command instead of step by step.
  container?: (job: Job) => string[] | null
  // How long one step (in container mode, one job) may run; none without it.
  timeoutMs?: number
  // When the whole run stops (ms since the epoch), and why: the running command is stopped as on
  // a timeout, and what is left is skipped with the reason.
  deadline?: { at: number; reason: string }
  // What the machine is doing when a command is stopped (default: machineLoad).
  load?: () => string | Promise<string>
  // Once aborted (an interrupt), no step or job starts, and the running command is stopped.
  signal?: AbortSignal
  // The process group of the command that starts, then null once it is gone.
  onGroup?: (group: number | null) => void
  // Between the SIGTERM to a stopped command's group and its SIGKILL (default 5 s).
  killAfterMs?: number
}

export const KILL_AFTER_MS = 5000

export function timeoutText(ms: number): string {
  return ms < 60_000 ? `${Number((ms / 1000).toFixed(1))}s` : `${Number((ms / 60_000).toFixed(1))}m`
}

// The load line: the load average, the cores, and the containers when Docker answered.
export function loadLine(
  load: readonly number[],
  cores: number,
  containers: number | null,
  testcontainers: number | null,
): string {
  const running =
    containers === null
      ? ''
      : `, ${containers} containers running${testcontainers === null ? '' : ` (${testcontainers} Testcontainers)`}`
  return `load ${load.map((n) => n.toFixed(1)).join(' / ')} on ${cores} cores${running}`
}

// Jobs in an order where each comes after its needs, otherwise as listed.
export function ordered(jobs: Job[]): Job[] {
  const byKey = new Map(jobs.map((job) => [job.key, job]))
  const done = new Set<string>()
  const result: Job[] = []
  const visit = (job: Job, path: string[]) => {
    if (done.has(job.key) || path.includes(job.key)) return
    for (const need of job.needs) {
      const dependency = byKey.get(need)
      if (dependency) visit(dependency, [...path, job.key])
    }
    done.add(job.key)
    result.push(job)
  }
  for (const job of jobs) visit(job, [])
  return result
}

// What a job's needs ended with, for its condition, and the line that says it.
export function needsOutcome(job: Job, results: Map<string, JobResult>): { needs: NeedsOutcome; after: string } {
  const statuses = job.needs.map((need) => [need, results.get(need)?.status ?? 'missing'] as const)
  return {
    needs: {
      success: statuses.every(([, status]) => status === 'passed'),
      failure: statuses.some(([, status]) => status === 'failed'),
    },
    after: statuses.map(([need, status]) => `${need}: ${status}`).join(', '),
  }
}

// 1 when a job failed; with --strict, also when anything the cloud would run was not
// run for a reason other than a cloud-only declaration.
export function exitCode(results: JobResult[], { strict }: { strict: boolean }): number {
  const failed = results.some((r) => r.status === 'failed')
  const blocked = results.some((r) => r.status === 'blocked' || r.steps.some((s) => s.status === 'blocked'))
  return failed || (strict && blocked) ? 1 : 0
}

// The runs the Promise form started and has not finished: stopRunning stops them.
const running = new Set<{ stop: () => void; done: Promise<unknown> }>()

const live = async () => {
  const [Layer, { SpawnerLive }, { MachineLive }] = await Promise.all([
    import('effect/Layer'),
    import('../spawner.ts'),
    import('./machine.ts'),
  ])
  return Layer.merge(SpawnerLive, MachineLive)
}

// The run on the machine. An abort of `signal` starts nothing more and stops the running command;
// the results still come back, the rest skipped as interrupted.
export async function runJobs(jobs: Job[], options: RunOptions): Promise<JobResult[]> {
  const [Effect, Deferred, runner, layer] = await Promise.all([
    import('effect/Effect'),
    import('effect/Deferred'),
    import('./runner.ts'),
    live(),
  ])
  const stop = Deferred.makeUnsafe<void>()
  const halt = () => void Deferred.doneUnsafe(stop, Effect.void)
  if (options.signal?.aborted) halt()
  options.signal?.addEventListener('abort', halt, { once: true })
  const { log, onJob, load, onGroup, signal: _, ...rest } = options
  const done = Effect.runPromise(
    runner
      .runJobs(jobs, {
        ...rest,
        log: (line) => Effect.sync(() => log(line)),
        ...(onJob ? { onJob: (key: string) => Effect.sync(() => onJob(key)) } : {}),
        ...(load ? { load: Effect.promise(async () => load()) } : {}),
        ...(onGroup ? { onGroup: (group: number | null) => Effect.sync(() => onGroup(group)) } : {}),
        root: process.cwd(),
        stop,
      })
      .pipe(Effect.provide(layer)),
  )
  const entry = { stop: halt, done }
  running.add(entry)
  try {
    return await done
  } finally {
    running.delete(entry)
    options.signal?.removeEventListener('abort', halt)
  }
}

// Stops the runs `runJobs` has going (an interrupt: a detached group does not get the terminal's
// Ctrl-C), and resolves once their commands have gone, or after `capMs`. The grace before the
// SIGKILL is each run's own `killAfterMs` (runJobs' option): `killAfterMs` here is still accepted,
// for the callers written against the library before, and has no effect.
export function stopRunning({ capMs = KILL_AFTER_MS }: { killAfterMs?: number; capMs?: number } = {}): Promise<void> {
  const runs = [...running]
  for (const run of runs) run.stop()
  let cap: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.allSettled(runs.map((run) => run.done)).then(() => undefined),
    new Promise<void>((resolve) => {
      cap = setTimeout(resolve, capMs)
    }),
  ]).finally(() => clearTimeout(cap))
}

// The load average, the cores, and the containers running.
export async function machineLoad(): Promise<string> {
  const [Effect, runner, layer] = await Promise.all([import('effect/Effect'), import('./runner.ts'), live()])
  return Effect.runPromise(runner.machineLoad.pipe(Effect.provide(layer)))
}
