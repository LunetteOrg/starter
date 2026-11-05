// Where lntt review keeps what a branch carries between rounds: its state and its ledger of
// closed findings. One file of each per branch, named by the branch, so a review of one
// branch touches nothing of another's and closing a worktree takes nothing with it.
//
//   <place>/state/<branch>.json      <place>/ledger/<branch>.json
//
// The place is, in order: the operator profile's `review.stateDir`, the project's
// `delivery.review.stateDir`, the clone's common git directory (`lntt-review/` in it). A
// configured place is shared by clones, so it holds a folder per repository, `<org>/<repo>`.
// The lock and the progress file of a running round stay in the worktree's own git
// directory: they belong to the process, not to the branch.

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface PlaceInput {
  // `git rev-parse --path-format=absolute --git-common-dir`
  common: string
  // The main checkout: where a relative project value starts.
  main: string
  // `<org>/<repo>` from the origin URL, when there is one.
  slug: string | undefined
  // The operator profile's review.stateDir, and the project's delivery.review.stateDir.
  operator: unknown
  project: unknown
  home?: string
}

export interface Place {
  dir: string
  source: 'the operator profile (review.stateDir)' | 'delivery.review.stateDir' | 'the git common directory'
}

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

function expand(value: string, home: string): string {
  return value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
}

function text(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '')
    throw new Error(`${where} must be a path, not ${JSON.stringify(value)}`)
  return value
}

export function resolvePlace(input: PlaceInput): Place {
  const home = input.home ?? homedir()
  const operator = text(input.operator, "the operator profile's review.stateDir")
  const project = text(input.project, 'delivery.review.stateDir')
  let base: string
  let source: Place['source']
  if (operator !== undefined) {
    base = expand(operator, home)
    if (!isAbsolute(base)) {
      throw new Error(`the operator profile's review.stateDir must be an absolute path or start with ~: ${operator}`)
    }
    source = 'the operator profile (review.stateDir)'
  } else if (project !== undefined) {
    base = resolve(input.main, expand(project, home))
    source = 'delivery.review.stateDir'
  } else {
    return { dir: join(input.common, 'lntt-review'), source: 'the git common directory' }
  }
  // Outside the clone the repository is part of the key; with no origin, its git directory is.
  // An origin whose org or repo is `.` or `..` would leave the place: the git directory keys it.
  const named = input.slug?.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  const repository =
    named && input.slug ? input.slug : join('local', createHash('sha1').update(input.common).digest('hex').slice(0, 12))
  return { dir: join(base, repository), source }
}

export const statePathIn = (dir: string, branch: string): string => join(dir, 'state', `${branchKey(branch)}.json`)
export const ledgerPathIn = (dir: string, branch: string): string => join(dir, 'ledger', `${branchKey(branch)}.json`)

function keysIn(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
}

// The branches that have a state or a ledger in the place, by the name of their file: a
// file that cannot be read is listed too.
export function branchesIn(dir: string): string[] {
  const keys = new Set([...keysIn(join(dir, 'state')), ...keysIn(join(dir, 'ledger'))])
  return [...keys].map(keyBranch).filter((b): b is string => b !== null)
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

// A place on another filesystem than the git directory cannot be reached by a rename.
function move(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

// What a worktree kept in its own git directory before the place existed. Each file is read
// once: moved to the file of the branch it names (the newer wins when the place already has
// one), then it is gone from the old name, so the old place is never read again. One that
// cannot be read is set aside with the suffix `.unreadable`. `say` gets one line per file.
export function migrateOld(gitDir: string, dir: string, say: (line: string) => void): void {
  for (const [kind, name, target] of [
    ['state', 'lntt-review.json', statePathIn],
    ['ledger', 'lntt-review-ledger.json', ledgerPathIn],
  ] as const) {
    const old = join(gitDir, name)
    if (!existsSync(old)) continue
    let branch: unknown
    try {
      branch = (JSON.parse(readFileSync(old, 'utf8')) as { branch?: unknown } | null)?.branch
    } catch {}
    if (typeof branch !== 'string' || branch === '') {
      renameSync(old, `${old}.unreadable`)
      say(`${old} cannot be read: set aside as ${name}.unreadable, not migrated`)
      continue
    }
    const to = target(dir, branch)
    if (existsSync(to) && statSync(to).mtimeMs >= statSync(old).mtimeMs) {
      unlinkSync(old)
      say(`the ${kind} of ${branch} in ${old} is older than the one in ${to}: dropped`)
      continue
    }
    mkdirSync(join(to, '..'), { recursive: true })
    move(old, to)
    say(`moved the ${kind} of ${branch} from ${old} to ${to}`)
  }
}
