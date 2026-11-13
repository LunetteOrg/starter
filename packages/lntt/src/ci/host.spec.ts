import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { awaited, changed, list, onPath, processed, read } from './asks.ts'
import { CiFailed, runAsks } from './host.ts'

// A spawner where `circleci` answers with `out` on stdout, `err` on stderr and `code`, `sh` finds
// `found` on the PATH, and any other command is not installed. The argv it was asked is kept.
function spawner(circleci: { out?: string; err?: string; code?: number; missing?: boolean }, found: string[] = []) {
  const asked: string[][] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const argv = [command.command, ...command.args.map(String)]
      asked.push(argv)
      const missing = command.command === 'circleci' ? circleci.missing : command.command !== 'sh'
      if (missing) {
        return yield* Effect.fail(
          PlatformError.systemError({ _tag: 'NotFound', module: 'ChildProcess', method: 'spawn' }),
        )
      }
      const code = command.command === 'sh' ? (found.includes(argv[3] ?? '') ? 0 : 1) : (circleci.code ?? 0)
      const encode = (text: string) => Stream.make(new TextEncoder().encode(text))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: encode(command.command === 'circleci' ? (circleci.out ?? '') : ''),
        stderr: encode(command.command === 'circleci' ? (circleci.err ?? '') : ''),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  return { asked, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)) }
}

const input = { node: 'v24.1.0', dir: '/tmp/ci' }

describe('runAsks', () => {
  it.effect('answers files, directories, the PATH, the Node version and the changed files', () => {
    const fs = memoryFileSystem({ dirs: ['/tmp/ci'] })
    const git = Git.memory({
      verify: (rev) => Effect.succeed(rev === 'origin/main' ? 'abc' : null),
      changed: () => Effect.succeed(['src/a.ts']),
    })
    return Effect.gen(function* () {
      yield* fs.put('/repo/.github/workflows/ci.yml', 'on: push')
      const answers = yield* runAsks(
        (function* () {
          return [
            yield* read('/repo/.github/workflows/ci.yml'),
            yield* read('/repo/missing'),
            yield* list('/repo/.github/workflows'),
            yield* list('/repo/nowhere'),
            yield* onPath('pnpm'),
            yield* onPath('act'),
            yield* changed('main'),
            yield* awaited(() => Promise.resolve(7)),
          ]
        })(),
        input,
      )
      assert.deepStrictEqual(answers, ['on: push', null, ['ci.yml'], null, true, false, ['src/a.ts'], 7])
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, spawner({}, ['pnpm']).layer, git)))
  })

  it.effect('processes a CircleCI configuration in its folder, and keeps the result there for local execute', () => {
    const fs = memoryFileSystem({ dirs: ['/tmp/ci'] })
    const cli = spawner({ out: 'version: 2.1\njobs: {}\n' })
    return Effect.gen(function* () {
      const result = yield* runAsks(processed('.circleci/config.yml', 'version: 2.1', { 'run-ci': true }), input)
      assert.deepStrictEqual(result, { config: { version: 2.1, jobs: {} }, file: '/tmp/ci/processed-1.yml' })
      assert.strictEqual(fs.text('/tmp/ci/source-1.yml'), 'version: 2.1')
      assert.deepStrictEqual(cli.asked[0], [
        'circleci',
        '--skip-update-check',
        'config',
        'process',
        '--pipeline-parameters',
        '{"run-ci":true}',
        '/tmp/ci/source-1.yml',
      ])
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, cli.layer, Git.memory({}))))
  })

  for (const [what, cli, message] of [
    [
      'a rejected token is named, not reported as a generic failure',
      { err: 'Error: The API token was rejected by CircleCI', code: 255 },
      /^the stored CircleCI login is not valid/,
    ],
    [
      'any other failure stays a generic one, with the CLI output',
      { err: 'Error: unknown orb', code: 1 },
      /^circleci config process \.circleci\/config\.yml: Error: unknown orb$/,
    ],
    ['a missing CLI is reported as not installed', { missing: true }, /not installed \(brew install circleci\)/],
  ] as const) {
    it.effect(`a CircleCI configuration the CLI refuses fails the loader: ${what}`, () => {
      const fs = memoryFileSystem({ dirs: ['/tmp/ci'] })
      return Effect.gen(function* () {
        const error = yield* Effect.flip(runAsks(processed('.circleci/config.yml', 'x', {}), input))
        assert.instanceOf(error, CiFailed)
        assert.match(error.message, message)
      }).pipe(Effect.provide(Layer.mergeAll(fs.layer, spawner(cli).layer, Git.memory({}))))
    })
  }

  it.effect('an ask that fails is thrown into the loader, which may catch it; what it throws is a CiFailed', () => {
    const fs = memoryFileSystem({ dirs: ['/tmp/ci'] })
    return Effect.gen(function* () {
      const caught = yield* runAsks(
        (function* () {
          try {
            yield* processed('a.yml', 'x', {})
            return 'processed'
          } catch (error) {
            return `caught: ${(error as Error).message}`
          }
        })(),
        input,
      )
      assert.match(caught, /^caught: the circleci CLI is not installed/)
      const thrown = yield* Effect.flip(
        runAsks(
          (function* () {
            yield* read('/x')
            throw new Error('.github/workflows/a.yml: not a workflow')
          })(),
          input,
        ),
      )
      assert.deepStrictEqual([thrown._tag, thrown.message], ['CiFailed', '.github/workflows/a.yml: not a workflow'])
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, spawner({ missing: true }).layer, Git.memory({}))))
  })
})
