// Native mode: each job's steps run in order on the host, from the working tree.
// Jobs follow `needs`; a job whose need failed is skipped, the others go on, so one
// run lists every red job. Within a job, a failed step skips the following ones
// unless their condition asks for a failure (`if: failure()`, `when: on_fail`).

import { spawn } from 'node:child_process'
import type { Job, Local, Step } from './plan.ts'

export type StepStatus = 'passed' | 'failed' | 'skipped' | 'noop' | 'blocked'
export type JobStatus = 'passed' | 'failed' | 'skipped' | 'cloud-only' | 'blocked' | 'not-selected'

export interface StepResult {
  label: string
  status: StepStatus
  reason?: string
  ms?: number
}

export interface JobResult {
  key: string
  status: JobStatus
  reason?: string
  steps: StepResult[]
  ms: number
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
}

function exec(argv: string[], cwd: string, env: Record<string, string>, output: 'inherit' | 'ignore'): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, CI: 'true', ...env },
      stdio: ['ignore', output, output],
    })
    child.on('error', () => resolve(127))
    child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}

async function runLocal(local: Local, output: 'inherit' | 'ignore'): Promise<{ status: StepStatus; reason?: string }> {
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
    case 'run': {
      const code = await exec([...local.shell, local.command], local.cwd, local.env, output)
      return code === 0 ? { status: 'passed' } : { status: 'failed', reason: `exit ${code}` }
    }
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
    const result = await runLocal(step.local, options.output ?? 'inherit')
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
    const record = (status: JobStatus, reason?: string, steps: StepResult[] = []) =>
      results.set(job.key, { key: job.key, status, ...(reason ? { reason } : {}), steps, ms: Date.now() - started })

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
      const code = await exec(container, process.cwd(), {}, options.output ?? 'inherit')
      record(code === 0 ? 'passed' : 'failed', code === 0 ? undefined : `exit ${code}`)
      continue
    }
    const steps = await runSteps(job.steps, options)
    record(steps.some((s) => s.status === 'failed') ? 'failed' : 'passed', undefined, steps)
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
