// The event a local run stands in for, read from the local git state. ci:local never
// fetches: the base is a ref of this clone (src/base/base.ts finds it), and the report names it.
//
// - `pull_request` (the default): the pull request of the current branch into `base`,
//   ready for review, which is what the cloud runs once a draft leaves draft.
// - `push`: a push of the current commit to `base` (the main branch: what gates a
//   release).
//
// Sync until lntt ci moves to Effect (#340): it calls git itself, and reads the names git gives
// with the same functions as the base on Effect (src/base/names.ts).

import { execFileSync } from 'node:child_process'
import { defaultOf, highestCandidate, localRefs } from '../base/names.ts'

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

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The branch origin/HEAD points at, else `main`.
export function defaultBranch(cwd: string): string {
  return defaultOf(git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'))
}

export function repositoryOf(url: string | null): string | null {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url ?? '')
  return match ? match[1] : null
}

// Changed files from the merge base with `ref` to HEAD.
function changedSince(cwd: string, ref: string): string[] | null {
  const out = git(cwd, 'diff', '--name-only', `${ref}...HEAD`)
  return out === null ? null : out.split('\n').filter((line) => line !== '')
}

// `origin/<branch>` when it exists locally, else `<branch>`, else null: the ref of a base
// --base names, which may be a branch only this clone has (localRef in src/base/base.ts).
function localRef(cwd: string, branch: string): string | null {
  return localRefs(branch).find((ref) => git(cwd, 'rev-parse', '--verify', '-q', ref) !== null) ?? null
}

// The candidate whose origin/ ref points at HEAD, the highest when several do (candidateAt in
// src/base/base.ts).
function candidateAt(cwd: string, prefix: string): string | null {
  const out = git(cwd, 'for-each-ref', '--points-at=HEAD', '--format=%(refname)', `refs/remotes/origin/${prefix}*`)
  return highestCandidate((out ?? '').split('\n').filter(Boolean), prefix)
}

// Files changed from the merge base with `branch` to HEAD; null without a local ref.
export function changedAgainst(cwd: string, branch: string): string[] | null {
  const ref = localRef(cwd, branch)
  return ref ? changedSince(cwd, ref) : null
}

export interface EventOptions {
  // The ref to diff against, when the base was resolved (src/base/base.ts); else localRef's.
  baseRef?: string
  // delivery.candidate.prefix: a detached HEAD at a candidate's head is that candidate.
  candidatePrefix?: string
}

export function localEvent(cwd: string, name: EventName, base: string, options: EventOptions = {}): Event {
  let head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD'
  // The workflows read the branch's name (the branch check): a candidate checked out
  // detached from origin needs no local branch named after it.
  if (head === 'HEAD' && options.candidatePrefix) head = candidateAt(cwd, options.candidatePrefix) ?? head
  const sha = git(cwd, 'rev-parse', 'HEAD') ?? ''
  const baseRef = options.baseRef ?? localRef(cwd, base)
  let changed = baseRef ? changedSince(cwd, baseRef) : null
  // A push of a commit already on the base: the last commit is what it brings.
  if (name === 'push' && changed?.length === 0) changed = changedSince(cwd, 'HEAD^')
  return {
    name,
    base,
    head,
    sha,
    baseRef,
    changed,
    repository: repositoryOf(git(cwd, 'remote', 'get-url', 'origin')),
    defaultBranch: defaultBranch(cwd),
  }
}
