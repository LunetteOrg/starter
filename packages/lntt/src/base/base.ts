// The base a branch is compared with or started from, found one way by lntt worktree start, lntt
// review and lntt ci local (docs/adr/worktree-tooling.md): the open candidate when there is one,
// else the default branch, always as the remote's copy. A local branch may be behind its remote,
// so it is never the base unless --base names it. On Effect, over the Git and Gh services; the
// Promise form for the commands not yet on Effect is src/base.ts.

import * as Config from 'effect/Config'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { Gh } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import {
  type Base,
  type BaseFor,
  type CandidateRules,
  defaultOf,
  highestCandidate,
  localRefs,
  openCandidateOf,
} from './names.ts'

// A base the clone cannot give: a ref not fetched, a --base that names nothing.
export class BaseError extends Data.TaggedError('BaseError')<{ message: string }> {}

// The branch origin/HEAD points at, else `main`.
export const repositoryDefault = Effect.flatMap(Git, (git) => Effect.map(git.originHead, defaultOf))

// The branch pull requests go into: delivery.candidate.base, else origin/HEAD's, else main.
export const defaultBranch = (candidate: CandidateRules | null) =>
  candidate ? Effect.succeed(candidate.base) : repositoryDefault

// `origin/<branch>`; a missing one is an error, not a fall back on the local branch.
export const remoteRef = Effect.fnUntraced(function* (branch: string) {
  const git = yield* Git
  const ref = `origin/${branch}`
  if ((yield* git.verify(`refs/remotes/${ref}^{commit}`)) === null) {
    return yield* new BaseError({ message: `no ${ref} in this clone: run git fetch origin, or give --base` })
  }
  return ref
})

// `origin/<branch>` when it exists locally, else `<branch>`, else null: the ref of a base --base
// names, which may be a branch only this clone has.
export const localRef = Effect.fnUntraced(function* (branch: string) {
  const git = yield* Git
  for (const ref of localRefs(branch)) if ((yield* git.verify(ref)) !== null) return ref
  return null
})

// The candidate branch whose origin/ ref points at `rev` (a detached HEAD at a candidate's head),
// the highest when several do; null when none does. A git that cannot list the refs is its
// GitError, not "none".
export const candidateAt = Effect.fnUntraced(function* (prefix: string, rev = 'HEAD') {
  const git = yield* Git
  return highestCandidate(yield* git.pointingAt(rev, `refs/remotes/origin/${prefix}*`), prefix)
})

// What resolveBase needs besides git.
export interface BaseLookup<E, R> {
  // delivery.candidate, or null when the project has no candidate: then nothing is asked.
  candidate: CandidateRules | null
  // The open candidate's branch, or null when none is open; fails when it cannot know.
  openCandidate: Effect.Effect<string | null, E, R>
  for: BaseFor
}

// The first line of what a failure said.
const firstLine = (error: unknown) => String((error as { message?: unknown })?.message ?? error).split('\n')[0]

export const resolveBase = Effect.fnUntraced(function* <E, R>(lookup: BaseLookup<E, R>) {
  const git = yield* Git
  const { candidate } = lookup
  const main = yield* defaultBranch(candidate)
  const onMain = (why: string, warning: string | null = null) =>
    Effect.map(remoteRef(main), (ref): Base => ({ branch: main, ref, reason: `origin/${main}: ${why}`, warning }))
  if (!candidate) return yield* onMain('the default branch (no delivery.candidate)')
  if (lookup.for === 'hotfix') return yield* onMain(`a hotfix goes into ${main}, not into a candidate`)
  const asked = yield* Effect.result(lookup.openCandidate)
  if (asked._tag === 'Failure') {
    const why = `the open candidate is unknown (${firstLine(asked.failure)})`
    return yield* onMain(why, `${why}: the base is origin/${main}; give --base if the branch is on a candidate`)
  }
  const open = asked.success
  if (!open) return yield* onMain(`no ${candidate.prefix} branch is open`)
  const ref = yield* remoteRef(open)
  if (lookup.for === 'new') return { branch: open, ref, reason: `${ref}: the open candidate`, warning: null } as Base
  // The candidate itself: by name on a branch, by its head on a detached HEAD. A branch just
  // started on the candidate sits at its head too, and goes into the candidate.
  const current = yield* git.current
  if (current ? current === open : (yield* git.verify('HEAD')) === (yield* git.verify(ref))) {
    return yield* onMain(`HEAD is ${open}, whose pull request goes into ${main}`)
  }
  // A branch started on the candidate holds the candidate's commits, which origin/<main> does not
  // have until the candidate merges; one started on origin/<main> forks there. No fork point (no
  // history in common) is not started on the candidate.
  const fork = yield* git.mergeBase('HEAD', ref).pipe(Effect.catchTag('GitError', () => Effect.succeed(null)))
  if (fork && !(yield* git.isAncestor(fork, yield* remoteRef(main)))) {
    return {
      branch: open,
      ref: fork,
      reason: `${open} from ${fork.slice(0, 7)}: the branch descends from it`,
      warning: null,
    } as Base
  }
  return yield* onMain(`the branch does not descend from the open candidate ${open}`)
})

// The open candidate's branch, asked to GitHub: what the candidate automation itself reads
// (src/ci/candidate.ts). A merged candidate's branch stays on origin, so the refs cannot tell an
// open one. The repository is GITHUB_REPOSITORY in Actions, else the one gh works on.
export const githubCandidate = Effect.fnUntraced(function* (candidate: CandidateRules) {
  const gh = yield* Gh
  const repo = (yield* Config.String('GITHUB_REPOSITORY').pipe(Config.withDefault(''))) || (yield* gh.repository)
  const prs = yield* gh.openPullRequests({ repo, base: candidate.base, search: `head:${candidate.prefix}` })
  return openCandidateOf(prs, candidate.prefix)?.headRefName ?? null
})

// The base of the branch, from the project's delivery.candidate and GitHub.
export const projectBase = (candidate: CandidateRules | null, kind: BaseFor) =>
  resolveBase({
    candidate,
    openCandidate: candidate ? githubCandidate(candidate) : Effect.succeed(null),
    for: kind,
  })
