import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import { memoryFileSystem } from '../testing/file-system.ts'
import { run, type Start, type Steps, startGit, startHerdr } from './hosts.ts'
import { runSteps } from './steps.ts'

const encode = (text: string) => new TextEncoder().encode(text)

type Reply = { out?: string; err?: string; code?: number } | 'missing'

// The tools as a spawner in memory: each call recorded as one line, answered by the first key of
// `replies` it starts with; a tool with no reply prints nothing and exits 0.
function tools(replies: Record<string, Reply> = {}) {
  const calls: string[] = []
  const fs = memoryFileSystem({ dirs: ['/repo/.worktrees'] })
  const spawn = (cmd: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (cmd._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const line = [cmd.command, ...cmd.args.map(String)].join(' ')
      calls.push(cmd.options.cwd ? `${line} (in ${cmd.options.cwd})` : line)
      const key = Object.keys(replies).find((k) => line.startsWith(k))
      const reply = key === undefined ? {} : replies[key]
      if (reply === 'missing') {
        return yield* PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
          pathOrDescriptor: cmd.command,
        })
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply?.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(reply?.out ?? '')),
        stderr: Stream.make(encode(reply?.err ?? '')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = Layer.mergeAll(
    fs.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)),
    Layer.fresh(TestConsole.layer),
  )
  return { calls, fs, layer }
}

const START: Start = {
  issue: 78,
  title: 'Start an agent',
  branch: 'feat/78/start-agent',
  base: 'origin/main',
  agent: null,
  root: '/repo',
  brief: 'BRIEF',
}

function* one(command: string, args: string[]): Steps<string> {
  return yield* run(command, args)
}

describe('the steps on Effect', () => {
  it.effect('a tool’s stdout, trimmed, is its result; what it said on stderr reaches the person after it', () => {
    const t = tools({ orca: { out: '  out \n', err: 'a note' } })
    return Effect.gen(function* () {
      assert.strictEqual(yield* runSteps(one('orca', ['x'])), 'out')
      assert.deepStrictEqual(yield* TestConsole.errorLines, ['a note'])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect('a refusal carries Orca’s reason, else what the tool printed, else its exit code', () => {
    const t = tools({
      'orca a': { out: JSON.stringify({ ok: false, error: { message: 'no such pane' } }), code: 2 },
      'git b': { err: 'error: branch has no upstream information', code: 1 },
      'herdr c': { code: 3 },
      lost: 'missing',
    })
    return Effect.gen(function* () {
      const reason = (command: string, args: string[]) =>
        Effect.map(Effect.flip(runSteps(one(command, args))), (error) => error.message)
      assert.strictEqual(yield* reason('orca', ['a']), 'orca a: no such pane')
      assert.strictEqual(yield* reason('git', ['b']), 'git b: error: branch has no upstream information')
      assert.strictEqual(yield* reason('herdr', ['c']), 'herdr c failed (exit 3)')
      assert.match(yield* reason('lost', []), /^lost could not start: /)
      assert.deepStrictEqual(yield* TestConsole.errorLines, [], 'nothing besides the error')
    }).pipe(Effect.provide(t.layer))
  })

  it.effect(
    'plain git: the worktree on its branch, then the setup its own orca.yaml declares, its output on stderr',
    () => {
      const t = tools({ bash: { out: 'installing\nready\n' } })
      return Effect.gen(function* () {
        yield* t.fs.put('/repo/.worktrees/feat-78-start-agent/orca.yaml', 'scripts:\n  setup: |\n    pnpm install\n')
        const started = yield* runSteps(startGit(START))
        assert.deepStrictEqual(started, {
          host: 'git',
          issue: 78,
          branch: 'feat/78/start-agent',
          path: '/repo/.worktrees/feat-78-start-agent',
          agent: null,
        })
        assert.deepStrictEqual(t.calls, [
          'git worktree add --no-track -b feat/78/start-agent /repo/.worktrees/feat-78-start-agent origin/main (in /repo)',
          'bash -e -c pnpm install\n (in /repo/.worktrees/feat-78-start-agent)',
        ])
        assert.deepStrictEqual(yield* TestConsole.errorLines, ['installing', 'ready'])
      }).pipe(Effect.provide(t.layer))
    },
  )

  it.effect('a setup that fails stops the start; a worktree with no orca.yaml has none', () => {
    const t = tools({ bash: { code: 1 } })
    return Effect.gen(function* () {
      yield* runSteps(startGit({ ...START, branch: 'feat/79/other' }))
      assert.strictEqual(t.calls.length, 1, 'no setup without orca.yaml')
      yield* t.fs.put('/repo/.worktrees/feat-78-start-agent/orca.yaml', 'scripts:\n  setup: exit 1\n')
      const error = yield* Effect.flip(runSteps(startGit(START)))
      assert.strictEqual(error.message, 'the setup in /repo/.worktrees/feat-78-start-agent failed (exit 1)')
    }).pipe(Effect.provide(t.layer))
  })

  it.effect('a failure the adapter expects is caught inside it: Herdr’s branch with no upstream to unset', () => {
    const t = tools({
      'herdr worktree create': { out: JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }) },
      'git branch --unset-upstream': { err: 'fatal: branch has no upstream information', code: 128 },
    })
    return Effect.gen(function* () {
      const started = yield* runSteps(startHerdr({ ...START, agent: { kind: 'claude' } }))
      assert.strictEqual(started.agent, 'feat-78-start-agent')
      assert.deepStrictEqual(
        t.calls.map((call) => call.split(' ').slice(0, 3).join(' ')),
        ['herdr worktree create', 'git branch --unset-upstream', 'herdr agent start', 'herdr agent prompt'],
      )
    }).pipe(Effect.provide(t.layer))
  })

  it.effect('what an adapter throws is a failure of the start, by its message', () => {
    const t = tools({ 'herdr worktree create': { out: '{}' } })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runSteps(startHerdr({ ...START, agent: { kind: 'claude' } })))
      assert.deepStrictEqual(
        [error._tag, error.message],
        ['ToolFailed', 'no pane found in the workspace herdr created: {}'],
      )
    }).pipe(Effect.provide(t.layer))
  })

  it.effect('a pause is on the Clock: Herdr gets a second between looks for the agent, sixty times', () => {
    const t = tools({
      'herdr worktree create': { out: JSON.stringify({ result: { pane: { pane_id: 'w2:p1' } } }) },
      'herdr agent list': { out: JSON.stringify({ agents: [] }) },
    })
    return Effect.gen(function* () {
      const opencode = { kind: 'opencode', model: 'opencode/big-pickle' }
      const starting = yield* Effect.forkChild(Effect.flip(runSteps(startHerdr({ ...START, agent: opencode }))))
      const looks = () => t.calls.filter((call) => call === 'herdr agent list').length
      yield* TestClock.adjust('10 millis')
      assert.strictEqual(looks(), 1)
      yield* TestClock.adjust('1 second')
      assert.strictEqual(looks(), 2, 'one more look a second later')
      yield* TestClock.adjust('60 seconds')
      const error = yield* Fiber.join(starting)
      assert.strictEqual(looks(), 60)
      assert.strictEqual(error.message, 'herdr detected no agent in w2:p1; the brief was not sent')
    }).pipe(Effect.provide(t.layer))
  })
})
