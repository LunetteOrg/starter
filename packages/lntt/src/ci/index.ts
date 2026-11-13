// `lntt ci`: the CI of a Lunette project, run on the local machine from the
// provider's own configuration (`lntt ci local`, `pnpm ci:local`). The command runs on Effect
// (src/ci/local.ts); what the library exports here keeps its synchronous and Promise forms, over
// the same plain logic (src/ci/sync.ts, src/ci/lock-sync.ts, src/ci/run.ts).

export { actionName, versionMatches } from './actions.ts'
export * as candidate from './candidate.ts'
export { CircleciLoginRejected, mappingParameters, type Processor } from './circleci.ts'
export { evaluateWhen } from './circleci-when.ts'
export { type CiConfig, candidateConfig, ciConfig, emptyConfig } from './config.ts'
export type { Event, EventName, EventOptions } from './event.ts'
export { evaluate, interpolate } from './expressions.ts'
export { holdDeadline, type LockScope, MAX_HOLD_MINUTES } from './lock-rules.ts'
export { acquireLock, type Lock, LockError } from './lock-sync.ts'
export type { Job, JobState, Local, Step } from './plan.ts'
export { type Proved, type ProvedInput, proved } from './proved.ts'
export { formatList, formatReport } from './report.ts'
export { exitCode, type JobResult, machineLoad, runJobs, stopRunning, timeoutText } from './run.ts'
export {
  circleciJobs,
  circleciUnavailable,
  cliProcessor,
  containerCommand,
  defaultBranch,
  githubJobs,
  localAction,
  localEvent,
  missingTools,
} from './sync.ts'
