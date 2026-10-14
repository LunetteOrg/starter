// What ci:local prints: the plan (--list), and the outcome of a run.

import type { Event } from './event.ts'
import type { Job, Local } from './plan.ts'
import type { JobResult, StepStatus } from './run.ts'

export function describeEvent(event: Event): string {
  const what =
    event.name === 'pull_request'
      ? `pull request ${event.head} → ${event.base}`
      : `push of ${event.head} to ${event.base}`
  const base = event.baseRef
    ? `diff against ${event.baseRef}`
    : `no local ref for ${event.base}: path filters not evaluated`
  const changed = event.changed === null ? '' : `, ${event.changed.length} files changed`
  return `${what} @ ${event.sha.slice(0, 8)} (${base}${changed})`
}

function local(l: Local): string {
  switch (l.kind) {
    case 'run':
      return 'runs on the host'
    case 'noop':
      return `no-op: ${l.note}`
    case 'check':
      return `checks: ${l.note}`
    case 'blocked':
      return `not run: ${l.reason}`
    case 'fail':
      return `FAILS: ${l.reason}`
  }
}

function jobLine(job: Job): string {
  switch (job.state.state) {
    case 'run':
      return 'runs locally'
    case 'skipped':
      return `not triggered: ${job.state.reason}`
    case 'cloud-only':
      return `cloud only: ${job.state.reason}`
    case 'blocked':
      return `not run: ${job.state.reason}`
  }
}

// Per job, what the cloud runs and what the local run does in its place.
export function formatList(event: Event, jobs: Job[]): string {
  const lines = [`ci:local — ${describeEvent(event)}`, '']
  if (jobs.length === 0) lines.push('No CI configuration found (.github/workflows, .circleci/config.yml).')
  for (const job of jobs) {
    lines.push(`${job.key}  [${job.workflow}]  ${jobLine(job)}`)
    if (job.needs.length > 0) {
      const after = job.condition ? `, then if ${job.condition.text}` : ''
      lines.push(`    needs ${job.needs.join(', ')}${after}`)
    }
    for (const note of job.notes) lines.push(`    note: ${note}`)
    for (const step of job.steps) {
      const condition = step.condition ? `  if ${step.condition.text}` : ''
      // The condition as the job starts: no step has failed yet.
      const decision = step.condition?.decide(false)
      let action = local(step.local)
      if (decision && !decision.known) action = `not run: the condition needs ${decision.unknown.join(', ')}`
      else if (decision && !decision.value) action = 'skipped: the condition is false for this event'
      lines.push(`    ${step.label}${condition}`)
      lines.push(`      → ${action}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

const STEP_MARK: Record<StepStatus, string> = { passed: '✔', failed: '✖', skipped: '–', noop: '·', blocked: '⚠' }

const seconds = (ms: number | undefined) => (ms === undefined ? '' : `  ${(ms / 1000).toFixed(1)}s`)

export function formatReport(event: Event, results: JobResult[], { strict }: { strict: boolean }): string {
  const lines = ['', `ci:local — ${describeEvent(event)}`, '']
  const mark = { passed: '✔', failed: '✖', skipped: '–', 'cloud-only': '☁', blocked: '⚠', 'not-selected': '·' } as const
  for (const result of results) {
    const reason = result.reason ? `  ${result.status}: ${result.reason}` : ''
    lines.push(`${mark[result.status]} ${result.key}${result.steps.length > 0 ? seconds(result.ms) : ''}${reason}`)
    for (const step of result.steps) {
      const why = step.reason && step.status !== 'passed' ? `  (${step.reason})` : ''
      lines.push(
        `    ${STEP_MARK[step.status]} ${step.label}${step.status === 'passed' || step.status === 'failed' ? seconds(step.ms) : ''}${why}`,
      )
    }
  }
  const count = (status: string) => results.filter((r) => r.status === status).length
  const blockedSteps = results.flatMap((r) => r.steps).filter((s) => s.status === 'blocked').length
  lines.push(
    '',
    [
      `${count('passed')} passed`,
      `${count('failed')} failed`,
      `${count('cloud-only')} cloud only`,
      // The cloud would skip them too: trigger, filter, condition, or a need that did not pass.
      `${count('skipped')} skipped`,
      ...(count('not-selected') > 0 ? [`${count('not-selected')} not selected with --job`] : []),
      `${count('blocked')} jobs and ${blockedSteps} steps not run`,
    ].join(', '),
  )
  if (!strict && (count('blocked') > 0 || blockedSteps > 0)) {
    lines.push('Not run (⚠) does not fail the run; --strict makes it fail.')
  }
  return lines.join('\n')
}
