// Git as a service of lntt's own (docs/adr/effect-in-lntt.md#services): the operations lntt's
// modules on Effect ask of the repository of the current directory, each a typed Effect. The live
// layer runs git through Effect's ChildProcessSpawner; Git.memory answers from a record, for a spec.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'

// git exited non-zero, or could not start: the command and what it said.
export class GitError extends Data.TaggedError('GitError')<{ args: readonly string[]; output: string }> {
  get message() {
    return `git ${this.args.join(' ')} failed${this.output ? `: ${this.output}` : ''}`
  }
}

type Run<A> = Effect.Effect<A, GitError>

export interface GitOperations {
  // `git status --porcelain`: '' for a clean tree.
  readonly status: Run<string>
  // The branch HEAD names, 'HEAD' when it is detached.
  readonly branch: Run<string>
  // The short hash of a revision.
  readonly short: (rev: string) => Run<string>
  // The subject of a revision's commit.
  readonly subject: (rev: string) => Run<string>
  // The top of the working tree, the worktree's git directory, the clone's common one.
  readonly root: Run<string>
  readonly gitDir: Run<string>
  readonly commonDir: Run<string>
  readonly mergeBase: (a: string, b: string) => Run<string>
  // Whether `a` is an ancestor of `b`: false, not a failure, when it is not or git cannot tell.
  readonly isAncestor: (a: string, b: string) => Run<boolean>
  // The files a range changes, and its diff.
  readonly changed: (range: string) => Run<string[]>
  readonly diff: (range: string) => Run<string>
  // The lines a range writes, with no context, prefixes a/ and b/ and the paths from the root
  // whatever diff.noprefix, diff.relative or core.quotePath the user set.
  readonly written: (range: string) => Run<string>
}

export class Git extends Context.Service<Git, GitOperations>()('@lntt/lntt/git/Git') {
  // A repository in memory: each operation answers from `answers`, and one not given fails as
  // git would on a repository that lacks it.
  static memory(answers: Partial<GitOperations>) {
    const missing = (name: string) => Effect.fail(new GitError({ args: [name], output: 'not in this repository' }))
    const fn = (name: string) => () => missing(name)
    return Layer.succeed(Git)(
      Git.of({
        status: missing('status'),
        branch: missing('branch'),
        short: fn('short'),
        subject: fn('subject'),
        root: missing('root'),
        gitDir: missing('gitDir'),
        commonDir: missing('commonDir'),
        mergeBase: fn('merge-base'),
        isAncestor: fn('is-ancestor'),
        changed: fn('changed'),
        diff: fn('diff'),
        written: fn('written'),
        ...answers,
      }),
    )
  }
}

const text = <E>(stream: Stream.Stream<Uint8Array, E>) => Stream.mkString(Stream.decodeText(stream))

// git on the machine, in the current directory.
export const GitLive = Layer.effect(Git)(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Its stdout without the trailing newline, and its exit code.
    const exec = (args: string[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const git = yield* spawner.spawn(ChildProcess.make('git', args, { stdin: 'ignore' }))
          const [out, err, code] = yield* Effect.all([text(git.stdout), text(git.stderr), git.exitCode], {
            concurrency: 'unbounded',
          })
          return { out: out.trimEnd(), err: err.trim(), code }
        }),
      ).pipe(Effect.mapError((error) => new GitError({ args, output: error.message })))
    const run = (...args: string[]) =>
      Effect.flatMap(exec(args), ({ out, err, code }) =>
        code === 0 ? Effect.succeed(out) : Effect.fail(new GitError({ args, output: err })),
      )
    return Git.of({
      status: run('status', '--porcelain'),
      branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
      short: (rev) => run('rev-parse', '--short', rev),
      subject: (rev) => run('log', '-1', '--format=%s', rev),
      root: run('rev-parse', '--show-toplevel'),
      gitDir: run('rev-parse', '--absolute-git-dir'),
      commonDir: run('rev-parse', '--path-format=absolute', '--git-common-dir'),
      mergeBase: (a, b) => run('merge-base', a, b),
      // A commit git no longer knows (a rebase dropped it) is no ancestor either.
      isAncestor: (a, b) => Effect.map(exec(['merge-base', '--is-ancestor', a, b]), ({ code }) => code === 0),
      changed: (range) => Effect.map(run('diff', '--name-only', range), (out) => out.split('\n').filter(Boolean)),
      diff: (range) => run('diff', range),
      written: (range) =>
        run(
          '-c',
          'core.quotePath=false',
          'diff',
          '-U0',
          '--no-color',
          '--no-ext-diff',
          '--no-relative',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          range,
        ),
    })
  }),
)
