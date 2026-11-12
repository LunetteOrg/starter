// What the base reads from the names git and GitHub give (docs/adr/worktree-tooling.md): the
// default branch from origin/HEAD, the candidate among the refs at a commit, the open candidate
// among the pull requests, the ref --base names. Plain functions, no Effect: the base on Effect
// (src/base/base.ts) and the sync code of lntt ci (src/ci/event.ts) read the names the same way.

export interface CandidateRules {
  // The branch a candidate's pull request goes into: delivery.candidate.base.
  base: string
  // delivery.candidate.prefix.
  prefix: string
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

// `new`: a branch about to be created (worktree start). `hotfix`: one about to be created for a
// hotfix, which stays on the default branch. `head`: the branch HEAD is on.
export type BaseFor = 'new' | 'hotfix' | 'head'

// delivery.candidate of the project's configuration, null when the project has no candidate.
export function candidateRules(data: Record<string, unknown>): CandidateRules | null {
  const delivery = data.delivery as { candidate?: { base?: string; prefix: string } } | undefined
  const section = delivery?.candidate
  return section ? { base: section.base ?? 'main', prefix: section.prefix } : null
}

// The branch of origin/HEAD (`origin/main` → `main`), else `main`.
export function defaultOf(originHead: string | null): string {
  return originHead?.replace(/^origin\//, '') || 'main'
}

// The candidate number of a branch name (`candidate/13` → 13), or null.
export function candidateNumber(prefix: string, name: string | undefined): number | null {
  const rest = name?.startsWith(prefix) ? name.slice(prefix.length) : null
  return rest !== null && /^\d+$/.test(rest) ? Number(rest) : null
}

// The candidate among the full names of refs under refs/remotes/origin/<prefix>, the highest by
// number; null when none is one.
export function highestCandidate(refs: string[], prefix: string): string | null {
  const names = refs
    .map((ref) => ref.replace(/^refs\/remotes\/origin\//, ''))
    .filter((name) => candidateNumber(prefix, name) !== null)
    .sort((a, b) => (candidateNumber(prefix, b) as number) - (candidateNumber(prefix, a) as number))
  return names[0] ?? null
}

// The open candidate among the open pull requests into the base whose head starts with the
// prefix: the lowest by number, as the candidate automation reads it (src/ci/candidate.ts).
export function openCandidateOf<T extends { headRefName: string }>(prs: T[], prefix: string): T | null {
  const candidates = prs.filter((pr) => candidateNumber(prefix, pr.headRefName) !== null)
  candidates.sort(
    (a, b) => (candidateNumber(prefix, a.headRefName) as number) - (candidateNumber(prefix, b.headRefName) as number),
  )
  return candidates[0] ?? null
}

// The refs --base may name, in the order they are tried: the remote's copy, then a branch only
// this clone has.
export function localRefs(branch: string): string[] {
  return [`origin/${branch}`, branch]
}
