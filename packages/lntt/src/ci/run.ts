// Native mode: each job's steps run in order on the host, from the working tree.
// Jobs follow `needs`; a job whose need failed is skipped, the others go on, so one
// run lists every red job. Within a job, a failed step skips the following ones
// unless their condition asks for a failure (`if: failure()`, `when: on_fail`).
// Each command runs in a process group of its own, stopped whole when it outlasts the
// timeout or when ci:local is interrupted.

import { spawn, spawnSync } from 'node:child_process'
import { availableParallelism, loadavg } from 'node:os'
import type { Job, Local, Step } from './plan.ts'

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
  // What the machine is doing when a command times out (default: machineLoad).
  load?: () => string
}

// The groups still running, and those SIGTERM was sent to, until their SIGKILL: a closed
// leader says nothing of its group, where a child that ignored SIGTERM may still run.
const groups = new Set<number>()
const terminated = new Set<number>()

// SIGTERM to the group, then SIGKILL to the group five seconds later, whatever the leader
// did meanwhile: a process group id is not reused while a member lives, so the SIGKILL can
// only reach what ignored SIGTERM (an empty group fails with ESRCH). Only a group still
// running is signalled at first: a closed command's pid may already belong to another process.
function terminate(pid: number): void {
  if (!groups.has(pid)) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  terminated.add(pid)
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
    terminated.delete(pid)
  }, 5000).unref()
}

// Stops the commands still running (an interrupt of ci:local: a detached group does not
// get the terminal's Ctrl-C), and resolves once they have closed, or after five seconds.
export function stopRunning(): Promise<void> {
  for (const pid of groups) terminate(pid)
  const until = Date.now() + 5000
  return new Promise((resolve) => {
    const wait = setInterval(() => {
      if (groups.size > 0 && Date.now() < until) return
      clearInterval(wait)
      resolve()
    }, 50)
  })
}

// Whatever ignored SIGTERM and is still running when ci:local exits goes with it.
process.on('exit', () => {
  for (const pid of [...groups, ...terminated]) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
})

// The load average, the cores, and the containers running (Testcontainers' among them):
// what tells a slow machine from a hung test. Without Docker, no containers are named.
export function machineLoad(): string {
  const load = loadavg()
    .map((n) => n.toFixed(1))
    .join(' / ')
  const count = (...filter: string[]) => {
    const ps = spawnSync('docker', ['ps', '-q', ...filter], { encoding: 'utf8', timeout: 5000 })
    return ps.status === 0 ? ps.stdout.split('\n').filter((l) => l !== '').length : null
  }
  const containers = count()
  const testcontainers = containers === null ? null : count('--filter', 'label=org.testcontainers=true')
  const running =
    containers === null
      ? ''
      : `, ${containers} containers running${testcontainers === null ? '' : ` (${testcontainers} Testcontainers)`}`
  return `load ${load} on ${availableParallelism()} cores${running}`
}

function timeoutText(ms: number): string {
  return ms < 60_000 ? `${Number((ms / 1000).toFixed(1))}s` : `${Number((ms / 60_000).toFixed(1))}m`
}

interface Outcome {
  status: StepStatus
  reason?: string
  timedOut?: boolean
}

function exec(argv: string[], cwd: string, env: Record<string, string>, options: RunOptions): Promise<Outcome> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, CI: 'true', ...env },
      stdio: ['ignore', options.output ?? 'inherit', options.output ?? 'inherit'],
      detached: true,
    })
    const pid = child.pid
    if (pid) groups.add(pid)
    let load: string | null = null
    // A delay past setTimeout's 32-bit range would fire at once.
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => {
              load = (options.load ?? machineLoad)()
              if (pid) terminate(pid)
            },
            Math.min(options.timeoutMs, 2 ** 31 - 1),
          )
    const done = (code: number) => {
      clearTimeout(timer)
      if (pid) groups.delete(pid)
      if (load !== null) {
        resolve({
          status: 'failed',
          reason: `timed out after ${timeoutText(options.timeoutMs ?? 0)} — ${load}`,
          timedOut: true,
        })
      } else resolve(code === 0 ? { status: 'passed' } : { status: 'failed', reason: `exit ${code}` })
    }
    child.on('error', () => done(127))
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)))
  })
}

async function runLocal(local: Local, options: RunOptions): Promise<Outcome> {
  switch (local.kind) {
    case 'noop':
      return { status: 'noop', reason: local.note }
    case 'blocked':
      return { status: 'blocked', reason: local.reason }
    case 'fail':
      return { status: 'failed', reason: local.reason }
    case 'check': {
      const problem = local.check()
      return problem ? { status: 'failed', reason: problem } : { status: 'passed', reason: local.note }
    }
    case 'run':
      return exec([...local.shell, local.command], local.cwd, local.env, options)
  }
}

async function runSteps(steps: Step[], options: RunOptions): Promise<StepResult[]> {
  const results: StepResult[] = []
  let failed = false
  for (const step of steps) {
    const decision = step.condition ? step.condition.decide(failed) : { known: true as const, value: !failed }
    if (!decision.known) {
      results.push({
        label: step.label,
        status: 'blocked',
        reason: `condition ${step.condition?.text} needs ${decision.unknown.join(', ')}`,
      })
      continue
    }
    if (!decision.value) {
      results.push({
        label: step.label,
        status: 'skipped',
        reason: failed ? 'an earlier step failed' : 'condition false',
      })
      continue
    }
    if (step.local.kind === 'run') options.log(`  ▶ ${step.label}`)
    const started = Date.now()
    const result = await runLocal(step.local, options)
    if (result.status === 'failed') failed = true
    results.push({ label: step.label, ...result, ms: Date.now() - started })
  }
  return results
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

export async function runJobs(jobs: Job[], options: RunOptions): Promise<JobResult[]> {
  const results = new Map<string, JobResult>()
  for (const job of ordered(jobs)) {
    const started = Date.now()
    const record = (status: JobStatus, reason?: string, steps: StepResult[] = [], timedOut = false) =>
      results.set(job.key, {
        key: job.key,
        status,
        ...(reason ? { reason } : {}),
        steps,
        ms: Date.now() - started,
        ...(timedOut ? { timedOut } : {}),
      })

    if (options.only && !options.only.includes(job.key)) {
      record('not-selected', 'not selected with --job')
      continue
    }
    if (job.state.state !== 'run') {
      record(job.state.state, job.state.reason)
      continue
    }
    if (job.needs.length > 0) {
      const statuses = job.needs.map((need) => [need, results.get(need)?.status ?? 'missing'] as const)
      const needs = {
        success: statuses.every(([, status]) => status === 'passed'),
        failure: statuses.some(([, status]) => status === 'failed'),
      }
      const after = statuses.map(([need, status]) => `${need}: ${status}`).join(', ')
      const decision = job.condition ? job.condition.decide(needs) : { known: true as const, value: needs.success }
      if (!decision.known) {
        record('blocked', `condition ${job.condition?.text} needs ${decision.unknown.join(', ')}`)
        continue
      }
      if (!decision.value) {
        record(
          'skipped',
          `${job.condition ? `condition ${job.condition.text} is false` : 'not every need passed'} (${after})`,
        )
        continue
      }
    }
    options.onJob?.(job.key)
    options.log(`● ${job.key}`)
    const container = options.container?.(job)
    if (container) {
      options.log(`  ▶ ${container.join(' ')}`)
      const outcome = await exec(container, process.cwd(), {}, options)
      record(outcome.status === 'passed' ? 'passed' : 'failed', outcome.reason, [], outcome.timedOut)
      continue
    }
    const steps = await runSteps(job.steps, options)
    const timedOut = steps.filter((s) => s.timedOut).map((s) => s.label)
    record(
      steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
      timedOut.length > 0 ? `${timedOut.join(', ')} timed out` : undefined,
      steps,
    )
  }
  // Report in the configuration's order.
  return jobs.map((job) => results.get(job.key) as JobResult)
}

// 1 when a job failed; with --strict, also when anything the cloud would run was not
// run for a reason other than a cloud-only declaration.
export function exitCode(results: JobResult[], { strict }: { strict: boolean }): number {
  const failed = results.some((r) => r.status === 'failed')
  const blocked = results.some((r) => r.status === 'blocked' || r.steps.some((s) => s.status === 'blocked'))
  return failed || (strict && blocked) ? 1 : 0
}
