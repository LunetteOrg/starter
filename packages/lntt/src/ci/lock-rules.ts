// The rules of the ci:local lock, plain: where it is, what its record says, when it can be taken
// over, and the lines a run prints about it. The lock on Effect (src/ci/lock.ts) and the library's
// synchronous shell (src/ci/lock-sync.ts) act on the files with these.
//
// The lock is a file in a folder of the machine's cache, holding the owner's record (pid, host,
// worktree, the moment it took the lock, the process group of the step it runs); a run that finds
// it taken says whom it waits for, and takes it over once the owner and its step are gone, the
// record never got written, or the owner has held it past the maximum hold time and failed to
// stop.

export type LockScope = 'machine' | 'project'

// Who runs: the record without the moment the lock was taken.
export interface Identity {
  pid: number
  // For display: the lock folder is the user's local cache, so a pid is judged here.
  host: string
  worktree: string
}

export interface Owner extends Identity {
  started: string
  // The process group of the step the owner is running, while it runs one.
  group?: number
}

// The longest a run holds the lock: past it, the holder stops its run (the runner's `deadline`),
// and a waiter takes the lock over once the grace has passed too, the holder having failed to
// stop. A full local CI takes minutes, not hours.
export const MAX_HOLD_MINUTES = 120
export const TAKEOVER_GRACE_MINUTES = 2

// The run's own limit (the runner's `deadline`): the maximum hold time, from when `owner` took the
// lock.
export function holdDeadline(owner: Owner): { at: number; reason: string } {
  return {
    at: Date.parse(owner.started) + MAX_HOLD_MINUTES * 60_000,
    reason: `the run passed the lock's maximum hold time of ${MAX_HOLD_MINUTES} minutes`,
  }
}

// A record is written whole under another name and linked in, so an unreadable one is a crash
// between the two or a file put there by hand; after this long it is stale. The takeover guard is
// held for a few file operations, so one this old was left by a crash.
export const UNREADABLE_STALE_MS = 10_000
export const GUARD_STALE_MS = 10_000

// How long a change waits for the takeover guard before it gives up: a step's process group
// briefly, at each start and close of a step; a release longer, after which the record goes stale
// by its owner's dead pid.
export const GROUP_WAIT_MS = 200
export const RELEASE_WAIT_MS = 2000

// How long a waiter pauses before looking again at a lock that vanished as it read it, or whose
// takeover guard another run holds; and how often it looks at a held lock.
export const SHORT_PAUSE_MS = 50
export const POLL_MS = 5000

// $LNTT_CI_LOCK_DIR, else the user's cache folder.
export function lockDir(env: Record<string, string | undefined>, home: string): string {
  if (env.LNTT_CI_LOCK_DIR) return env.LNTT_CI_LOCK_DIR
  return `${env.XDG_CACHE_HOME || `${home}/.cache`}/lntt`
}

const base = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? ''
const parentOf = (path: string) => path.replace(/\/+$/, '').split('/').slice(0, -1).join('/')

// The machine scope is one file; the project scope one file per repository, named by its git
// common dir, which every worktree of the repository shares; `hash` is the sha256 of that dir, in
// hex.
export function lockPath(dir: string, scope: LockScope, commonDir: string, hash: string): string {
  if (scope === 'machine') return `${dir}/ci-local.lock`
  const name = base(commonDir) === '.git' ? base(parentOf(commonDir)) : base(commonDir).replace(/\.git$/, '')
  return `${dir}/ci-local-${name}-${hash.slice(0, 12)}.lock`
}

// The name a record is written under before it is linked or renamed to `path`.
export const temporaryName = (path: string, pid: number, id: string) =>
  `${parentOf(path)}/.${base(path)}.${pid}.${id}.tmp`

export function parse(text: string): Owner | null {
  try {
    const owner = JSON.parse(text) as Partial<Owner>
    if (
      typeof owner.pid === 'number' &&
      typeof owner.host === 'string' &&
      typeof owner.worktree === 'string' &&
      typeof owner.started === 'string' &&
      !Number.isNaN(Date.parse(owner.started)) &&
      (owner.group === undefined || typeof owner.group === 'number')
    )
      return owner as Owner
  } catch {}
  return null
}

export const record = (owner: Owner) => `${JSON.stringify(owner)}\n`

// The record rewritten with the step's process group, or without one.
export function withGroup(owner: Owner, group: number | null): Owner {
  const { group: _, ...rest } = owner
  return group === null ? rest : { ...rest, group }
}

// Whether `holder` is the record `owner` published.
export const ours = (holder: Owner | null, owner: Owner) =>
  holder !== null && holder.pid === owner.pid && holder.started === owner.started

export function duration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`
}

function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function describeHolder(owner: Owner, now: number): string {
  return `${owner.worktree} (pid ${owner.pid} on ${owner.host}, since ${clock(owner.started)}, ${duration(now - Date.parse(owner.started))} ago)`
}

export type Verdict =
  | { stale: string }
  | { owner: Owner; orphan: boolean }
  // An unreadable record still being written: waited for silently.
  | { pending: true }

// A record that does not parse, last modified at `modified` (null when it is gone).
export function unreadable(path: string, now: number, modified: number | null): Verdict {
  if (modified === null || now - modified <= UNREADABLE_STALE_MS) return { pending: true }
  return { stale: `lntt ci: the ci:local lock has no readable owner record: taking it over — ${path}` }
}

// A record held past the maximum hold time and its grace: stale whoever holds it.
export function overdue(path: string, owner: Owner, now: number): Verdict | null {
  if (now - Date.parse(owner.started) <= (MAX_HOLD_MINUTES + TAKEOVER_GRACE_MINUTES) * 60_000) return null
  return {
    stale: `lntt ci: TAKING OVER the ci:local lock held by ${describeHolder(owner, now)}, past the maximum hold time of ${MAX_HOLD_MINUTES} minutes — ${path}`,
  }
}

// A record within its time: held while its owner runs, or its step does; else stale.
export function held(path: string, owner: Owner, now: number, alive: boolean, groupAlive: boolean): Verdict {
  if (alive) return { owner, orphan: false }
  if (owner.group !== undefined && groupAlive) return { owner, orphan: true }
  return {
    stale: `lntt ci: the ci:local lock was held by ${describeHolder(owner, now)}, which is no longer running: taking it over — ${path}`,
  }
}

// What a waiter says once per holder it waits for.
export function waitingLine(path: string, holder: Owner, orphan: boolean, now: number): string {
  return orphan
    ? `lntt ci: waiting for the ci:local lock held by ${describeHolder(holder, now)}, which is no longer running, but its step (process group ${holder.group}) still is — ${path}`
    : `lntt ci: waiting for the ci:local lock held by ${describeHolder(holder, now)} — ${path}`
}

// The key a holder is announced under: a holder that becomes an orphan is announced again.
export const holderKey = (holder: Owner, orphan: boolean) =>
  `${holder.pid}|${holder.started}|${orphan ? holder.group : ''}`

export const tookLine = (waitedMs: number) => `lntt ci: took the ci:local lock after ${duration(waitedMs)} of waiting`

// What went wrong, in one line: the first line of the error's stderr, of the system error it
// wraps (Node's `ENOTDIR: …` under Effect's PlatformError) or of its message, else its code or name.
export function failureReason(error: unknown): string {
  const failure = error as {
    stderr?: string
    cause?: { message?: unknown }
    message?: string
    code?: string
    name?: string
  }
  const cause = typeof failure?.cause?.message === 'string' ? failure.cause.message : ''
  return (
    (failure?.stderr || cause || failure?.message || '').trim().split('\n')[0] ||
    failure?.code ||
    failure?.name ||
    String(error)
  )
}

// Why the lock could not be taken, in one line; `ci local` exits 1 on it.
export function lockFailure(error: unknown, path: string): string {
  return `cannot take the ci:local lock (${failureReason(error)}) — ${path}; --no-lock runs without it`
}

// $LNTT_CI_LOCK_POLL_MS shortens the wait between looks, for tests; a value that is not a
// positive number is ignored.
export function pollInterval(env: Record<string, string | undefined>): number | undefined {
  const poll = Number(env.LNTT_CI_LOCK_POLL_MS)
  return Number.isFinite(poll) && poll > 0 ? poll : undefined
}
