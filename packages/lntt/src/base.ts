// The base a branch is compared with or started from, found one way by lntt worktree
// start, lntt review and lntt ci local (docs/adr/worktree-tooling.md): the open
// candidate when there is one, else the default branch, always as the remote's copy.
// A local branch may be behind its remote, so it is never the base unless --base names it.

import { execFileSync } from 'node:child_process'
import { env } from 'node:process'
import { makeGh, openCandidate } from './ci/candidate.ts'
import { candidateConfig } from './ci/config.ts'

export interface CandidateRules {
  // The branch a candidate's pull request goes into: delivery.candidate.base.
  base: string
  // delivery.candidate.prefix.
  prefix: string
}

export interface BaseLookup {
  // A directory of the repository.
  cwd: string
  // delivery.candidate, or null when the project has no candidate: then nothing is asked.
  candidate: CandidateRules | null
  // The open candidate's branch, or null when none is open; throws when it cannot know.
  openCandidate: () => string | null
  // `new`: a branch about to be created (worktree start). `hotfix`: one about to be
  // created for a hotfix, which stays on the default branch. `head`: the branch HEAD is on.
  for: 'new' | 'hotfix' | 'head'
}

export interface Base {
  // The base branch's name, as a pull request names it (`candidate/13`, `main`).
  branch: string
  // What to branch from or diff against: `origin/<branch>`, or the fork point's sha.
  ref: string
  // One line on why, for the command to print.
  reason: string
  // Set when GitHub could not say which candidate is open: the base may be the wrong one.
  warning: string | null
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

// The branch origin/HEAD points at, else `main`.
export function repositoryDefault(cwd: string): string {
  const head = git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  return head?.replace(/^origin\//, '') || 'main'
}

// The branch pull requests go into: delivery.candidate.base, else origin/HEAD's, else main.
export function defaultBranch(cwd: string, candidate: CandidateRules | null): string {
  return candidate?.base ?? repositoryDefault(cwd)
}

// `origin/<branch>`; a missing one is an error, not a fall back on the local branch.
export function remoteRef(cwd: string, branch: string): string {
  const ref = `origin/${branch}`
  if (git(cwd, 'rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`) === null) {
    throw new Error(`no ${ref} in this clone: run git fetch origin, or give --base`)
  }
  return ref
}

export function resolveBase(lookup: BaseLookup): Base {
  const { cwd, candidate } = lookup
  const main = defaultBranch(cwd, candidate)
  const onMain = (why: string, warning: string | null = null): Base => ({
    branch: main,
    ref: remoteRef(cwd, main),
    reason: `origin/${main}: ${why}`,
    warning,
  })
  if (!candidate) return onMain('the default branch (no delivery.candidate)')
  if (lookup.for === 'hotfix') return onMain(`a hotfix goes into ${main}, not into a candidate`)
  let open: string | null
  try {
    open = lookup.openCandidate()
  } catch (error) {
    const why = `the open candidate is unknown (${(error as Error).message.split('\n')[0]})`
    return onMain(why, `${why}: the base is origin/${main}; give --base if the branch is on a candidate`)
  }
  if (!open) return onMain(`no ${candidate.prefix} branch is open`)
  const ref = remoteRef(cwd, open)
  if (lookup.for === 'new') return { branch: open, ref, reason: `${ref}: the open candidate`, warning: null }
  // The candidate itself: by name on a branch, by its head on a detached HEAD. A branch
  // just started on the candidate sits at its head too, and goes into the candidate.
  const current = git(cwd, 'branch', '--show-current')
  if (current ? current === open : git(cwd, 'rev-parse', 'HEAD') === git(cwd, 'rev-parse', ref)) {
    return onMain(`HEAD is ${open}, whose pull request goes into ${main}`)
  }
  // A branch started on the candidate holds the candidate's commits, which origin/<main>
  // does not have until the candidate merges; one started on origin/<main> forks there.
  const fork = git(cwd, 'merge-base', 'HEAD', ref)
  if (fork && git(cwd, 'merge-base', '--is-ancestor', fork, remoteRef(cwd, main)) === null) {
    return {
      branch: open,
      ref: fork,
      reason: `${open} from ${fork.slice(0, 7)}: the branch descends from it`,
      warning: null,
    }
  }
  return onMain(`the branch does not descend from the open candidate ${open}`)
}

// The candidate branch whose origin/ ref points at `ref` (a detached HEAD at a candidate's
// head), the highest when several do; null when none does.
export function candidateAt(cwd: string, prefix: string, ref = 'HEAD'): string | null {
  const out = git(cwd, 'for-each-ref', `--points-at=${ref}`, '--format=%(refname)', `refs/remotes/origin/${prefix}*`)
  const number = (name: string) => Number(name.slice(prefix.length))
  const names = (out ?? '')
    .split('\n')
    .map((line) => line.replace(/^refs\/remotes\/origin\//, ''))
    .filter((name) => /^\d+$/.test(name.slice(prefix.length)))
    .sort((a, b) => number(b) - number(a))
  return names[0] ?? null
}

// The open candidate's branch, asked to GitHub with gh: what the candidate automation
// itself reads (ci/candidate.ts). A merged candidate's branch stays on origin, so the
// refs cannot tell an open one.
export function githubCandidate(cwd: string): () => string | null {
  return () => {
    const config = candidateConfig(cwd)
    if (!config) return null
    const gh = makeGh({ dryRun: true, log: () => {} })
    const repo = env.GITHUB_REPOSITORY || gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    return openCandidate({ gh, repo, config })?.headRefName ?? null
  }
}

// The base of the branch in `cwd`, from the project's delivery.candidate and GitHub.
export function projectBase(cwd: string, kind: BaseLookup['for']): Base {
  const config = candidateConfig(cwd)
  return resolveBase({
    cwd,
    candidate: config ? { base: config.base, prefix: config.prefix } : null,
    openCandidate: githubCandidate(cwd),
    for: kind,
  })
}
