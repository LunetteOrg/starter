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

export interface GitOperations extends FollowOperations {
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
}

export class Git extends Context.Service<Git, GitOperations>()('@lntt/lntt/git/Git') {
  // A repository in memory: each operation answers from `answers`, and one not given fails as
  // git would on a repository that lacks it.
  static memory(answers: Partial<GitOperations>) {
    const missing = (name: string) => Effect.fail(new GitError({ args: [name], output: 'not in this repository' }))
    const fn = (name: string) => () => missing(name)
    return Layer.succeed(Git)(
      Git.of({
        ...(Object.fromEntries(
          FOLLOW_OPERATIONS.map((name) => [name, name === 'isShallow' ? missing(name) : fn(name)]),
        ) as unknown as FollowOperations),
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
        ...answers,
      }),
    )
  }
}

// git on the machine, in `dir`, else in the current directory; with `env` added to its environment
// (the candidate automation's authentication in Actions); in a dry run, a push is printed through
// `dryRun` (`[dry-run] git push <args>`) instead of made.
export const gitAt = (dir?: string, options: { env?: Record<string, string>; dryRun?: (line: string) => void } = {}) =>
  Layer.effect(Git)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // Its stdout without the trailing newline, and its exit code.
      const exec = (args: string[]) =>
        captured(spawner, 'git', args, dir, undefined, options.env).pipe(
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
        ...followOperations(
          (args) => Effect.map(exec(args), ({ out, err, code }) => ({ status: code, stdout: out.trim(), stderr: err })),
          options.dryRun,
        ),
      })
    }),
  )

// git on the machine, in the current directory.
export const GitLive = gitAt()

// --- The candidate following its base (src/ci/candidate.ts) -------------------------------------
//
// What the candidate automation runs on the clone to follow the base: each git command's outcome,
// its exit code included, since the automation reads a conflict or a refused push from it. A
// GitError only when git cannot start. The project's hooks do not run on the automation's own
// rebase and push.

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

export interface FollowOperations {
  readonly isShallow: Run<GitResult>
  // Fetches `branches` from origin into their remote refs, unshallowing a shallow clone.
  readonly fetchBranches: (fetch: { branches: string[]; unshallow: boolean }) => Run<GitResult>
  // A detached worktree in `dir` at `rev`; its removal.
  readonly addWorktree: (worktree: { dir: string; rev: string }) => Run<GitResult>
  readonly removeWorktree: (dir: string) => Run<GitResult>
  // In the worktree `dir`: a rebase onto `onto` that keeps empty commits, its abort, HEAD, and the
  // files in conflict.
  readonly rebaseIn: (rebase: { dir: string; onto: string }) => Run<GitResult>
  readonly abortRebaseIn: (dir: string) => Run<GitResult>
  readonly headIn: (dir: string) => Run<GitResult>
  readonly conflictsIn: (dir: string) => Run<GitResult>
  // The tree of a merge of `theirs` into `ours`, with the names of the files in conflict.
  readonly mergeTree: (merge: { ours: string; theirs: string }) => Run<GitResult>
  readonly commitTree: (commit: { tree: string; parents: string[]; messages: string[] }) => Run<GitResult>
  // Pushes `sha` to origin's `branch`, with a lease on `expected` when given.
  readonly pushBranch: (push: { sha: string; branch: string; expected?: string }) => Run<GitResult>
}

export const FOLLOW_OPERATIONS = [
  'isShallow',
  'fetchBranches',
  'addWorktree',
  'removeWorktree',
  'rebaseIn',
  'abortRebaseIn',
  'headIn',
  'conflictsIn',
  'mergeTree',
  'commitTree',
  'pushBranch',
] as const satisfies ReadonlyArray<keyof FollowOperations>

// The arguments of a push, as git is run with them and a dry run prints them.
export const pushArgs = ({ sha, branch, expected }: { sha: string; branch: string; expected?: string }) => [
  ...(expected === undefined ? [] : [`--force-with-lease=refs/heads/${branch}:${expected}`]),
  'origin',
  `${sha}:refs/heads/${branch}`,
]

export function followOperations(
  run: (args: string[]) => Run<GitResult>,
  dryRun?: (line: string) => void,
): FollowOperations {
  return {
    isShallow: run(['rev-parse', '--is-shallow-repository']),
    fetchBranches: ({ branches, unshallow }) =>
      run([
        'fetch',
        '--no-tags',
        ...(unshallow ? ['--unshallow'] : []),
        'origin',
        ...branches.map((branch) => `+refs/heads/${branch}:refs/remotes/origin/${branch}`),
      ]),
    addWorktree: ({ dir, rev }) => run([...NO_HOOKS, 'worktree', 'add', '--detach', dir, rev]),
    removeWorktree: (dir) => run(['worktree', 'remove', '--force', dir]),
    rebaseIn: ({ dir, onto }) => run(['-C', dir, ...NO_HOOKS, 'rebase', '--keep-empty', onto]),
    abortRebaseIn: (dir) => run(['-C', dir, ...NO_HOOKS, 'rebase', '--abort']),
    headIn: (dir) => run(['-C', dir, 'rev-parse', 'HEAD']),
    conflictsIn: (dir) => run(['-C', dir, 'diff', '--name-only', '--diff-filter=U']),
    mergeTree: ({ ours, theirs }) => run(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]),
    commitTree: ({ tree, parents, messages }) =>
      run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), ...messages.flatMap((m) => ['-m', m])]),
    pushBranch: (push) => {
      const args = pushArgs(push)
      if (dryRun) {
        const print = dryRun
        return Effect.sync(() => {
          print(`[dry-run] git push ${args.join(' ')}`)
          return { status: 0, stdout: '', stderr: '' }
        })
      }
      return run([...NO_HOOKS, 'push', ...args])
    },
  }
}
