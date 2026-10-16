// CircleCI: .circleci/config.yml expanded by `circleci config process` (orbs,
// commands, job parameters), then read with `yaml`. Which workflows run is decided
// here, from the raw file's `when:` and the event's pipeline values, because the CLI
// evaluates `when:` without them; the CLI processes a copy with every `when:` removed,
// so it drops nothing.
//
// A dynamic configuration (`setup: true`) is followed to its continuation: a job of
// the chosen setup workflow that takes `config-path` (path-filtering) or
// `configuration_path` (continuation) names the file, and the path-filtering
// `mapping` sets the continuation's parameters from the files changed against its
// `base-revision`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { evaluateWhen, type PipelineValues, substituteParameters } from './circleci-when.ts'
import type { CiConfig } from './config.ts'
import { changedAgainst, type Event } from './event.ts'
import { cloudOnlyReason, type Job, type JobState, type Local, type Step } from './plan.ts'

export interface Processed {
  config: unknown
  // The processed configuration on disk, for `circleci local execute`.
  file?: string
}

// Expands a configuration's text, with these pipeline parameters.
export type Processor = (path: string, text: string, parameters: Record<string, unknown>) => Processed

export function cliProcessor(root: string): Processor {
  const dir = mkdtempSync(join(tmpdir(), 'lntt-ci-circleci-'))
  let n = 0
  return (path, text, parameters) => {
    const source = join(dir, `source-${++n}.yml`)
    writeFileSync(source, text)
    let out: string
    try {
      out = execFileSync(
        'circleci',
        [
          '--skip-update-check',
          'config',
          'process',
          ...(Object.keys(parameters).length > 0 ? ['--pipeline-parameters', JSON.stringify(parameters)] : []),
          source,
        ],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      const e = error as { code?: string; stderr?: string }
      if (e.code === 'ENOENT') throw new Error('the circleci CLI is not installed (brew install circleci)')
      throw new Error(`circleci config process ${path}: ${e.stderr?.trim() ?? String(error)}`)
    }
    const file = join(dir, `processed-${n}.yml`)
    writeFileSync(file, out)
    return { config: parse(out), file }
  }
}

type Map = Record<string, unknown>

const DEFAULT_SHELL = ['/bin/bash', '-eo', 'pipefail', '-c']

// Steps that move data between the cloud's jobs and services; locally the working
// tree is already there.
const NO_OPS: Record<string, string> = {
  checkout: 'the working tree is the checkout',
  restore_cache: 'no cloud cache on a local run',
  save_cache: 'no cloud cache on a local run',
  store_test_results: 'results stay in the working tree',
  store_artifacts: 'artifacts stay in the working tree',
  persist_to_workspace: 'one working tree, no workspace to pass on',
  attach_workspace: 'one working tree, no workspace to pass on',
  setup_remote_docker: 'the host Docker is used',
  add_ssh_keys: 'the host keys are used',
}

function entryOf(entry: unknown): { name: string; args: Map } {
  if (typeof entry === 'string') return { name: entry, args: {} }
  const [name, args] = Object.entries(entry as Map)[0]
  return { name, args: (args as Map | null) ?? {} }
}

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(String)
}

function branchMatches(patterns: string[], branch: string): boolean {
  return patterns.some((p) =>
    p.startsWith('/') && p.endsWith('/') ? new RegExp(`^${p.slice(1, -1)}$`).test(branch) : p === branch,
  )
}

// Whether the workflow job's `filters` let the branch run it, and why not.
function filtersAllow(args: Map, branch: string): string | null {
  const branches = (args.filters as Map | undefined)?.branches as Map | undefined
  if (!branches) return null
  const only = asList(branches.only)
  if (only.length > 0 && !branchMatches(only, branch)) return `filters.branches.only excludes ${branch}`
  if (branchMatches(asList(branches.ignore), branch)) return `filters.branches.ignore excludes ${branch}`
  return null
}

function typed(value: string): unknown {
  if (value === 'true' || value === 'false') return value === 'true'
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value.replace(/^(['"])(.*)\1$/, '$2')
}

// The parameters a path-filtering `mapping` sets: a line `regex parameter value`
// applies when a changed file matches the whole regex.
export function mappingParameters(mapping: string, changed: string[]): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  for (const line of mapping.split('\n')) {
    const [regex, name, value] = line.trim().split(/\s+/)
    if (!regex || !name || value === undefined) continue
    const pattern = new RegExp(`^${regex}$`)
    if (changed.some((file) => pattern.test(file))) parameters[name] = typed(value)
  }
  return parameters
}

function runStep(value: unknown, jobEnv: Record<string, string>, root: string): Step {
  const run: Map = typeof value === 'string' ? { command: value } : (value as Map)
  const command = String(run.command ?? '')
  const name = run.name ? String(run.name) : command.trim().split('\n')[0]
  const env = { ...jobEnv, ...((run.environment as Record<string, string> | undefined) ?? {}) }
  const shell = run.shell ? [...String(run.shell).split(/\s+/), '-c'] : DEFAULT_SHELL
  const cwd = run.working_directory ? join(root, String(run.working_directory).replace(/^~\/project\/?/, '')) : root
  const when = (run.when as string | undefined) ?? 'on_success'
  const condition =
    when === 'on_success'
      ? {}
      : {
          condition: {
            text: `when: ${when}`,
            decide: (failed: boolean) => ({ known: true as const, value: when === 'always' || failed }),
          },
        }
  const local: Local = run.background
    ? { kind: 'blocked', reason: 'a background step: ci:local runs steps one after the other' }
    : { kind: 'run', command, shell, cwd, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) }
  return { label: `run: ${name}`, ...condition, local }
}

function steps(definition: Map, env: Record<string, string>, root: string): Step[] {
  return ((definition.steps as unknown[] | undefined) ?? []).map((step) => {
    const { name } = entryOf(step)
    if (name === 'run') return runStep(typeof step === 'string' ? '' : (step as Map).run, env, root)
    if (NO_OPS[name]) return { label: name, local: { kind: 'noop', note: NO_OPS[name] } }
    return {
      label: name,
      local: {
        kind: 'fail',
        reason: `step ${name} has no local equivalent: declare its job in ci.local.cloudOnly, or tell ci:local about it`,
      },
    }
  })
}

function notes(definition: Map): string[] {
  const images = ((definition.docker as Map[] | undefined) ?? []).map((d) => String(d.image))
  const result: string[] = []
  if (images[0]) result.push(`the cloud runs it in ${images[0]}; locally it runs on the host`)
  if (images.length > 1) result.push(`secondary images not started locally: ${images.slice(1).join(', ')}`)
  if (definition.machine) result.push('the cloud runs it on a machine executor; locally it runs on the host')
  return result
}

interface Scope {
  root: string
  event: Event
  config: CiConfig
  processor: Processor
  values: PipelineValues
}

function configJobs(scope: Scope, path: string, parameters: Record<string, unknown>, state: JobState): Job[] {
  const text = readFileSync(join(scope.root, path), 'utf8')
  const raw = (parse(text) ?? {}) as Map
  const defaults = Object.fromEntries(
    Object.entries((raw.parameters as Record<string, Map> | undefined) ?? {}).map(([k, v]) => [k, v?.default]),
  )
  const params = { ...defaults, ...parameters }
  const substituted = substituteParameters(raw, params)
  const rawWorkflows = ((raw.workflows as Map | undefined) ?? {}) as Record<string, Map>
  const stripped = {
    ...raw,
    workflows: Object.fromEntries(
      Object.entries(rawWorkflows).map(([name, w]) => {
        if (name === 'version' || typeof w !== 'object') return [name, w]
        const { when: _when, unless: _unless, ...rest } = w
        return [name, rest]
      }),
    ),
  }
  const processed = scope.processor(path, stringify(stripped), params)
  const config = processed.config as Map
  const definitions = (config.jobs as Record<string, Map> | undefined) ?? {}
  const workflows = (config.workflows as Record<string, Map> | undefined) ?? {}
  const setup = raw.setup === true
  const branch = scope.event.name === 'pull_request' ? scope.event.head : scope.event.base
  const fake = scope.config.fake.secrets

  const jobs: Job[] = []
  for (const [workflow, rawWorkflow] of Object.entries(rawWorkflows)) {
    if (workflow === 'version' || typeof rawWorkflow !== 'object') continue
    const label = `${path}:${workflow}`
    const sub = (substituted.workflows as Record<string, Map>)[workflow]
    const decision =
      sub.unless !== undefined ? evaluateWhen({ not: sub.unless }, scope.values) : evaluateWhen(sub.when, scope.values)
    let workflowState: JobState = state
    if (state.state === 'run') {
      if (!decision.known)
        workflowState = { state: 'blocked', reason: `${label}: when needs ${decision.unknown.join(', ')}` }
      else if (!decision.value) workflowState = { state: 'skipped', reason: `${label}: when is false for this event` }
    }
    const rawEntries = (rawWorkflow.jobs as unknown[] | undefined) ?? []
    const entries = ((workflows[workflow]?.jobs as unknown[] | undefined) ?? []).map(entryOf)
    for (const [i, entry] of entries.entries()) {
      const rawArgs = entryOf(rawEntries[i]).args
      const continuation = setup ? (rawArgs['config-path'] ?? rawArgs.configuration_path) : undefined
      const name = entry.args.name ? String(entry.args.name) : entry.name
      let key = `circleci/${name}`
      if (jobs.some((j) => j.key === key)) key = `circleci/${workflow}/${name}`
      const needs = asList(entry.args.requires).map((r) => `circleci/${r}`)
      const definition = definitions[entry.name] ?? {}
      const base = { key, provider: 'circleci' as const, workflow: label, needs, notes: notes(definition) }

      if (typeof continuation === 'string') {
        if (workflowState.state !== 'run') {
          jobs.push({ ...base, state: workflowState, steps: steps(definition, {}, scope.root) })
          continue
        }
        let next: Record<string, unknown> = {}
        let nextState: JobState = { state: 'run' }
        if (typeof rawArgs.mapping === 'string') {
          const revision = String(rawArgs['base-revision'] ?? 'main')
          const changed = changedAgainst(scope.root, revision)
          if (changed === null) {
            nextState = {
              state: 'blocked',
              reason: `the mapping needs a diff against ${revision}, which has no local ref`,
            }
          } else next = mappingParameters(rawArgs.mapping, changed)
        }
        const shown =
          Object.entries(next)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ') || 'no parameters'
        jobs.push({
          ...base,
          state: {
            state: 'cloud-only',
            reason: `chooses the continuation ${continuation} (${shown}); ci:local follows it`,
          },
          steps: steps(definition, {}, scope.root),
        })
        jobs.push(...configJobs(scope, continuation, next, nextState))
        continue
      }

      let jobState = workflowState
      const cloudOnly = cloudOnlyReason(scope.config.cloudOnly, key, `circleci/${workflow}`)
      const filtered = filtersAllow(entry.args, branch)
      const contexts = asList(entry.args.context)
      if (jobState.state === 'run') {
        if (filtered) jobState = { state: 'skipped', reason: filtered }
        else if (cloudOnly) jobState = { state: 'cloud-only', reason: cloudOnly }
        else if (contexts.length > 0) {
          jobState = {
            state: 'blocked',
            reason: `uses context ${contexts.join(', ')}, whose variables only the cloud has: declare the job in ci.local.cloudOnly`,
          }
        }
      }
      const env = { ...((definition.environment as Record<string, string> | undefined) ?? {}), ...fake }
      jobs.push({
        ...base,
        state: jobState,
        steps: steps(definition, Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), scope.root),
        ...(processed.file ? { container: ['circleci', 'local', 'execute', '-c', processed.file, entry.name] } : {}),
      })
    }
  }
  return jobs
}

export function circleciJobs(
  root: string,
  event: Event,
  config: CiConfig,
  processor: Processor = cliProcessor(root),
): Job[] {
  let present = true
  try {
    readFileSync(join(root, '.circleci/config.yml'))
  } catch {
    present = false
  }
  if (!present) return []
  const values: PipelineValues = {
    'pipeline.event.name': event.name,
    'pipeline.git.branch': event.name === 'pull_request' ? event.head : event.base,
    ...(event.name === 'pull_request' ? { 'pipeline.event.github.pull_request.base.ref': event.base } : {}),
  }
  return configJobs({ root, event, config, processor, values }, '.circleci/config.yml', {}, { state: 'run' })
}
