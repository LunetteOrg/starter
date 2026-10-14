// What a CI configuration asks for, read from the provider's own files and turned
// into what a local run does with each job and step. Both providers' loaders produce
// this shape; the runner and the report read only this.

// What the local run does in place of one cloud step.
export type Local =
  // A shell command, as the cloud would run it, on the host.
  | { kind: 'run'; command: string; shell: string[]; cwd: string; env: Record<string, string> }
  // Nothing to do on a machine that already has the working tree (checkout, cache).
  | { kind: 'noop'; note: string }
  // A check of the host in place of an install step (setup-node reads .nvmrc).
  | { kind: 'check'; note: string; check: () => string | null }
  // Not run: it needs a value only the cloud has. Reported; --strict fails on it.
  | { kind: 'blocked'; reason: string }
  // Fails the run: a step the local run does not know how to stand in for, so a new
  // action or step type forces a decision instead of passing unnoticed.
  | { kind: 'fail'; reason: string }

export type Decision = { known: true; value: boolean } | { known: false; unknown: string[] }

export interface Condition {
  // As written: a GitHub Actions `if:`, a CircleCI `when:`.
  text: string
  // Whether the step runs, given whether the job has failed so far.
  decide: (failed: boolean) => Decision
}

// What a job's needs ended with, for its condition: success() when every need passed,
// failure() when one failed.
export interface NeedsOutcome {
  success: boolean
  failure: boolean
}

export interface JobCondition {
  text: string
  decide: (needs: NeedsOutcome) => Decision
}

export interface Step {
  // What the cloud runs, as written in the configuration.
  label: string
  // Without one, a step runs while the job has not failed.
  condition?: Condition
  local: Local
}

export type JobState =
  | { state: 'run' }
  // The cloud would not run it either: the trigger, a filter or a condition says no.
  | { state: 'skipped'; reason: string }
  // Declared in ci.local.cloudOnly: it needs the cloud (real secrets, a deploy).
  | { state: 'cloud-only'; reason: string }
  // The cloud would run it, or might, and the local run cannot: a condition it cannot
  // evaluate, a matrix, a reusable workflow. Reported; --strict fails on it.
  | { state: 'blocked'; reason: string }

export type Provider = 'github' | 'circleci'

export interface Job {
  // `<workflow file>/<job id>` for GitHub Actions, `circleci/<job>` for CircleCI: the
  // key ci.local.cloudOnly and --job use.
  key: string
  provider: Provider
  // The workflow it belongs to, for the report.
  workflow: string
  needs: string[]
  state: JobState
  // What differs from the cloud and is worth saying: services not started, the image
  // the cloud runs in, contexts whose variables are absent.
  notes: string[]
  // Decided after the needs have run. Without one, a job with needs runs when every
  // need passed.
  condition?: JobCondition
  steps: Step[]
  // How container mode starts this job, when the provider has a local executor.
  container?: string[]
}

// The keys of a job that ci.local.cloudOnly can name: the job itself, its whole
// workflow file, or for CircleCI the job alone.
export function cloudOnlyReason(cloudOnly: Record<string, string>, key: string, workflow: string): string | undefined {
  return cloudOnly[key] ?? cloudOnly[workflow]
}
