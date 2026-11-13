import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Git, GitError, GitLive, gitAt } from './git.ts'

const encode = (text: string) => new TextEncoder().encode(text)

// git as a spawner in memory: what it was asked and where, and its answer by its arguments.
function git(
  answer: (args: string[]) => { out?: string; err?: string; code?: number } | 'missing',
  dir?: string,
  options?: Parameters<typeof gitAt>[1],
) {
  const asked: string[][] = []
  const cwds: (string | undefined)[] = []
  const envs: (Record<string, unknown> | undefined)[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      asked.push([command.command, ...args])
      cwds.push(command.options.cwd)
      envs.push(command.options.env)
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
  const layer = (dir === undefined && options === undefined ? GitLive : gitAt(dir, options)).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn))),
  )
  return { asked, cwds, envs, layer }
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

  it.effect('the refs: a revision that names nothing, no origin/HEAD and no origin are answers, not failures', () => {
    const g = git(
      (args) => ({ code: args.includes('missing') || args[0] !== 'rev-parse' ? 1 : 0, out: 'abc' }),
      '/repo',
    )
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.strictEqual(yield* repo.verify('HEAD'), 'abc')
      assert.strictEqual(yield* repo.verify('missing'), null)
      assert.strictEqual(yield* repo.originHead, null)
      assert.strictEqual(yield* repo.originUrl, '')
      assert.deepStrictEqual(g.asked, [
        ['git', 'rev-parse', '--verify', '--quiet', 'HEAD'],
        ['git', 'rev-parse', '--verify', '--quiet', 'missing'],
        ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        ['git', 'remote', 'get-url', 'origin'],
      ])
      assert.deepStrictEqual(g.cwds, ['/repo', '/repo', '/repo', '/repo'], 'git runs in the directory gitAt names')
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('the current branch, the refs at a commit, a rename: what each asks and reads', () => {
    const g = git((args) => ({
      out:
        args[0] === 'for-each-ref'
          ? 'refs/remotes/origin/candidate/13\nrefs/remotes/origin/candidate/9\n'
          : args[0] === 'branch' && args[1] === '--show-current'
            ? ''
            : 'git@github.com:o/r.git',
    }))
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.strictEqual(yield* repo.current, '', 'a detached HEAD')
      assert.deepStrictEqual(yield* repo.pointingAt('HEAD', 'refs/remotes/origin/candidate/*'), [
        'refs/remotes/origin/candidate/13',
        'refs/remotes/origin/candidate/9',
      ])
      assert.strictEqual(yield* repo.originUrl, 'git@github.com:o/r.git')
      yield* repo.renameBranch('feat/1/x')
      assert.deepStrictEqual(g.asked, [
        ['git', 'branch', '--show-current'],
        ['git', 'for-each-ref', '--points-at=HEAD', '--format=%(refname)', 'refs/remotes/origin/candidate/*'],
        ['git', 'remote', 'get-url', 'origin'],
        ['git', 'branch', '-m', 'feat/1/x'],
      ])
      assert.deepStrictEqual(
        g.cwds,
        [undefined, undefined, undefined, undefined],
        'GitLive runs in the current directory',
      )
    }).pipe(Effect.provide(g.layer))
  })
})

describe('the follow of the candidate', () => {
  it.effect('in memory, an operation not answered fails as git would, the ones that are not functions too', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Git).isShallow)
      assert.instanceOf(error, GitError)
      assert.strictEqual(error.message, 'git isShallow failed: not in this repository')
    }).pipe(Effect.provide(Git.memory({}))),
  )

  it.effect('reads each outcome, a failure included, without failing; the hooks never run on its rebase', () => {
    const g = git((args) => (args.includes('rebase') ? { err: 'CONFLICT (content)\n', code: 1 } : { out: 'true\n' }))
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.deepStrictEqual(yield* repo.isShallow, { status: 0, stdout: 'true', stderr: '' })
      assert.deepStrictEqual(yield* repo.rebaseIn({ dir: '/w', onto: 'abc' }), {
        status: 1,
        stdout: '',
        stderr: 'CONFLICT (content)',
      })
      assert.deepStrictEqual(g.asked[1], [
        'git',
        '-C',
        '/w',
        '-c',
        'core.hooksPath=/dev/null',
        'rebase',
        '--keep-empty',
        'abc',
      ])
      yield* repo.fetchBranches({ branches: ['main', 'candidate/4'], unshallow: true })
      assert.deepStrictEqual(g.asked[2], [
        'git',
        'fetch',
        '--no-tags',
        '--unshallow',
        'origin',
        '+refs/heads/main:refs/remotes/origin/main',
        '+refs/heads/candidate/4:refs/remotes/origin/candidate/4',
      ])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('pushes with a lease on the head as read, without the hooks, and with the environment given', () => {
    const g = git(() => ({}), '/clone', { env: { GIT_CONFIG_COUNT: '1' } })
    return Effect.gen(function* () {
      yield* (yield* Git).pushBranch({ sha: 'new', branch: 'candidate/4', expected: 'old' })
      assert.deepStrictEqual(g.asked[0], [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        'push',
        '--force-with-lease=refs/heads/candidate/4:old',
        'origin',
        'new:refs/heads/candidate/4',
      ])
      assert.deepStrictEqual(g.envs[0], { GIT_CONFIG_COUNT: '1' })
      assert.strictEqual(g.cwds[0], '/clone')
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('a dry run prints the push and makes none; the rest still runs', () => {
    const lines: string[] = []
    const g = git(() => ({ out: 'sha' }), '/clone', { dryRun: (line) => lines.push(line) })
    return Effect.gen(function* () {
      const repo = yield* Git
      assert.strictEqual((yield* repo.pushBranch({ sha: 'new', branch: 'candidate/4' })).status, 0)
      yield* repo.headIn('/w')
      assert.deepStrictEqual(lines, ['[dry-run] git push origin new:refs/heads/candidate/4'])
      assert.deepStrictEqual(g.asked, [['git', '-C', '/w', 'rev-parse', 'HEAD']])
    }).pipe(Effect.provide(g.layer))
  })
})
