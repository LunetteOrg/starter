// Git as a service of lntt's own (docs/adr/effect-in-lntt.md#services): the operations lntt's
// modules on Effect ask of the repository of the current directory, each a typed Effect. The live
// layer runs git through Effect's ChildProcessSpawner, in the current directory or the one gitAt
// names; Git.memory answers from a record, for a spec.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcessSpawner } from 'effect/process'
import { captured } from '../captured.ts'

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
  // `git branch --show-current`: '' when HEAD is detached.
  readonly current: Run<string>
  // The object a revision names (`git rev-parse --verify --quiet`), null when it names none.
  readonly verify: (rev: string) => Run<string | null>
  // The branch origin/HEAD points at, as `origin/<branch>`; null when origin has no HEAD.
  readonly originHead: Run<string | null>
  // The refs under `pattern` that point at `rev`, full names (`refs/remotes/origin/candidate/13`).
  readonly pointingAt: (rev: string, pattern: string) => Run<string[]>
  // The URL of the origin remote, '' when there is none.
  readonly originUrl: Run<string>
  // The remotes gh resolves the repository from: the url and gh-resolved lines of the git config,
  // '' when there is none, null when git answers anything else (outside a repository).
  readonly remotes: Run<string | null>
  // Renames the branch HEAD is on.
  readonly renameBranch: (name: string) => Run<void>
  // The short hash of a revision.
  readonly short: (rev: string) => Run<string>
  // The subject of a revision's commit.
  readonly subject: (rev: string) => Run<string>
  // The top of the working tree, the worktree's git directory, the clone's common one.
  readonly root: Run<string>
  readonly gitDir: Run<string>
  readonly commonDir: Run<string>
  readonly mergeBase: (a: string, b: string) => Run<string>
  // Whether `a` is an ancestor of `b`: false for any exit of git but 0 (a commit git no longer
  // knows too); a GitError only when git does not start.
  readonly isAncestor: (a: string, b: string) => Run<boolean>
  // The files a range changes, and its diff.
  readonly changed: (range: string) => Run<string[]>
  readonly diff: (range: string) => Run<string>
  // The lines a range writes, with no context, prefixes a/ and b/ and the paths from the root
  // whatever diff.noprefix, diff.relative or core.quotePath the user set.
  readonly written: (range: string) => Run<string>
  // `git worktree list --porcelain` of the repository whose git directory is `gitDir`.
  readonly worktrees: (gitDir: string) => Run<string>

  // What lntt check reads, in `dir` (`git -C <dir>`): the project's root, below the top of the
  // working tree when the project is nested.
  // The files tracked or new and not ignored, relative to `dir`; with `others`, only the new ones.
  readonly listFiles: (dir: string, options?: { others?: boolean }) => Run<string[]>
  // The directories git ignores that are left whole, each ending in `/`.
  readonly ignoredDirectories: (dir: string) => Run<string[]>
  // The lines the working tree adds from `base`, with no context, the paths relative to `dir`.
  readonly addedFrom: (dir: string, base: string) => Run<string>
  // `git diff --name-status -M <range>`, the paths unquoted; null when the range does not resolve.
  readonly nameStatus: (dir: string, range: string) => Run<string | null>
  // The tracked files the working tree changes from HEAD, staged or not, deletions included.
  readonly changedFromHead: (dir: string) => Run<string[]>
  // The top of the working tree `dir` is in.
  readonly topOf: (dir: string) => Run<string>
  // `git rev-parse --absolute-git-dir` in `dir`.
  readonly gitDirOf: (dir: string) => Run<string>
  // A detached worktree of HEAD at `path`, its removal, and the prune of those whose folder is gone.
  readonly addWorktree: (dir: string, path: string) => Run<void>
  readonly removeWorktree: (dir: string, path: string) => Run<void>
  readonly pruneWorktrees: (dir: string) => Run<void>
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
        current: missing('current'),
        verify: fn('verify'),
        originHead: missing('originHead'),
        pointingAt: fn('pointingAt'),
        originUrl: missing('originUrl'),
        remotes: missing('remotes'),
        renameBranch: fn('renameBranch'),
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
        worktrees: fn('worktrees'),
        listFiles: fn('listFiles'),
        ignoredDirectories: fn('ignoredDirectories'),
        addedFrom: fn('addedFrom'),
        nameStatus: fn('nameStatus'),
        changedFromHead: fn('changedFromHead'),
        topOf: fn('topOf'),
        gitDirOf: fn('gitDirOf'),
        addWorktree: fn('addWorktree'),
        removeWorktree: fn('removeWorktree'),
        pruneWorktrees: fn('pruneWorktrees'),
        ...answers,
      }),
    )
  }
}

// The paths of a -z listing.
const split = (out: string) => out.split('\0').filter(Boolean)

// git on the machine, in `dir`, else in the current directory.
export const gitAt = (dir?: string) =>
  Layer.effect(Git)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // Its stdout without the trailing newline, and its exit code.
      const exec = (args: string[]) =>
        captured(spawner, 'git', args, dir).pipe(
          Effect.mapError((error) => new GitError({ args, output: error.message })),
        )
      const run = (...args: string[]) =>
        Effect.flatMap(exec(args), ({ out, err, code }) =>
          code === 0 ? Effect.succeed(out) : Effect.fail(new GitError({ args, output: err })),
        )
      // Its output, or null for any exit but 0: an answer of "none", not a failure.
      const ask = (...args: string[]) => Effect.map(exec(args), ({ out, code }) => (code === 0 ? out : null))
      return Git.of({
        status: run('status', '--porcelain'),
        branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
        current: run('branch', '--show-current'),
        verify: (rev) => ask('rev-parse', '--verify', '--quiet', rev),
        originHead: ask('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
        pointingAt: (rev, pattern) =>
          Effect.map(run('for-each-ref', `--points-at=${rev}`, '--format=%(refname)', pattern), (out) =>
            out.split('\n').filter(Boolean),
          ),
        originUrl: Effect.map(ask('remote', 'get-url', 'origin'), (url) => url ?? ''),
        remotes: Effect.map(exec(['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']), ({ out, code }) =>
          code === 0 ? out : code === 1 ? '' : null,
        ),
        renameBranch: (name) => Effect.asVoid(run('branch', '-m', name)),
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
        worktrees: (gitDir) => run('--git-dir', gitDir, 'worktree', 'list', '--porcelain'),
        listFiles: (dir, options = {}) =>
          Effect.map(
            run('-C', dir, 'ls-files', '-z', ...(options.others ? [] : ['--cached']), '--others', '--exclude-standard'),
            split,
          ),
        ignoredDirectories: (dir) =>
          Effect.map(
            run('-C', dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'),
            split,
          ),
        addedFrom: (dir, base) =>
          run(
            '-C',
            dir,
            '-c',
            'core.quotePath=false',
            'diff',
            '-U0',
            '--no-renames',
            '--no-color',
            '--no-ext-diff',
            '--relative',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            base,
          ),
        nameStatus: (dir, range) =>
          ask('-C', dir, '-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '--no-color', range),
        changedFromHead: (dir) =>
          Effect.map(run('-C', dir, 'diff', '-z', '--name-only', '--no-renames', 'HEAD'), split),
        topOf: (dir) => run('-C', dir, 'rev-parse', '--show-toplevel'),
        gitDirOf: (dir) => run('-C', dir, 'rev-parse', '--absolute-git-dir'),
        addWorktree: (dir, path) =>
          Effect.asVoid(run('-C', dir, 'worktree', 'add', '--detach', '--quiet', path, 'HEAD')),
        removeWorktree: (dir, path) => Effect.asVoid(run('-C', dir, 'worktree', 'remove', '--force', path)),
        pruneWorktrees: (dir) => Effect.asVoid(run('-C', dir, 'worktree', 'prune')),
      })
    }),
  )

// git on the machine, in the current directory.
export const GitLive = gitAt()
