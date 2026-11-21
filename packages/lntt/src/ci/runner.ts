// Native mode on Effect: each job's steps run in order on the host, from the working tree. Jobs
// follow `needs`; a job whose need failed is skipped, the others go on, so one run lists every red
// job. Within a job, a failed step skips the following ones unless their condition asks for a
// failure (`if: failure()`, `when: on_fail`).
//
// Each command is a child of Effect's spawner in a process group of its own (a session of its own:
// no controlling terminal, as on a CI runner), a resource of the step's scope. When it outlasts
// the timeout or the run passes its deadline, the step's fiber stops waiting and closes the scope;
// so does an interrupt of the run: the spawner sends SIGTERM to the group, waits up to
// `killAfterMs` for it to go, then sends SIGKILL (docs/adr/effect-in-lntt.md#services). A command
// that passed leaves what it started in the background running, as the cloud does for the job's
// next steps; a command that failed takes its group with it. The library's Promise form is
// `runJobs` in src/ci/run.ts.

import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import type { Job, Local, Step } from './plan.ts'
import {
  type JobResult,
  type JobStatus,
  KILL_AFTER_MS,
  loadLine,
  needsOutcome,
  ordered,
  type StepResult,
  type StepStatus,
  timeoutText,
} from './run.ts'

// The machine a run reports when it stops a command: its load average and its cores.
export class Machine extends Context.Service<
  Machine,
  { readonly load: Effect.Effect<readonly number[]>; readonly cores: number }
>()('@lntt/lntt/ci/runner/Machine') {
  static memory(load: readonly number[], cores: number) {
    return Layer.succeed(Machine)(Machine.of({ load: Effect.succeed(load), cores }))
  }
}

export interface RunOptions {
  log: (line: string) => Effect.Effect<void>
  // Where the commands' output goes: the terminal, or nowhere.
  output?: 'inherit' | 'ignore'
  // Run only these job keys; the others are reported as not selected.
  only?: string[]
  onJob?: (key: string) => Effect.Effect<void>
  // Container mode: the job runs whole through this command, from `root`, instead of step by step.
  container?: (job: Job) => string[] | null
  root?: string
  // How long one step (in container mode, one job) may run; none without it.
  timeoutMs?: number
  // When the whole run stops (ms since the epoch), and why: the running command is stopped as on
  // a timeout, and what is left is skipped with the reason.
  deadline?: { at: number; reason: string }
  // What the machine is doing when a command is stopped (default: machineLoad).
  load?: Effect.Effect<string>
  // Once done, no step or job starts, and the running command is stopped: the library's
  // interrupt, which still gives the results. The command interrupts the run instead.
  stop?: Deferred.Deferred<void>
  // The process group of the command that starts, then null once it is gone.
  onGroup?: (group: number | null) => Effect.Effect<void>
  // Between the SIGTERM to a stopped command's group and its SIGKILL (default 5 s).
  killAfterMs?: number
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// How many containers `docker ps` lists with `filter`, or null when Docker does not answer within
// three seconds.
const containers = (...filter: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const docker = yield* spawner.spawn(
        ChildProcess.make('docker', ['ps', '-q', ...filter], {
          stdin: 'ignore',
          stderr: 'ignore',
          killSignal: 'SIGKILL',
        }),
      )
      const [out, code] = yield* Effect.all([text(docker.stdout), docker.exitCode], { concurrency: 'unbounded' })
      return code === 0 ? out.split('\n').filter((line) => line !== '').length : null
    }),
  ).pipe(
    Effect.timeoutOption(Duration.seconds(3)),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  )

// The load average, the cores, and the containers running (Testcontainers' among them): what
// tells a slow machine from a hung test. Without Docker, no containers are named.
export const machineLoad = Effect.gen(function* () {
  const machine = yield* Machine
  const [load, all, testcontainers] = yield* Effect.all(
    [machine.load, containers(), containers('--filter', 'label=org.testcontainers=true')],
    { concurrency: 'unbounded' },
  )
  return loadLine(load, machine.cores, all, testcontainers)
})

interface Outcome {
  status: StepStatus
  reason?: string
  timedOut?: boolean
}

// What one run shares between its jobs: whether it passed its deadline.
interface RunState {
  overrun: boolean
}

const INTERRUPTED: Outcome = { status: 'skipped', reason: 'interrupted' }

const stopped = (options: RunOptions) => (options.stop ? Deferred.isDone(options.stop) : Effect.succeed(false))

// Why nothing more starts in this run, or null.
const halted = (options: RunOptions, state: RunState) =>
  Effect.map(stopped(options), (stop) => {
    if (stop) return 'interrupted'
    if (state.overrun) return options.deadline?.reason ?? null
    return null
  })

// A load that cannot be read does not hold the step's outcome back.
const readLoad = (options: RunOptions) =>
  (options.load ?? machineLoad).pipe(Effect.catchCause(() => Effect.succeed('load unavailable')))

// Once the run has passed its deadline, the step about to start is where it stopped, whatever its
// kind: it fails with the reason and the load, and what is left is skipped.
const pastDeadline = Effect.fnUntraced(function* (options: RunOptions, state: RunState) {
  const deadline = options.deadline
  if (!deadline || (yield* Clock.currentTimeMillis) < deadline.at) return null
  state.overrun = true
  const load = yield* readLoad(options)
  return { status: 'failed', reason: `${deadline.reason} — ${load}`, timedOut: true } satisfies Outcome
})

type Ending = { kind: 'exit'; code: number } | { kind: 'timer' } | { kind: 'stop' }

const exec = Effect.fnUntraced(function* (
  argv: string[],
  cwd: string | undefined,
  env: Record<string, string>,
  options: RunOptions,
  state: RunState,
) {
  if (yield* stopped(options)) return INTERRUPTED
  const past = yield* pastDeadline(options, state)
  if (past) return past
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const deadline = options.deadline
  const untilDeadline = deadline ? deadline.at - (yield* Clock.currentTimeMillis) : Number.POSITIVE_INFINITY
  const byDeadline = untilDeadline < (options.timeoutMs ?? Number.POSITIVE_INFINITY)
  const delay = Math.min(untilDeadline, options.timeoutMs ?? Number.POSITIVE_INFINITY)
  const output = options.output ?? 'inherit'
  const run = Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(argv[0] as string, argv.slice(1), {
          ...(cwd === undefined ? {} : { cwd }),
          env: { CI: 'true', ...env },
          extendEnv: true,
          stdin: 'ignore',
          stdout: output,
          stderr: output,
          killSignal: 'SIGTERM',
          forceKillAfter: Duration.millis(options.killAfterMs ?? KILL_AFTER_MS),
        }),
      )
      if (options.onGroup) yield* options.onGroup(child.pid)
      const racers: Effect.Effect<Ending>[] = [
        // A command ended by a signal has no exit code: 128, as a shell reads it.
        child.exitCode.pipe(
          Effect.map((code): Ending => ({ kind: 'exit', code: Number(code) })),
          Effect.orElseSucceed((): Ending => ({ kind: 'exit', code: 128 })),
        ),
      ]
      // The Clock chains its timers past their 32-bit range: a long delay does not fire at once.
      if (Number.isFinite(delay))
        racers.push(Effect.as(Effect.sleep(Duration.millis(Math.max(0, delay))), { kind: 'timer' }))
      if (options.stop) racers.push(Effect.as(Deferred.await(options.stop), { kind: 'stop' }))
      const ending = yield* Effect.raceAll(racers)
      if (ending.kind === 'exit' && ending.code === 0) yield* child.unref
      // The load is read while the scope's release stops the group, not before it.
      const load = ending.kind === 'timer' ? yield* Effect.forkChild(readLoad(options)) : null
      return { ending, load }
    }),
  ).pipe(
    // A command that cannot start, as a shell reads it.
    Effect.orElseSucceed(() => ({ ending: { kind: 'exit', code: 127 } as Ending, load: null })),
    Effect.ensuring(options.onGroup ? options.onGroup(null) : Effect.void),
  )
  const { ending, load } = yield* run
  if (ending.kind === 'exit') {
    return (ending.code === 0 ? { status: 'passed' } : { status: 'failed', reason: `exit ${ending.code}` }) as Outcome
  }
  if (ending.kind === 'stop') return { status: 'failed', reason: 'interrupted' } as Outcome
  if (byDeadline) state.overrun = true
  const reason = byDeadline && deadline ? deadline.reason : `timed out after ${timeoutText(options.timeoutMs ?? 0)}`
  const read = load ? yield* Fiber.join(load) : 'load unavailable'
  return { status: 'failed', reason: `${reason} — ${read}`, timedOut: true } as Outcome
})

const runLocal = Effect.fnUntraced(function* (local: Local, options: RunOptions, state: RunState) {
  const past = yield* pastDeadline(options, state)
  if (past) return past
  switch (local.kind) {
    case 'noop':
      return { status: 'noop', reason: local.note } as Outcome
    case 'blocked':
      return { status: 'blocked', reason: local.reason } as Outcome
    case 'fail':
      return { status: 'failed', reason: local.reason } as Outcome
    case 'check': {
      const problem = local.check()
      return (problem ? { status: 'failed', reason: problem } : { status: 'passed', reason: local.note }) as Outcome
    }
    case 'run':
      return yield* exec([...local.shell, local.command], local.cwd, local.env, options, state)
  }
})

const runSteps = Effect.fnUntraced(function* (steps: Step[], options: RunOptions, state: RunState) {
  const results: StepResult[] = []
  let failed = false
  for (const step of steps) {
    const stop = yield* halted(options, state)
    if (stop) {
      results.push({ label: step.label, status: 'skipped', reason: stop })
      continue
    }
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
    if (step.local.kind === 'run') yield* options.log(`  ▶ ${step.label}`)
    const started = yield* Clock.currentTimeMillis
    const result = yield* runLocal(step.local, options, state)
    if (result.status === 'failed') failed = true
    results.push({ label: step.label, ...result, ms: (yield* Clock.currentTimeMillis) - started })
  }
  return results
})

// Runs the jobs: their results in the configuration's order.
export const runJobs = Effect.fnUntraced(function* (jobs: Job[], options: RunOptions) {
  const results = new Map<string, JobResult>()
  const state: RunState = { overrun: false }
  for (const job of ordered(jobs)) {
    const started = yield* Clock.currentTimeMillis
    const record = (status: JobStatus, reason?: string, steps: StepResult[] = [], timedOut = false) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        results.set(job.key, {
          key: job.key,
          status,
          ...(reason ? { reason } : {}),
          steps,
          ms: now - started,
          ...(timedOut ? { timedOut } : {}),
        })
      })

    if (options.only && !options.only.includes(job.key)) {
      yield* record('not-selected', 'not selected with --job')
      continue
    }
    if (job.state.state !== 'run') {
      yield* record(job.state.state, job.state.reason)
      continue
    }
    const stop = yield* halted(options, state)
    if (stop) {
      yield* record('skipped', stop)
      continue
    }
    if (job.needs.length > 0) {
      const { needs, after } = needsOutcome(job, results)
      const decision = job.condition ? job.condition.decide(needs) : { known: true as const, value: needs.success }
      if (!decision.known) {
        yield* record('blocked', `condition ${job.condition?.text} needs ${decision.unknown.join(', ')}`)
        continue
      }
      if (!decision.value) {
        yield* record(
          'skipped',
          `${job.condition ? `condition ${job.condition.text} is false` : 'not every need passed'} (${after})`,
        )
        continue
      }
    }
    if (options.onJob) yield* options.onJob(job.key)
    yield* options.log(`● ${job.key}`)
    const container = options.container?.(job)
    if (container) {
      yield* options.log(`  ▶ ${container.join(' ')}`)
      const outcome = yield* exec(container, options.root, {}, options, state)
      yield* record(outcome.status === 'passed' ? 'passed' : 'failed', outcome.reason, [], outcome.timedOut)
      continue
    }
    const steps = yield* runSteps(job.steps, options, state)
    const timedOut = steps.filter((s) => s.timedOut).map((s) => s.label)
    yield* record(
      steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
      timedOut.length > 0 ? `${timedOut.join(', ')} timed out` : undefined,
      steps,
    )
  }
  return jobs.map((job) => results.get(job.key) as JobResult)
})
