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
import { AgentFailed, AgentTimedOut, runAgent, STOP_GRACE, withAgents } from './agents.ts'

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
      seen.push(record)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          record.released = true
        }),
      )
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
      const out = yield* runAgent(invocation, { timeoutMinutes: 10, env: { PATH: '/bin' } })
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
      yield* runAgent(invocation, {
        timeoutMinutes: 10,
        env: { PATH: '/bin', ORCA_AGENT_HOOK_URL: 'http://x', HERDR_PANE: '3' },
      })
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
        const error = yield* Effect.flip(runAgent(invocation, { timeoutMinutes: 10, env: {} }))
        assert.instanceOf(error, AgentFailed)
        assert.strictEqual(error.message, 'claude exited 2: two three four')
      }).pipe(Effect.provide(spawner.layer))
    },
  )

  it.effect('names stdout when the agent fails with nothing on stderr', () => {
    const spawner = inMemorySpawner({ code: 1, stdout: 'not logged in' })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runAgent(invocation, { timeoutMinutes: 10, env: {} }))
      assert.strictEqual(error.message, 'claude exited 1: not logged in')
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect('releases the agent and fails with AgentTimedOut once its minutes are over', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(runAgent(invocation, { timeoutMinutes: 3, env: {} })))
      yield* TestClock.adjust(Duration.minutes(3))
      const error = yield* Fiber.join(fiber)
      assert.instanceOf(error, AgentTimedOut)
      assert.strictEqual(error.message, 'timed out after 3 minutes')
      assert.strictEqual(spawner.seen[0]?.released, true)
    }).pipe(Effect.provide(spawner.layer))
  })
})

describe('withAgents', () => {
  it.effect('a spawn aborted by its signal rejects with the reason, once the agent is released', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const outcome = yield* withAgents(({ spawner: spawnFor }) =>
        Effect.promise(async () => {
          const stop = new AbortController()
          const running = spawnFor(10)(invocation, stop.signal)
          await new Promise((r) => setTimeout(r, 10))
          stop.abort('stopped: the other agents answered 60s before')
          return running.then(
            () => 'resolved',
            (error: Error) => `${error.message} | released: ${spawner.seen[0]?.released}`,
          )
        }),
      )
      assert.strictEqual(outcome, 'stopped: the other agents answered 60s before | released: true')
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect('an interrupted command ends only once its running agents are released', () => {
    const spawner = inMemorySpawner({ hang: true })
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      // The round's Promise code starts an agent and goes on waiting, as askAll does.
      const command = withAgents(({ spawner: spawnFor }) =>
        Effect.gen(function* () {
          void spawnFor(10)(invocation).catch(() => {})
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      )
      const fiber = yield* Effect.forkChild(command)
      yield* Deferred.await(started)
      assert.strictEqual(spawner.seen[0]?.released, false)
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      assert.isTrue(Exit.hasInterrupts(exit))
      assert.strictEqual(spawner.seen[0]?.released, true)
    }).pipe(Effect.provide(spawner.layer))
  })
})
