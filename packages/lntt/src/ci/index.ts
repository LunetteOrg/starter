// `lntt ci`: the CI of a Lunette project, run on the local machine from the
// provider's own configuration (`lntt ci local`, `pnpm ci:local`). The command runs on Effect
// (src/ci/local.ts); what the library exports here is its plain logic, and the run of a plan on
// Promise (src/ci/run.ts), which loads the Effect form when it is called.

export { actionName, versionMatches } from './actions.ts'
export { CircleciLoginRejected, mappingParameters, type Processor } from './circleci.ts'
export { evaluateWhen } from './circleci-when.ts'
export { type CiConfig, candidateConfigOf, ciConfigOf, emptyConfig } from './config.ts'
export type { Event, EventName, EventOptions } from './event.ts'
export { evaluate, interpolate } from './expressions.ts'
export { holdDeadline, type LockScope, MAX_HOLD_MINUTES } from './lock-rules.ts'
export type { Job, JobState, Local, Step } from './plan.ts'
export { formatList, formatReport } from './report.ts'
export { exitCode, type JobResult, machineLoad, runJobs, stopRunning, timeoutText } from './run.ts'
