import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import type { Invocation } from '../headless.ts'
import { AgentFailed, AgentsProcesses, runAgent, STOP_GRACE } from './agents.ts'
import { Agents, askAll } from './asking.ts'

// What the in-memory spawner saw of one agent: what it was started with, and when its scope
// closed, which is when the real spawner signals the agent's process group.
interface Seen {
  command: string
  args: readonly string[]
  env: Record<string, unknown> | undefined
  extendEnv: boolean | undefined
  detached: boolean | undefined
  killSignal: string | undefined
  forceKillAfter: Duration.Input | undefined
  stdin: string
  released: boolean
}

// One agent's behaviour: it exits with `code` after printing, or never exits (`hang`).
interface Script {
  stdout?: string
  stderr?: string
  code?: number
  hang?: boolean
}

const encode = (text: string) => new TextEncoder().encode(text)

function inMemorySpawner(script: Script) {
  const seen: Seen[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const { options } = command
      const input = options.stdin
      const stdin = Stream.isStream(input)
        ? yield* Stream.mkString(Stream.decodeText(input as Stream.Stream<Uint8Array>))
        : ''
      const record: Seen = {
        command: command.command,
        args: command.args.map(String),
        env: options.env,
        extendEnv: options.extendEnv,
        detached: options.detached,
        killSignal: options.killSignal,
        forceKillAfter: options.forceKillAfter,
        stdin,
        released: false,
      }
      // Seen once its release is in place, as the real spawner acquires a process.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          record.released = true
        }),
      )
      seen.push(record)
      const exited = yield* Deferred.make<number>()
      if (!script.hang) yield* Deferred.succeed(exited, script.code ?? 0)
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(seen.length),
        exitCode: Effect.map(Deferred.await(exited), ChildProcessSpawner.ExitCode),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(script.stdout ?? '')),
        stderr: Stream.make(encode(script.stderr ?? '')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn))
  return { seen, layer }
}

const invocation: Invocation = {
  command: 'claude',
  args: ['-p', '--output-format', 'json'],
  env: { LNTT_REVIEW: '1' },
  stdin: 'the prompt',
}

describe('runAgent', () => {
  it.effect('starts the agent in a process group of its own, with the prompt on stdin, and gives its stdout', () => {
    const spawner = inMemorySpawner({ stdout: '{"result":"ok"}' })
    return Effect.gen(function* () {
      const out = yield* runAgent(invocation, { env: { PATH: '/bin' } })
      assert.strictEqual(out, '{"result":"ok"}')
      const [seen] = spawner.seen
      assert.strictEqual(seen?.command, 'claude')
      assert.deepStrictEqual(seen?.args, ['-p', '--output-format', 'json'])
      assert.strictEqual(seen?.stdin, 'the prompt')
      // detached is the spawner's default: left unset, the agent leads a group of its own.
      assert.strictEqual(seen?.detached, undefined)
      assert.strictEqual(seen?.killSignal, 'SIGTERM')
      assert.strictEqual(seen?.forceKillAfter, STOP_GRACE)
      assert.strictEqual(seen?.released, true)
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect('gives the agent only the environment lntt chose: no host hook variable, no inherited one', () => {
    const spawner = inMemorySpawner({})
    return Effect.gen(function* () {
      yield* runAgent(invocation, { env: { PATH: '/bin', ORCA_AGENT_HOOK_URL: 'http://x', HERDR_PANE: '3' } })
      const [seen] = spawner.seen
      assert.strictEqual(seen?.extendEnv, false)
      assert.deepStrictEqual(seen?.env, { PATH: '/bin', LNTT_REVIEW: '1' })
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect(
    'fails with AgentFailed, the exit code and the last three lines of stderr, when the agent exits non-zero',
    () => {
      const spawner = inMemorySpawner({ code: 2, stdout: 'partial', stderr: 'one\ntwo\nthree\nfour\n' })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(runAgent(invocation, { env: {} }))
        assert.instanceOf(error, AgentFailed)
        assert.strictEqual(error.message, 'claude exited 2: two three four')
      }).pipe(Effect.provide(spawner.layer))
    },
  )

  it.effect('names stdout when the agent fails with nothing on stderr', () => {
    const spawner = inMemorySpawner({ code: 1, stdout: 'not logged in' })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runAgent(invocation, { env: {} }))
      assert.strictEqual(error.message, 'claude exited 1: not logged in')
    }).pipe(Effect.provide(spawner.layer))
  })
})

// askAll over the agents of the machine, on the in-memory spawner: how an agent's process ends
// when askAll stops it, times it out or is interrupted.
describe('the agents as processes', () => {
  const question = { agent: { kind: 'claude' as const }, prompt: 'the prompt', label: 'code · claude' }
  const asked = <A, E, R>(effect: Effect.Effect<A, E, R>, spawner: ReturnType<typeof inMemorySpawner>) =>
    effect.pipe(Effect.provide(AgentsProcesses.pipe(Layer.provide(spawner.layer))))

  it.effect('an agent still running at its timeout is released, and its answer is the timeout', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(askAll([question], { timeoutMinutes: 3 }))
      yield* TestClock.adjust(Duration.subtract(Duration.minutes(3), Duration.seconds(1)))
      assert.strictEqual(spawner.seen[0]?.released, false, 'still running a second before its minutes are over')
      yield* TestClock.adjust(Duration.seconds(1))
      assert.deepStrictEqual(yield* Fiber.join(fiber), [{ ok: false, error: 'timed out after 3 minutes' }])
      assert.strictEqual(spawner.seen[0]?.released, true)
    }).pipe((effect) => asked(effect, spawner))
  })

  it.effect('a stop answers with its reason once the agent is released', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const stop = yield* Deferred.make<string>()
      const released: boolean[] = []
      const fiber = yield* Effect.forkChild(
        askAll([question], {
          stop,
          progress: (event) =>
            Effect.sync(() => {
              if (event.type === 'end') released.push(spawner.seen[0]?.released === true)
            }),
        }),
      )
      while (spawner.seen.length < 1) yield* Effect.yieldNow
      yield* Deferred.succeed(stop, 'the round took longer than 60 minutes')
      assert.deepStrictEqual(yield* Fiber.join(fiber), [{ ok: false, error: 'the round took longer than 60 minutes' }])
      assert.deepStrictEqual(released, [true], 'released before its end is reported')
    }).pipe((effect) => asked(effect, spawner))
  })

  it.effect("an agent's own failure is its answer, and the agent gets lntt's environment", () => {
    const spawner = inMemorySpawner({ code: 2, stderr: 'quota exceeded' })
    return Effect.gen(function* () {
      process.env.LNTT_SPEC_INHERITED = 'yes'
      const answers = yield* askAll([question]).pipe(
        Effect.ensuring(Effect.sync(() => delete process.env.LNTT_SPEC_INHERITED)),
      )
      assert.deepStrictEqual(answers, [{ ok: false, error: 'claude exited 2: quota exceeded' }])
      assert.strictEqual(spawner.seen[0]?.env?.LNTT_SPEC_INHERITED, 'yes')
      assert.strictEqual(spawner.seen[0]?.extendEnv, false)
    }).pipe((effect) => asked(effect, spawner))
  })

  it.effect('an interrupted askAll ends only once its running agents are released', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(askAll([question, question]))
      while (spawner.seen.length < 2) yield* Effect.yieldNow
      assert.deepStrictEqual(
        spawner.seen.map((s) => s.released),
        [false, false],
      )
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.deepStrictEqual(
        spawner.seen.map((s) => s.released),
        [true, true],
      )
    }).pipe((effect) => asked(effect, spawner))
  })

  it.effect('what keeps an agent from starting: a CLI the shell does not find, or no read-only mode', () => {
    const spawner = inMemorySpawner({ code: 1 })
    return Effect.gen(function* () {
      const agents = yield* Agents
      const problems = yield* agents.problems([{ kind: 'claude', model: 'sonnet' }, { kind: 'codex' }])
      assert.deepStrictEqual(problems, [
        'claude sonnet: claude is not on the PATH',
        'codex: codex has no read-only headless mode here; the agents are claude, opencode',
      ])
      assert.deepStrictEqual(spawner.seen[0]?.args, ['-c', 'command -v "claude"'])
      assert.strictEqual(spawner.seen.length, 1, 'no shell for an agent that cannot be made read-only')
    }).pipe((effect) => asked(effect, spawner))
  })

  it.effect('a CLI the shell finds is no problem', () => {
    const spawner = inMemorySpawner({ code: 0 })
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* (yield* Agents).problems([{ kind: 'opencode', model: 'x/y' }]), [])
      assert.deepStrictEqual(spawner.seen[0]?.args, ['-c', 'command -v "opencode"'])
    }).pipe((effect) => asked(effect, spawner))
  })
})
