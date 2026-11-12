import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Git, GitLive } from './git.ts'

const encode = (text: string) => new TextEncoder().encode(text)

// git as a spawner in memory: what it was asked, and its answer by its arguments.
function git(answer: (args: string[]) => { out?: string; err?: string; code?: number } | 'missing') {
  const asked: string[][] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      asked.push([command.command, ...args])
      const said = answer(args)
      if (said === 'missing')
        return yield* PlatformError.systemError({
          _tag: 'NotFound',
          module: 'ChildProcess',
          method: 'spawn',
          pathOrDescriptor: 'git',
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
  const layer = GitLive.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn))),
  )
  return { asked, layer }
}

describe('Git on the machine', () => {
  it.effect("runs git with the operation's arguments, its output without the trailing newline", () => {
    const g = git(() => ({ out: ' M a.ts\n?? b.ts\n\n' }))
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.strictEqual(yield* repo.status, ' M a.ts\n?? b.ts')
      assert.deepStrictEqual(yield* repo.changed('c1..c2'), [' M a.ts', '?? b.ts'])
      yield* repo.written('c1..c2')
      assert.deepStrictEqual(g.asked, [
        ['git', 'status', '--porcelain'],
        ['git', 'diff', '--name-only', 'c1..c2'],
        [
          'git',
          '-c',
          'core.quotePath=false',
          'diff',
          '-U0',
          '--no-color',
          '--no-ext-diff',
          '--no-relative',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          'c1..c2',
        ],
      ])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('a git that exits non-zero is a GitError with what it said; one that cannot start too', () => {
    return Effect.gen(function* () {
      const failing = git(() => ({ err: 'fatal: not a git repository\n', code: 128 }))
      const error = yield* Effect.flip(Effect.flatMap(Git, (repo) => repo.root).pipe(Effect.provide(failing.layer)))
      assert.strictEqual(error._tag, 'GitError')
      assert.strictEqual(error.message, 'git rev-parse --show-toplevel failed: fatal: not a git repository')
      const missing = git(() => 'missing')
      const gone = yield* Effect.flip(Effect.flatMap(Git, (repo) => repo.gitDir).pipe(Effect.provide(missing.layer)))
      assert.strictEqual(gone._tag, 'GitError')
    })
  })

  it.effect("the origin's URL, '' with no origin; a git that cannot start is a GitError", () =>
    Effect.gen(function* () {
      const origin = Effect.gen(function* () {
        return yield* (yield* Git).originUrl
      })
      const remote = (out: string, code: number) =>
        Effect.provide(
          origin,
          git((args) => (args.join(' ') === 'remote get-url origin' ? { out, code } : { code: 1 })).layer,
        )
      assert.strictEqual(yield* remote('git@github.com:org/proj.git\n', 0), 'git@github.com:org/proj.git')
      assert.strictEqual(yield* remote('', 2), '')
      const missing = yield* Effect.flip(Effect.provide(origin, git(() => 'missing').layer))
      assert.strictEqual(missing._tag, 'GitError')
    }),
  )

  it.effect('an ancestor is exit 0; any other exit, a commit git no longer knows too, is not one', () => {
    const g = git((args) => ({ code: args.at(-2) === 'c1' ? 0 : args.at(-2) === 'c9' ? 1 : 128 }))
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.strictEqual(yield* repo.isAncestor('c1', 'c2'), true)
      assert.strictEqual(yield* repo.isAncestor('c9', 'c2'), false)
      assert.strictEqual(yield* repo.isAncestor('gone', 'c2'), false)
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('each operation asks git what it says it asks', () => {
    const g = git(() => ({ out: 'x' }))
    return Effect.gen(function* () {
      const repo = yield* Git
      yield* Effect.all([
        repo.branch,
        repo.short('HEAD'),
        repo.subject('HEAD'),
        repo.root,
        repo.gitDir,
        repo.commonDir,
        repo.mergeBase('HEAD', 'origin/main'),
        repo.isAncestor('c1', 'c2'),
        repo.diff('c1..c2'),
      ])
      assert.deepStrictEqual(g.asked, [
        ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
        ['git', 'rev-parse', '--short', 'HEAD'],
        ['git', 'log', '-1', '--format=%s', 'HEAD'],
        ['git', 'rev-parse', '--show-toplevel'],
        ['git', 'rev-parse', '--absolute-git-dir'],
        ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['git', 'merge-base', 'HEAD', 'origin/main'],
        ['git', 'merge-base', '--is-ancestor', 'c1', 'c2'],
        ['git', 'diff', 'c1..c2'],
      ])
    }).pipe(Effect.provide(g.layer))
  })
})
