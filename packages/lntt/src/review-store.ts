// Where lntt review keeps what a branch carries between rounds: its state and its ledger of
// closed findings. One file of each per branch, named by the branch, so a review of one
// branch touches nothing of another's and closing a worktree takes nothing with it.
//
//   <place>/state/<branch>.json      <place>/ledger/<branch>.json
//
// The place is resolved in src/review/place.ts.
// The lock and the progress file of a running round stay in the worktree's own git
// directory: they belong to the process, not to the branch.

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Closed, Ledger, ReviewState } from './review.ts'

// A branch name as a file name: percent-encoded, capitals too, so `feat/1/x` is `feat%2F1%2Fx`
// and `Fix/A` is `%46ix%2F%41`. No two branches share a file, not even on a case-insensitive
// filesystem, and the name can be read back.
export function branchKey(branch: string): string {
  return [...branch].map((c) => (/[A-Z]/.test(c) ? `%${c.charCodeAt(0).toString(16)}` : encodeURIComponent(c))).join('')
}

export function keyBranch(key: string): string | null {
  try {
    return decodeURIComponent(key)
  } catch {
    return null
  }
}

export const statePathIn = (dir: string, branch: string): string => join(dir, 'state', `${branchKey(branch)}.json`)
export const ledgerPathIn = (dir: string, branch: string): string => join(dir, 'ledger', `${branchKey(branch)}.json`)

// A branch's state file as a round reads it: one that names another branch is an error, as one
// that is not JSON throws, never a round started on a guess.
export function parseState(text: string, path: string, branch: string): ReviewState {
  const state = JSON.parse(text) as ReviewState | null
  if (state?.branch !== branch)
    throw new Error(`${path} cannot be read: pnpm exec lntt review status --clear removes it`)
  return state
}

// A branch's ledger file: its closed findings, [] when it names another branch, null when it
// cannot be read (a write cut short), which the reader says.
export function parseLedger(text: string, branch: string): Closed[] | null {
  try {
    const ledger = JSON.parse(text) as Partial<Ledger>
    if (ledger.branch !== branch) return []
    if (Array.isArray(ledger.closed)) return ledger.closed
  } catch {}
  return null
}

function keysIn(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
}

// The branches that have a state or a ledger in the place, by the name of their file: a
// file that cannot be read is listed too. A name that is not the key of any branch (not
// percent-encoded, or encoded another way) names no branch and is left alone.
export function branchesIn(dir: string): string[] {
  const keys = new Set([...keysIn(join(dir, 'state')), ...keysIn(join(dir, 'ledger'))])
  return [...keys].flatMap((key) => {
    const branch = keyBranch(key)
    return branch !== null && branchKey(branch) === key ? [branch] : []
  })
}

export interface Refs {
  // Local branches, each with whether its upstream is gone (`[gone]` after fetch --prune).
  local: Map<string, boolean>
  // Branches that exist as a remote-tracking ref of any remote.
  remote: Set<string>
  // Branches checked out in a worktree of the clone.
  checkedOut: Set<string>
}

// Why the state of a branch can go, or null when it stays. A branch checked out in a
// worktree stays: a round may be running there. GitHub deletes the head branch on merge
// while the local branch stays, so a local branch whose upstream is gone goes too.
export function pruneReason(branch: string, refs: Refs): string | null {
  if (refs.checkedOut.has(branch)) return null
  if (refs.local.get(branch) === true) return 'its upstream is gone'
  if (refs.local.has(branch) || refs.remote.has(branch)) return null
  return 'no branch of that name is left'
}

export function parseRefs(forEachRef: string, worktrees: string): Refs {
  const local = new Map<string, boolean>()
  const remote = new Set<string>()
  for (const line of forEachRef.split('\n').filter(Boolean)) {
    const [ref = '', track = ''] = line.split('\t')
    if (ref.startsWith('refs/heads/')) local.set(ref.slice('refs/heads/'.length), track.includes('gone'))
    // refs/remotes/<remote>/<branch>
    else if (ref.startsWith('refs/remotes/')) {
      const branch = ref.split('/').slice(3).join('/')
      if (branch !== '' && branch !== 'HEAD') remote.add(branch)
    }
  }
  const checkedOut = new Set(
    worktrees
      .split('\n')
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  )
  return { local, remote, checkedOut }
}

export function removeBranch(dir: string, branch: string): string[] {
  const removed: string[] = []
  for (const [name, path] of [
    ['state', statePathIn(dir, branch)],
    ['ledger', ledgerPathIn(dir, branch)],
  ] as const) {
    if (!existsSync(path)) continue
    unlinkSync(path)
    removed.push(name)
  }
  return removed
}
