import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { SHELLS } from './actions.ts'
import type { Event } from './event.ts'
import type { Job, Local, Step } from './plan.ts'
import { formatReport } from './report.ts'
import { exitCode, ordered, timeoutText } from './run.ts'
import { Machine, machineLoad, type RunOptions, runJobs } from './runner.ts'

// What a command does in memory: it exits with `code` after `delayMs` on the Clock, never exits
// (`hang`), or cannot start (`missing`); `stdout` is what it prints.
interface Script {
  code?: number
  delayMs?: number
  hang?: boolean
  missing?: boolean
  stdout?: string
}

// What the in-memory spawner saw of one command, and whether its scope released it (when the real
// spawner stops its process group) or it was let go (unref: its background survives).
interface Seen {
  argv: string[]
  cwd: string | undefined
  env: Record<string, unknown> | undefined
  extendEnv: boolean | undefined
  killSignal: string | undefined
  forceKillAfter: Duration.Input | undefined
  pid: number
  released: boolean
  unref: boolean
}

const encode = (text: string) => new TextEncoder().encode(text)

function inMemorySpawner(script: (argv: string[]) => Script = () => ({})) {
  const seen: Seen[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const argv = [command.command, ...command.args.map(String)]
      const behaviour = script(argv)
      if (behaviour.missing) {
        return yield* Effect.fail(
          PlatformError.systemError({ _tag: 'NotFound', module: 'ChildProcess', method: 'spawn' }),
        )
      }
      const { options } = command
      const record: Seen = {
        argv,
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.extendEnv,
        killSignal: options.killSignal,
        forceKillAfter: options.forceKillAfter,
        pid: 100 + seen.length,
        released: false,
        unref: false,
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          record.released = true
        }),
      )
      seen.push(record)
      const code = behaviour.code ?? 0
      const exitCode = behaviour.hang
        ? Effect.never
        : Effect.as(Effect.sleep(Duration.millis(behaviour.delayMs ?? 0)), ChildProcessSpawner.ExitCode(code))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(record.pid),
        exitCode,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(behaviour.stdout ?? '')),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.sync(() => {
          record.unref = true
          return Effect.void
        }),
      })
    })
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn))
  return { seen, layer }
}

const command = (local: string, env: Record<string, string> = {}): Local => ({
  kind: 'run',
  command: local,
  shell: SHELLS.bash,
  cwd: '/work',
  env,
})

function job(key: string, steps: Step[], extra: Partial<Job> = {}): Job {
  return { key, provider: 'github', workflow: 'ci.yml', needs: [], state: { state: 'run' }, notes: [], steps, ...extra }
}

// The TestClock's time when a spec starts.
const START = 0

const quiet: RunOptions = { log: () => Effect.void, output: 'ignore' }
const failure = { text: 'failure()', decide: (failed: boolean) => ({ known: true as const, value: failed }) }

// Commands by their last argument: `exit N` exits N, `hang` never exits.
const byCommand = (argv: string[]): Script => {
  const last = argv[argv.length - 1] ?? ''
  if (last === 'hang') return { hang: true }
  const exit = /^exit (\d+)$/.exec(last)
  return exit ? { code: Number(exit[1]) } : {}
}

// Runs the jobs with the in-memory spawner and a machine of load 1.0 on 4 cores, moving the
// TestClock by `advance` ms once they started.
const running = (jobs: Job[], options: Partial<RunOptions>, spawner = inMemorySpawner(byCommand), advance = 0) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(runJobs(jobs, { ...quiet, ...options }))
    if (advance > 0) yield* TestClock.adjust(Duration.millis(advance))
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(Layer.merge(spawner.layer, Machine.memory([1, 1, 1], 4))))

describe('runJobs', () => {
  it.effect('runs the steps in order, each a shell command with its env and CI=true, in a group of its own', () => {
    const spawner = inMemorySpawner()
    return Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'one', local: command('echo one', { X: 'x' }) },
            { label: 'two', local: command('echo two') },
          ]),
        ],
        {},
        spawner,
      )
      assert.deepStrictEqual(
        spawner.seen.map((s) => s.argv.at(-1)),
        ['echo one', 'echo two'],
      )
      const [one] = spawner.seen
      assert.deepStrictEqual(one?.argv, [...SHELLS.bash, 'echo one'])
      assert.strictEqual(one?.cwd, '/work')
      assert.deepStrictEqual(one?.env, { CI: 'true', X: 'x' })
      assert.strictEqual(one?.extendEnv, true)
      assert.strictEqual(one?.killSignal, 'SIGTERM')
      assert.deepStrictEqual(one?.forceKillAfter, Duration.millis(5000))
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => s.status),
        ['passed', 'passed'],
      )
      assert.strictEqual(results[0]?.status, 'passed')
    })
  })

  it.effect('leaves what a passing command started in the background running; a failing one takes its group', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      yield* running(
        [
          job('ci.yml/a', [
            { label: 'ok', local: command('true') },
            { label: 'no', local: command('exit 1') },
          ]),
        ],
        {},
        spawner,
      )
      assert.deepStrictEqual(
        spawner.seen.map((s) => [s.unref, s.released]),
        [
          [true, true],
          [false, true],
        ],
      )
    })
  })

  it.effect('after a failure only the steps that ask for it run', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'boom', local: command('exit 3') },
            { label: 'next', local: command('echo next') },
            { label: 'report', condition: failure, local: command('echo report') },
          ]),
        ],
        {},
        spawner,
      )
      assert.deepStrictEqual(
        spawner.seen.map((s) => s.argv.at(-1)),
        ['exit 3', 'echo report'],
      )
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason]),
        [
          ['failed', 'exit 3'],
          ['skipped', 'an earlier step failed'],
          ['passed', undefined],
        ],
      )
      assert.strictEqual(results[0]?.status, 'failed')
      assert.strictEqual(exitCode(results, { strict: false }), 1)
    })
  })

  it.effect('a command that cannot start fails with 127, as a shell reads it', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'x', local: command('x') }])],
        {},
        inMemorySpawner(() => ({ missing: true })),
      )
      assert.deepStrictEqual([results[0]?.steps[0]?.status, results[0]?.steps[0]?.reason], ['failed', 'exit 127'])
    }),
  )

  it.effect('no-ops, checks, blocked steps and unknown steps', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'checkout', local: { kind: 'noop', note: 'tree' } },
            { label: 'node', local: { kind: 'check', note: 'n', check: () => null } },
            { label: 'secret', local: { kind: 'blocked', reason: 'needs secrets.X' } },
            { label: 'pnpm', local: { kind: 'check', note: 'p', check: () => 'pnpm missing' } },
          ]),
        ],
        {},
      )
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason]),
        [
          ['noop', 'tree'],
          ['passed', 'n'],
          ['blocked', 'needs secrets.X'],
          ['failed', 'pnpm missing'],
        ],
      )
    }),
  )

  it.effect('a condition the run cannot evaluate blocks the step', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            {
              label: 'x',
              condition: {
                text: 'steps.a.outputs.b',
                decide: () => ({ known: false, unknown: ['steps.a.outputs.b'] }),
              },
              local: command('true'),
            },
          ]),
        ],
        {},
      )
      assert.strictEqual(results[0]?.steps[0]?.status, 'blocked')
      assert.strictEqual(results[0]?.status, 'passed')
    }),
  )

  it.effect('jobs follow needs; a job whose need failed is skipped; the others go on', () =>
    Effect.gen(function* () {
      const jobs = [
        job('ci.yml/deploy', [{ label: 'd', local: command('true') }], { needs: ['ci.yml/build'] }),
        job('ci.yml/build', [{ label: 'b', local: command('exit 1') }]),
        job('ci.yml/lint', [{ label: 'l', local: command('true') }]),
      ]
      assert.deepStrictEqual(
        ordered(jobs).map((j) => j.key),
        ['ci.yml/build', 'ci.yml/deploy', 'ci.yml/lint'],
      )
      const started: string[] = []
      const results = yield* running(jobs, { onJob: (key) => Effect.sync(() => started.push(key)) })
      assert.deepStrictEqual(started, ['ci.yml/build', 'ci.yml/lint'])
      assert.deepStrictEqual(Object.fromEntries(results.map((r) => [r.key, r.status])), {
        'ci.yml/build': 'failed',
        'ci.yml/deploy': 'skipped',
        'ci.yml/lint': 'passed',
      })
    }),
  )

  it.effect('cloud-only, skipped and blocked jobs are reported, not run; --strict fails on blocked', () => {
    const spawner = inMemorySpawner()
    return Effect.gen(function* () {
      const results = yield* running(
        [
          job('release.yml/release', [{ label: 'p', local: command('no') }], {
            state: { state: 'cloud-only', reason: 'publishes' },
          }),
          job('ci.yml/b', [{ label: 'x', local: command('no') }], { state: { state: 'blocked', reason: 'matrix' } }),
          job('ci.yml/c', [{ label: 'y', local: { kind: 'blocked', reason: 'secret' } }]),
        ],
        {},
        spawner,
      )
      assert.deepStrictEqual(
        results.map((r) => [r.status, r.reason]),
        [
          ['cloud-only', 'publishes'],
          ['blocked', 'matrix'],
          ['passed', undefined],
        ],
      )
      assert.strictEqual(spawner.seen.length, 0)
      assert.strictEqual(exitCode(results, { strict: false }), 0)
      assert.strictEqual(exitCode(results, { strict: true }), 1)
    })
  })

  it.effect('--job runs only the jobs named; the others are not selected', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [{ label: 'a', local: command('true') }]),
          job('ci.yml/b', [{ label: 'b', local: command('true') }]),
        ],
        { only: ['ci.yml/b'] },
      )
      assert.deepStrictEqual(
        results.map((r) => [r.key, r.status, r.reason]),
        [
          ['ci.yml/a', 'not-selected', 'not selected with --job'],
          ['ci.yml/b', 'passed', undefined],
        ],
      )
    }),
  )
})

describe('job conditions after needs', () => {
  const onNeeds = (text: string, f: (n: { success: boolean; failure: boolean }) => boolean) => ({
    text,
    decide: (n: { success: boolean; failure: boolean }) => ({ known: true as const, value: f(n) }),
  })

  it.effect('always() and failure() jobs run after a failed need; a success() job does not', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/build', [{ label: 'b', local: command('exit 1') }]),
          job('ci.yml/deploy', [{ label: 'd', local: command('true') }], {
            needs: ['ci.yml/build'],
            condition: onNeeds('success()', (n) => n.success),
          }),
          job('ci.yml/notify', [{ label: 'n', local: command('true') }], {
            needs: ['ci.yml/build'],
            condition: onNeeds('failure()', (n) => n.failure),
          }),
          job('ci.yml/cleanup', [{ label: 'c', local: command('true') }], {
            needs: ['ci.yml/build'],
            condition: onNeeds('always()', () => true),
          }),
        ],
        {},
      )
      assert.deepStrictEqual(
        results.map((r) => [r.key, r.status]),
        [
          ['ci.yml/build', 'failed'],
          ['ci.yml/deploy', 'skipped'],
          ['ci.yml/notify', 'passed'],
          ['ci.yml/cleanup', 'passed'],
        ],
      )
    }),
  )

  it.effect('a need that is cloud-only, blocked or skipped makes success() false; without a condition too', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/release', [], { state: { state: 'cloud-only', reason: 'r' } }),
          job('ci.yml/after', [{ label: 'a', local: command('true') }], {
            needs: ['ci.yml/release'],
            condition: onNeeds('success()', (n) => n.success),
          }),
          job('circleci/next', [{ label: 'n', local: command('true') }], { needs: ['ci.yml/release'] }),
        ],
        {},
      )
      assert.deepStrictEqual(
        results.map((r) => r.status),
        ['cloud-only', 'skipped', 'skipped'],
      )
      assert.match(results[1]?.reason ?? '', /ci\.yml\/release: cloud-only/)
      assert.match(results[2]?.reason ?? '', /^not every need passed/)
    }),
  )
})

describe('timeouts', () => {
  it.effect('a step that outlasts the timeout is released (its group stopped) and fails naming the load', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'hang', local: command('hang') },
            { label: 'next', local: command('echo next') },
            { label: 'report', condition: failure, local: command('echo report') },
          ]),
        ],
        { timeoutMs: 300, load: Effect.succeed('load 9.0 / 8.0 / 7.0 on 4 cores') },
        spawner,
        300,
      )
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason, s.timedOut]),
        [
          ['failed', 'timed out after 0.3s — load 9.0 / 8.0 / 7.0 on 4 cores', true],
          ['skipped', 'an earlier step failed', undefined],
          ['passed', undefined, undefined],
        ],
      )
      assert.deepStrictEqual([results[0]?.status, results[0]?.reason], ['failed', 'hang timed out'])
      assert.deepStrictEqual(
        spawner.seen.map((s) => [s.argv.at(-1), s.released, s.unref]),
        [
          ['hang', true, false],
          ['echo report', true, true],
        ],
      )
    })
  })

  it.effect('in container mode the timeout is the whole job, run from the root', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'x', local: command('true') }])],
        {
          container: () => ['act', 'hang'],
          root: '/repo',
          timeoutMs: 200,
          load: Effect.succeed('load 1.0 / 1.0 / 1.0 on 2 cores'),
        },
        spawner,
        200,
      )
      assert.deepStrictEqual(
        [results[0]?.status, results[0]?.reason, results[0]?.timedOut],
        ['failed', 'timed out after 0.2s — load 1.0 / 1.0 / 1.0 on 2 cores', true],
      )
      assert.deepStrictEqual(spawner.seen[0]?.argv, ['act', 'hang'])
      assert.strictEqual(spawner.seen[0]?.cwd, '/repo')
    })
  })

  it.effect('a step within the timeout passes, and no load is read', () =>
    Effect.gen(function* () {
      let read = 0
      const results = yield* running([job('ci.yml/a', [{ label: 'quick', local: command('true') }])], {
        timeoutMs: 5000,
        load: Effect.sync(() => `load ${++read}`),
      })
      assert.strictEqual(results[0]?.status, 'passed')
      assert.strictEqual(read, 0)
    }),
  )

  it.effect(
    'a timeout well before the deadline fails its step alone: the run goes on, failure() steps included',
    () => {
      const spawner = inMemorySpawner(byCommand)
      return Effect.gen(function* () {
        const results = yield* running(
          [
            job('ci.yml/a', [
              { label: 'hang', local: command('hang') },
              { label: 'report', condition: failure, local: command('echo report') },
            ]),
            job('ci.yml/b', [{ label: 'b', local: command('echo b') }]),
          ],
          { timeoutMs: 100, deadline: { at: START + 60_000, reason: 'the deadline' }, load: Effect.succeed('load') },
          spawner,
          100,
        )
        assert.deepStrictEqual(
          results[0]?.steps.map((s) => [s.status, s.reason]),
          [
            ['failed', 'timed out after 0.1s — load'],
            ['passed', undefined],
          ],
        )
        assert.strictEqual(results[1]?.status, 'passed')
      })
    },
  )

  // The Clock chains its timers past their 32-bit range (MAX_TIMER_MILLIS in effect's
  // internal/effect.ts): the run only has to hand it the delay as it is.
  it.effect('a timeout past the range of the host timers does not fire at once', () =>
    Effect.gen(function* () {
      let read = 0
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'slow', local: command('slow') }])],
        { timeoutMs: 2 ** 40, load: Effect.sync(() => `load ${++read}`) },
        inMemorySpawner(() => ({ delayMs: 200 })),
        200,
      )
      assert.strictEqual(results[0]?.status, 'passed')
      assert.strictEqual(read, 0)
    }),
  )

  it.effect('the step is released before the load is read', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'hang', local: command('hang') }])],
        {
          timeoutMs: 100,
          // A slow Docker: the load answers once the step is released.
          load: Effect.gen(function* () {
            while (!spawner.seen[0]?.released) yield* Effect.yieldNow
            return 'released first'
          }),
        },
        spawner,
        100,
      )
      assert.strictEqual(results[0]?.steps[0]?.reason, 'timed out after 0.1s — released first')
    })
  })

  it.effect('a load that cannot be read does not hold the step back', () =>
    Effect.gen(function* () {
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'hang', local: command('hang') }])],
        { timeoutMs: 100, load: Effect.die('no load') },
        undefined,
        100,
      )
      assert.strictEqual(results[0]?.steps[0]?.reason, 'timed out after 0.1s — load unavailable')
    }),
  )

  it('a timeout in minutes reads in minutes', () => {
    assert.strictEqual(timeoutText(300), '0.3s')
    assert.strictEqual(timeoutText(59_000), '59s')
    assert.strictEqual(timeoutText(30 * 60_000), '30m')
    assert.strictEqual(timeoutText(90_000), '1.5m')
  })

  it.effect('the report prints the timeout next to the step and says it is not a verdict', () =>
    Effect.gen(function* () {
      const event: Event = {
        name: 'pull_request',
        base: 'main',
        head: 'feat/x',
        sha: '0123456789abcdef',
        baseRef: 'main',
        changed: [],
        repository: null,
        defaultBranch: 'main',
      }
      const results = yield* running(
        [job('ci.yml/a', [{ label: 'hang', local: command('hang') }])],
        {
          timeoutMs: 100,
          load: Effect.succeed('load 48.2 / 31.0 / 20.5 on 15 cores, 9 containers running (7 Testcontainers)'),
        },
        undefined,
        100,
      )
      const report = formatReport(event, results, { strict: false })
      assert.match(report, /✖ ci\.yml\/a .* failed: hang timed out/)
      assert.match(
        report,
        /✖ hang .*\(timed out after 0\.1s — load 48\.2 \/ 31\.0 \/ 20\.5 on 15 cores, 9 containers running \(7 Testcontainers\)\)/,
      )
      assert.match(report, /A timeout is not a verdict on the code/)
      const green = yield* running([job('ci.yml/a', [{ label: 'q', local: command('true') }])], {})
      assert.notMatch(formatReport(event, green, { strict: false }), /timeout/)
    }),
  )
})

describe('the deadline', () => {
  const reason = "the run passed the lock's maximum hold time of 120 minutes"

  it.effect('stops the running step, and skips what is left with its reason', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'long', local: command('hang') },
            { label: 'report', condition: failure, local: command('echo report') },
          ]),
          job('ci.yml/b', [{ label: 'b', local: command('echo b') }]),
        ],
        { timeoutMs: 60_000, deadline: { at: 200, reason }, load: Effect.succeed('load 1.0') },
        spawner,
        200,
      )
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason, s.timedOut]),
        [
          ['failed', `${reason} — load 1.0`, true],
          ['skipped', reason, undefined],
        ],
      )
      assert.deepStrictEqual([results[1]?.status, results[1]?.reason], ['skipped', reason])
      assert.strictEqual(exitCode(results, { strict: false }), 1)
      assert.deepStrictEqual(
        spawner.seen.map((s) => s.argv.at(-1)),
        ['hang'],
      )
    })
  })

  it.effect('passed when a step is about to start, fails it with the load whatever its kind, and skips the rest', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.millis(100))
      const results = yield* running(
        [
          job('ci.yml/a', [
            { label: 'one', local: { kind: 'noop', note: 'nothing to do' } },
            { label: 'two', local: command('echo two') },
          ]),
          job('ci.yml/b', [{ label: 'b', local: { kind: 'noop', note: 'nothing to do' } }]),
        ],
        { deadline: { at: 50, reason }, load: Effect.succeed('load 2.0') },
      )
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason]),
        [
          ['failed', `${reason} — load 2.0`],
          ['skipped', reason],
        ],
      )
      assert.deepStrictEqual([results[1]?.status, results[1]?.reason], ['skipped', reason])
    }),
  )
})

describe('stopping', () => {
  it.effect('a stop starts no further step, failure() steps and later jobs included, and stops the running one', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const stop = yield* Deferred.make<void>()
      const groups: (number | null)[] = []
      const fiber = yield* Effect.forkChild(
        runJobs(
          [
            job('ci.yml/a', [
              { label: 'long', local: command('hang') },
              { label: 'report', condition: failure, local: command('echo report') },
            ]),
            job('ci.yml/b', [{ label: 'b', local: command('echo b') }]),
          ],
          { ...quiet, stop, onGroup: (group) => Effect.sync(() => groups.push(group)) },
        ),
      )
      while (groups.length === 0) yield* Effect.yieldNow
      yield* Deferred.succeed(stop, undefined)
      const results = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        results[0]?.steps.map((s) => [s.status, s.reason]),
        [
          ['failed', 'interrupted'],
          ['skipped', 'interrupted'],
        ],
      )
      assert.deepStrictEqual([results[1]?.status, results[1]?.reason], ['skipped', 'interrupted'])
      assert.deepStrictEqual(groups, [100, null])
      assert.strictEqual(spawner.seen[0]?.released, true)
      assert.strictEqual(spawner.seen.length, 1)
    }).pipe(Effect.provide(Layer.merge(spawner.layer, Machine.memory([1, 1, 1], 4))))
  })

  it.effect('an interrupt of the run releases the running step and records no group left', () => {
    const spawner = inMemorySpawner(byCommand)
    return Effect.gen(function* () {
      const groups: (number | null)[] = []
      const fiber = yield* Effect.forkChild(
        runJobs([job('ci.yml/a', [{ label: 'long', local: command('hang') }])], {
          ...quiet,
          onGroup: (group) => Effect.sync(() => groups.push(group)),
        }),
      )
      while (groups.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(spawner.seen[0]?.released, true)
      assert.deepStrictEqual(groups, [100, null])
    }).pipe(Effect.provide(Layer.merge(spawner.layer, Machine.memory([1, 1, 1], 4))))
  })
})

describe('machineLoad', () => {
  const load = (docker: (argv: string[]) => Script) =>
    machineLoad.pipe(Effect.provide(Layer.merge(inMemorySpawner(docker).layer, Machine.memory([1.25, 2, 3.04], 8))))

  it.effect('names the load average and the cores; without Docker, no containers', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* load(() => ({ missing: true })), 'load 1.3 / 2.0 / 3.0 on 8 cores')
    }),
  )

  it.effect('with Docker answering, the containers running and the Testcontainers among them', () =>
    Effect.gen(function* () {
      const answering = (testcontainers: Script) => (argv: string[]) =>
        argv.includes('--filter') ? testcontainers : { stdout: 'a\nb\nc\n' }
      assert.strictEqual(
        yield* load(answering({ stdout: 't\n' })),
        'load 1.3 / 2.0 / 3.0 on 8 cores, 3 containers running (1 Testcontainers)',
      )
      assert.strictEqual(yield* load(answering({ code: 1 })), 'load 1.3 / 2.0 / 3.0 on 8 cores, 3 containers running')
    }),
  )

  it.effect('a Docker that does not answer within three seconds names no containers', () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(load(() => ({ hang: true })))
      yield* TestClock.adjust(Duration.seconds(3))
      assert.strictEqual(yield* Fiber.join(fiber), 'load 1.3 / 2.0 / 3.0 on 8 cores')
    }),
  )
})
