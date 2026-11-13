// The event a local run stands in for, read from the local git state. ci:local never
// fetches: the base is a ref of this clone (src/base/base.ts finds it), and the report names it.
//
// - `pull_request` (the default): the pull request of the current branch into `base`,
//   ready for review, which is what the cloud runs once a draft leaves draft.
// - `push`: a push of the current commit to `base` (the main branch: what gates a
//   release).
//
// On Effect, over Git and the base's own lookups. The library's synchronous `localEvent`,
// `changedAgainst` and `defaultBranch` are in src/ci/sync.ts, with their own git calls over the
// same names (src/base/names.ts).

import * as Effect from 'effect/Effect'
import { candidateAt, localRef, repositoryDefault } from '../base/base.ts'
import { repositoryOf } from '../base/names.ts'
import { Git } from '../git/git.ts'

export type EventName = 'pull_request' | 'push'

export interface Event {
  name: EventName
  // pull_request: the base branch; push: the branch pushed to.
  base: string
  // The branch being checked.
  head: string
  sha: string
  // The ref the diff was taken against, or null when none exists locally.
  baseRef: string | null
  // Files changed against the base, for path filters; null when unknown.
  changed: string[] | null
  // owner/repo from the origin remote, when it is on GitHub.
  repository: string | null
  // The repository's default branch: origin/HEAD's, else main.
  defaultBranch: string
}

export interface EventOptions {
  // The ref to diff against, when the base was resolved (src/base/base.ts); else localRef's.
  baseRef?: string
  // delivery.candidate.prefix: a detached HEAD at a candidate's head is that candidate.
  candidatePrefix?: string
}

// What git cannot answer is not known: the event reads null, as with no ref.
const unknown = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(Effect.catch(() => Effect.succeed(null as A | null)))

// Changed files from the merge base with `ref` to HEAD.
const changedSince = (ref: string) => unknown(Effect.flatMap(Git, (git) => git.changed(`${ref}...HEAD`)))

// Files changed from the merge base with `branch` to HEAD; null without a local ref.
export const changedAgainst = Effect.fnUntraced(function* (branch: string) {
  const ref = yield* unknown(localRef(branch))
  return ref ? yield* changedSince(ref) : null
})

export const localEvent = Effect.fnUntraced(function* (name: EventName, base: string, options: EventOptions = {}) {
  const git = yield* Git
  let head = (yield* unknown(git.branch)) ?? 'HEAD'
  // The workflows read the branch's name (the branch check): a candidate checked out
  // detached from origin needs no local branch named after it.
  if (head === 'HEAD' && options.candidatePrefix) head = (yield* unknown(candidateAt(options.candidatePrefix))) ?? head
  const sha = (yield* unknown(git.verify('HEAD'))) ?? ''
  const baseRef = options.baseRef ?? (yield* unknown(localRef(base)))
  let changed = baseRef ? yield* changedSince(baseRef) : null
  // A push of a commit already on the base: the last commit is what it brings.
  if (name === 'push' && changed?.length === 0) changed = yield* changedSince('HEAD^')
  return {
    name,
    base,
    head,
    sha,
    baseRef,
    changed,
    repository: repositoryOf(yield* unknown(git.originUrl)),
    defaultBranch: (yield* unknown(repositoryDefault)) ?? 'main',
  } satisfies Event
})
