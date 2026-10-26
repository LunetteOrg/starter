// The event a local run stands in for, read from the local git state. ci:local never
// fetches and never asks GitHub: the base is the local ref, and the report names it.
//
// - `pull_request` (the default): the pull request of the current branch into `base`,
//   ready for review, which is what the cloud runs once a draft leaves draft.
// - `push`: a push of the current commit to `base` (the main branch: what gates a
//   release).

import { execFileSync } from 'node:child_process'

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
  const head = git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return head?.replace(/^origin\//, '') || 'main'
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

// `origin/<branch>` when it exists locally, else `<branch>`, else null.
export function localRef(cwd: string, branch: string): string | null {
  return [`origin/${branch}`, branch].find((ref) => git(cwd, 'rev-parse', '--verify', '-q', ref) !== null) ?? null
}

// Files changed from the merge base with `branch` to HEAD; null without a local ref.
export function changedAgainst(cwd: string, branch: string): string[] | null {
  const ref = localRef(cwd, branch)
  return ref ? changedSince(cwd, ref) : null
}

export function localEvent(cwd: string, name: EventName, base: string): Event {
  const head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD'
  const sha = git(cwd, 'rev-parse', 'HEAD') ?? ''
  const baseRef = localRef(cwd, base)
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
