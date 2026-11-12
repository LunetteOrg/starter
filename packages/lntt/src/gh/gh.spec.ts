import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Gh, ghAt } from './gh.ts'

const encode = (text: string) => new TextEncoder().encode(text)

// gh as a spawner in memory: what it was asked and where, and its answer by its arguments.
function gh(answer: (args: string[]) => { out?: string; err?: string; code?: number } | 'missing', dir?: string) {
  const asked: string[][] = []
  const cwds: (string | undefined)[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      asked.push([command.command, ...args])
      cwds.push(command.options.cwd)
      const said = answer(args)
      if (said === 'missing')
        return yield* PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
          pathOrDescriptor: 'gh',
        })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(said.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(said.out ?? '')),
        stderr: Stream.make(encode(said.err ?? '')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = ghAt(dir).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn))),
  )
  return { asked, cwds, layer }
}

describe('Gh on the machine', () => {
  it.effect('each operation asks gh what it says it asks, in the directory given, and reads its JSON', () => {
    const g = gh(
      (args) =>
        args[0] === 'repo'
          ? { out: 'org/repo\n' }
          : args[0] === 'pr'
            ? { out: '[{"number":3,"headRefName":"candidate/13"}]' }
            : { out: '{"title":"T","labels":[],"type":null}' },
      '/repo',
    )
    return Effect.gen(function* () {
      const github = yield* Gh
      assert.strictEqual(yield* github.repository, 'org/repo')
      assert.deepStrictEqual(
        yield* github.openPullRequests({ repo: 'org/repo', base: 'main', search: 'head:candidate/' }),
        [{ number: 3, headRefName: 'candidate/13' }],
      )
      assert.deepStrictEqual(yield* github.issue(7), { title: 'T', labels: [], type: null })
      assert.deepStrictEqual(g.asked, [
        ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        [
          'gh',
          'pr',
          'list',
          '--repo',
          'org/repo',
          '--state',
          'open',
          '--base',
          'main',
          '--search',
          'head:candidate/',
          '--json',
          'number,headRefName',
        ],
        ['gh', 'api', 'repos/{owner}/{repo}/issues/7'],
      ])
      assert.deepStrictEqual(g.cwds, ['/repo', '/repo', '/repo'])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('a gh that exits non-zero, cannot start, or answers no JSON is a GhError that says so', () =>
    Effect.gen(function* () {
      const refused = gh(() => ({ err: 'HTTP 403: Resource not accessible by integration\n', code: 1 }))
      const error = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.issue(7)).pipe(Effect.provide(refused.layer)))
      assert.strictEqual(error._tag, 'GhError')
      assert.strictEqual(
        error.message,
        'gh api repos/{owner}/{repo}/issues/7 failed: HTTP 403: Resource not accessible by integration',
      )
      const missing = gh(() => 'missing')
      const gone = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.repository).pipe(Effect.provide(missing.layer)))
      assert.strictEqual(gone._tag, 'GhError')
      const garbled = gh(() => ({ out: '<html>' }))
      const notJson = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.issue(7)).pipe(Effect.provide(garbled.layer)))
      assert.match(notJson.message, /not JSON: <html>/)
    }),
  )

  it.effect('in memory, an operation not given fails as gh would without a connection', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.repository).pipe(Effect.provide(Gh.memory({}))))
      assert.strictEqual(error._tag, 'GhError')
    }),
  )
})
