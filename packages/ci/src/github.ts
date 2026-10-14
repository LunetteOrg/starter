// GitHub Actions: every workflow in .github/workflows, parsed and validated by
// @actions/workflow-parser, turned into the jobs the event triggers and what a local
// run does with each step. The converted template gives the events, jobs and
// normalized conditions; the parsed token tree gives what the template drops (`with`,
// `working-directory`, `shell`, `defaults`).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { localAction, SHELLS } from './actions.ts'
import type { CiConfig } from './config.ts'
import type { Event } from './event.ts'
import { type Context, evaluate, interpolate, type Outcome } from './expressions.ts'
import { type BranchFilters, branchFilter, type PathFilters, pathFilter } from './filters.ts'
import { cloudOnlyReason, type Job, type JobState, type Local, type Step } from './plan.ts'
import {
  convertWorkflowTemplate,
  isBasicExpression,
  isLiteral,
  isMapping,
  isSequence,
  isString,
  NoOperationTraceWriter,
  parseWorkflow,
  type WorkflowTemplate,
} from './workflow-parser.ts'

// The token types of the parsed tree, as the helpers below use them.
type Token = Parameters<typeof isMapping>[0]
type Mapping = Token & {
  find(key: string): Token | undefined
  [Symbol.iterator](): Iterator<{ key: Token; value: Token }>
}
type TemplateJob = WorkflowTemplate['jobs'][number]

// The pull_request actions after which a ready pull request runs its CI.
const READY_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review']

export function githubContext(event: Event, root: string): Record<string, unknown> {
  const common = {
    event_name: event.name,
    sha: event.sha,
    workspace: root,
    ...(event.repository ? { repository: event.repository, repository_owner: event.repository.split('/')[0] } : {}),
  }
  const repo = event.repository ? { repo: { full_name: event.repository } } : {}
  if (event.name === 'pull_request') {
    return {
      ...common,
      base_ref: event.base,
      head_ref: event.head,
      event: {
        action: 'synchronize',
        pull_request: {
          draft: false,
          base: { ref: event.base, ...repo },
          // The branch being checked lives in this repository, not in a fork.
          head: { ref: event.head, ...repo },
        },
      },
    }
  }
  return {
    ...common,
    ref: `refs/heads/${event.base}`,
    ref_name: event.base,
    base_ref: '',
    head_ref: '',
    event: { ref: `refs/heads/${event.base}` },
  }
}

// Whether `events` (a workflow's `on:`) runs on `event`, and why not.
export function triggered(events: WorkflowTemplate['events'], event: Event): { runs: boolean; reason: string } {
  const on = Object.keys(events).join(', ') || 'nothing'
  const config = events[event.name] as (BranchFilters & PathFilters & { types?: string[]; tags?: string[] }) | undefined
  if (config === undefined) return { runs: false, reason: `on: ${on}, not ${event.name}` }
  const into = event.name === 'pull_request' ? `a pull request into ${event.base}` : `a push to ${event.base}`
  if (event.name === 'pull_request' && config.types && !config.types.some((t) => READY_ACTIONS.includes(t))) {
    return { runs: false, reason: `pull_request types ${config.types.join(', ')} do not include a ready pull request` }
  }
  if (event.name === 'push' && config.tags && !config.branches && !config['branches-ignore']) {
    return { runs: false, reason: 'push runs on tags only' }
  }
  if (!branchFilter(config, event.base).match) return { runs: false, reason: `the branch filter excludes ${into}` }
  const paths = pathFilter(config, event.changed)
  if (!paths.match) return { runs: false, reason: `no changed file passes the path filter of ${into}` }
  return { runs: true, reason: paths.unknown ? 'path filter not evaluated: no local base to diff against' : '' }
}

function scalar(token: Token, context: Context): Outcome<string> {
  if (isBasicExpression(token)) return interpolate(token.expression, context)
  if (isString(token)) return { known: true, value: token.value }
  if (isLiteral(token)) return { known: true, value: String((token as unknown as { value: unknown }).value) }
  return { known: false, unknown: ['a value that is not a string'] }
}

// A mapping of strings (env, with), each value evaluated; the first value the local
// run cannot know makes the whole mapping unknown.
function strings(token: Token | undefined, context: Context): Outcome<Record<string, string>> {
  const values: Record<string, string> = {}
  if (!token || !isMapping(token)) return { known: true, value: values }
  const unknown: string[] = []
  for (const { key, value } of token as Mapping) {
    const name = isString(key) ? key.value : String(key)
    const outcome = scalar(value, { ...context, env: { ...(context.env as object), ...values } })
    if (outcome.known) values[name] = outcome.value
    else unknown.push(...outcome.unknown.map((u) => `${name}: ${u}`))
  }
  return unknown.length > 0 ? { known: false, unknown } : { known: true, value: values }
}

function find(token: Token | undefined, ...path: string[]): Token | undefined {
  let current = token
  for (const key of path) {
    if (!current || !isMapping(current)) return undefined
    current = (current as Mapping).find(key)
  }
  return current
}

function literal(token: Token | undefined): string | undefined {
  return token && isString(token) ? token.value : undefined
}

function why(unknown: string[]): string {
  const names = unknown.join(', ')
  const secret = unknown.find((u) => /\bsecrets\./.test(u))
  if (secret) return `needs ${names}: declare the secret in ci.local.fake.secrets, or its job in ci.local.cloudOnly`
  return `needs ${names}, which a local run cannot know`
}

function firstLine(text: string): string {
  const lines = text.trim().split('\n')
  return lines.length > 1 ? `${lines[0]} …` : lines[0]
}

interface StepScope {
  root: string
  config: CiConfig
  context: Context
  env: Record<string, string>
  defaults: { shell?: string; workingDirectory?: string }
}

function step(converted: TemplateJob & { type: 'job' }, index: number, raw: Token | undefined, scope: StepScope): Step {
  const source = converted.steps[index] as { if?: { expression: string }; run?: Token; uses?: Token; name?: Token }
  const name = source.name && isString(source.name) ? source.name.value : undefined
  const label = (text: string) => (name ? `${name} (${text})` : text)

  const env = strings(find(raw, 'env'), { ...scope.context, env: scope.env })
  const context = { ...scope.context, env: { ...scope.env, ...(env.known ? env.value : {}) } }
  const text = source.if?.expression
  const base =
    text && text !== 'success()'
      ? { condition: { text, decide: (failed: boolean) => evaluate(text, context, { failed }) } }
      : {}

  if (source.uses) {
    const uses = scalar(source.uses, context)
    const usesText = uses.known ? uses.value : String(source.uses)
    const inputs = strings(find(raw, 'with'), context)
    let local: Local
    if (!inputs.known) local = { kind: 'blocked', reason: why(inputs.unknown) }
    else local = localAction(usesText, inputs.value, scope.root, scope.config)
    return { label: label(`uses: ${usesText}`), ...base, local }
  }

  const runToken = source.run as Token
  const run = scalar(runToken, context)
  const written = isBasicExpression(runToken) ? (runToken.source ?? runToken.expression) : run.known ? run.value : ''
  const result = (local: Local): Step => ({ label: label(`run: ${firstLine(written)}`), ...base, local })
  if (!env.known) return result({ kind: 'blocked', reason: why(env.unknown) })
  if (!run.known) return result({ kind: 'blocked', reason: why(run.unknown) })
  const shellName = literal(find(raw, 'shell')) ?? scope.defaults.shell ?? 'bash'
  const shell = SHELLS[shellName]
  if (!shell) return result({ kind: 'fail', reason: `shell ${shellName} is not supported by ci:local (bash, sh)` })
  const directory = literal(find(raw, 'working-directory')) ?? scope.defaults.workingDirectory
  return result({
    kind: 'run',
    command: run.value,
    shell,
    cwd: directory ? join(scope.root, directory) : scope.root,
    env: { ...scope.env, ...env.value },
  })
}

function jobNotes(job: TemplateJob & { type: 'job' }): string[] {
  const notes: string[] = []
  const services =
    job.services && isMapping(job.services) ? [...(job.services as Mapping)].map(({ key }) => String(key)) : []
  if (services.length > 0) {
    notes.push(`services not started locally: ${services.join(', ')}; the run uses what the host provides`)
  }
  if (job.container) notes.push('the cloud runs it in a container; locally it runs on the host')
  return notes
}

async function workflowJobs(root: string, file: string, event: Event, config: CiConfig): Promise<Job[]> {
  const content = readFileSync(join(root, '.github/workflows', file), 'utf8')
  const parsed = parseWorkflow({ name: file, content }, new NoOperationTraceWriter())
  const errors = parsed.context.errors.getErrors()
  if (errors.length > 0 || !parsed.value) {
    throw new Error(`.github/workflows/${file}: ${errors.map((e) => e.message).join('; ') || 'not a workflow'}`)
  }
  const template = await convertWorkflowTemplate(parsed.context, parsed.value)
  const trigger = triggered(template.events, event)
  const rawRoot = parsed.value as Token
  const github = githubContext(event, root)
  const secrets = config.fake.secrets
  const vars = config.fake.vars

  const workflowEnv = strings(find(rawRoot, 'env'), { github, secrets, vars, env: {} })
  const jobs: Job[] = []
  for (const job of template.jobs) {
    const id = job.id.value
    const key = `${file}/${id}`
    const rawJob = find(rawRoot, 'jobs', id)
    const cloudOnly = cloudOnlyReason(config.cloudOnly, key, file)
    const base = {
      key,
      provider: 'github' as const,
      workflow: file,
      needs: (job.needs ?? []).map((n) => `${file}/${n.value}`),
    }

    let state: JobState = { state: 'run' }
    if (!trigger.runs) state = { state: 'skipped', reason: trigger.reason }
    else if (cloudOnly) state = { state: 'cloud-only', reason: cloudOnly }

    if (job.type !== 'job') {
      if (state.state === 'run') state = { state: 'blocked', reason: `calls the reusable workflow ${job.ref.value}` }
      jobs.push({ ...base, state, notes: [], steps: [] })
      continue
    }

    const jobEnv = strings(find(rawJob, 'env'), {
      github,
      secrets,
      vars,
      env: workflowEnv.known ? workflowEnv.value : {},
    })
    const env = { ...(workflowEnv.known ? workflowEnv.value : {}), ...(jobEnv.known ? jobEnv.value : {}) }
    const context: Context = { github, secrets, vars, env }

    if (state.state === 'run') {
      const condition = evaluate(job.if.expression, context, { failed: false })
      if (!condition.known)
        state = { state: 'blocked', reason: `condition ${job.if.expression} ${why(condition.unknown)}` }
      else if (!condition.value) state = { state: 'skipped', reason: `condition ${job.if.expression} is false` }
      else if (!workflowEnv.known || !jobEnv.known) {
        state = {
          state: 'blocked',
          reason: `env ${why([...(workflowEnv.known ? [] : workflowEnv.unknown), ...(jobEnv.known ? [] : jobEnv.unknown)])}`,
        }
      } else if (job.strategy && find(job.strategy as Token, 'matrix')) {
        state = { state: 'blocked', reason: 'a matrix job: ci:local does not expand matrices' }
      }
    }

    const defaults = {
      shell: literal(find(rawJob, 'defaults', 'run', 'shell')) ?? literal(find(rawRoot, 'defaults', 'run', 'shell')),
      workingDirectory:
        literal(find(rawJob, 'defaults', 'run', 'working-directory')) ??
        literal(find(rawRoot, 'defaults', 'run', 'working-directory')),
    }
    const rawSteps = find(rawJob, 'steps')
    const steps = job.steps.map((_, i) =>
      step(
        job,
        i,
        rawSteps && isSequence(rawSteps) ? (rawSteps as unknown as { get(i: number): Token }).get(i) : undefined,
        { root, config, context, env, defaults },
      ),
    )
    jobs.push({
      ...base,
      state,
      notes: [...(trigger.runs && trigger.reason ? [trigger.reason] : []), ...jobNotes(job)],
      steps,
      container: ['act', event.name, '-W', `.github/workflows/${file}`, '-j', id],
    })
  }
  return jobs
}

export async function githubJobs(root: string, event: Event, config: CiConfig): Promise<Job[]> {
  let files: string[]
  try {
    files = readdirSync(join(root, '.github/workflows'))
  } catch {
    return []
  }
  const jobs: Job[] = []
  for (const file of files.filter((f) => /\.ya?ml$/.test(f)).sort()) {
    jobs.push(...(await workflowJobs(root, file, event, config)))
  }
  return jobs
}
