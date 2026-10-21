// The ci:local lock: one run at a time, so parallel worktrees queue instead of starving
// each other's tests. It is a file in a folder of the machine's cache, holding the owner's
// record (pid, host, worktree, the moment it took the lock, the process group of the step
// it runs); a run that finds it taken says whom it waits for, and takes it over once the
// owner and its step are gone, the record never got written, or the owner has held it
// past the maximum hold time and failed to stop.

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

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

// The longest a run holds the lock: past it, the holder stops its run (run.ts, `deadline`),
// and a waiter takes the lock over once the grace has passed too, the holder having failed
// to stop. A full local CI takes minutes, not hours.
export const MAX_HOLD_MINUTES = 120
export const TAKEOVER_GRACE_MINUTES = 2

// The run's own limit (run.ts, `deadline`): the maximum hold time, from when `owner` took
// the lock.
export function holdDeadline(owner: Owner): { at: number; reason: string } {
  return {
    at: Date.parse(owner.started) + MAX_HOLD_MINUTES * 60_000,
    reason: `the run passed the lock's maximum hold time of ${MAX_HOLD_MINUTES} minutes`,
  }
}

// A record is written whole under another name and linked in, so an unreadable one is a
// crash between the two or a file put there by hand; after this long it is stale. The
// takeover guard is held for a few file operations, so one this old was left by a crash.
const UNREADABLE_STALE_MS = 10_000
const GUARD_STALE_MS = 10_000

// How long a change waits for the takeover guard before it gives up: a step's process
// group briefly, at each start and close of a step; a release longer, after which the
// record goes stale by its owner's dead pid.
export const GROUP_WAIT_MS = 200
export const RELEASE_WAIT_MS = 2000

// How long a waiter pauses before looking again at a lock that vanished as it read it,
// or whose takeover guard another run holds.
const SHORT_PAUSE_MS = 50

// $LNTT_CI_LOCK_DIR, else the user's cache folder.
export function lockDir(env: Record<string, string | undefined> = process.env): string {
  if (env.LNTT_CI_LOCK_DIR) return env.LNTT_CI_LOCK_DIR
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'lntt')
}

// The machine scope is one file; the project scope one file per repository, named by
// its git common dir, which every worktree of the repository shares.
export function lockPath(dir: string, scope: LockScope, commonDir: string): string {
  if (scope === 'machine') return join(dir, 'ci-local.lock')
  const name = basename(commonDir) === '.git' ? basename(dirname(commonDir)) : basename(commonDir, '.git')
  const hash = createHash('sha256').update(commonDir).digest('hex').slice(0, 12)
  return join(dir, `ci-local-${name}-${hash}.lock`)
}

export function gitCommonDir(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export interface LockDeps {
  path: string
  owner: Identity
  now: () => number
  sleep: (ms: number) => Promise<void>
  // Whether a process is running.
  alive: (pid: number) => boolean
  // Whether a process group still has a member.
  groupAlive: (group: number) => boolean
  log: (line: string) => void
  // How often a waiter looks at the lock again.
  interval?: number
}

export interface Lock {
  path: string
  // The record as published: `started` is the moment the lock was taken.
  owner: Owner
  release: () => void
  // Records the process group of the step being run (null once it closed), so a waiter
  // does not take the lock over from a step that outlived its owner.
  setGroup: (group: number | null) => void
}

const temporaryName = (path: string) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)

// The record is written whole under a temporary name, then linked to the lock's: a
// waiter never reads half of it, and a lock that is taken is never overwritten.
function publish(path: string, text: string): boolean {
  const temporary = temporaryName(path)
  try {
    writeFileSync(temporary, text)
    linkSync(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parse(text: string): Owner | null {
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

const record = (owner: Owner) => `${JSON.stringify(owner)}\n`

// The takeover guard: every change to a published lock (a stale one removed, a release, a
// new process group recorded) happens under it, so none of them acts on a record another
// run has just replaced. Returns its release, or null while another run holds it; a guard
// left by a crash is removed, and the next attempt takes it.
function takeGuard(path: string): (() => void) | null {
  const guard = `${path}.takeover`
  const token = randomUUID()
  let fd: number
  try {
    fd = openSync(guard, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      const seen = readFileSync(guard, 'utf8')
      if (Date.now() - statSync(guard).mtimeMs > GUARD_STALE_MS) removeStaleGuard(guard, seen)
    } catch {}
    return null
  }
  try {
    writeSync(fd, token)
  } finally {
    closeSync(fd)
  }
  return () => {
    if (read(guard) === token) rmSync(guard, { force: true })
  }
}

// Removes the guard left by a crash, `seen` its content, if it is still that guard and
// still old; whether it did. Renamed aside first, so that of two waiters that judged it
// stale only one gets it; a fresh guard renamed aside by the other is linked back. While
// it is aside a third run can take the guard: no rename is conditional, so that instant
// stays open, and the age is checked again right before it to keep it rare.
export function removeStaleGuard(guard: string, seen: string, now: () => number = Date.now): boolean {
  const aside = temporaryName(guard)
  try {
    if (now() - statSync(guard).mtimeMs <= GUARD_STALE_MS) return false
    renameSync(guard, aside)
  } catch {
    return false
  }
  try {
    const stale = readFileSync(aside, 'utf8') === seen && now() - statSync(aside).mtimeMs > GUARD_STALE_MS
    if (!stale) {
      try {
        linkSync(aside, guard)
      } catch {}
    }
    return stale
  } finally {
    rmSync(aside, { force: true })
  }
}

// The guard for a synchronous change: waits for it in short steps, up to `waitMs`, then
// gives up without making the change; whether it made it.
function withGuardSync(path: string, waitMs: number, change: () => void): boolean {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  const until = Date.now() + waitMs
  let free = takeGuard(path)
  while (!free) {
    if (Date.now() >= until) return false
    Atomics.wait(pause, 0, 0, 10)
    free = takeGuard(path)
  }
  try {
    change()
  } finally {
    free()
  }
  return true
}

function duration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m`
}

function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function describe(owner: Owner, now: number): string {
  return `${owner.worktree} (pid ${owner.pid} on ${owner.host}, since ${clock(owner.started)}, ${duration(now - Date.parse(owner.started))} ago)`
}

type Verdict =
  | { stale: string }
  | { owner: Owner; orphan: boolean }
  // An unreadable record still being written: waited for silently.
  | { pending: true }

// Whether the lock in `text` can be taken over, and why; else who holds it.
function judge(text: string, path: string, deps: LockDeps): Verdict {
  const owner = parse(text)
  const now = deps.now()
  if (!owner) {
    let modified: number
    try {
      modified = statSync(path).mtimeMs
    } catch {
      return { pending: true }
    }
    return now - modified > UNREADABLE_STALE_MS
      ? { stale: `lntt ci: the ci:local lock has no readable owner record: taking it over — ${path}` }
      : { pending: true }
  }
  if (now - Date.parse(owner.started) > (MAX_HOLD_MINUTES + TAKEOVER_GRACE_MINUTES) * 60_000) {
    return {
      stale: `lntt ci: TAKING OVER the ci:local lock held by ${describe(owner, now)}, past the maximum hold time of ${MAX_HOLD_MINUTES} minutes — ${path}`,
    }
  }
  if (deps.alive(owner.pid)) return { owner, orphan: false }
  if (owner.group !== undefined && deps.groupAlive(owner.group)) return { owner, orphan: true }
  return {
    stale: `lntt ci: the ci:local lock was held by ${describe(owner, now)}, which is no longer running: taking it over — ${path}`,
  }
}

// Removes the stale lock under the takeover guard, and only if it is still the record
// judged stale: a lock another run took meanwhile stays ('changed'). 'busy' while another
// run holds the guard.
function removeStale(path: string, text: string): 'removed' | 'changed' | 'busy' {
  const free = takeGuard(path)
  if (!free) return 'busy'
  try {
    if (read(path) !== text) return 'changed'
    try {
      unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return 'removed'
  } finally {
    free()
  }
}

const ours = (holder: Owner | null, owner: Owner) =>
  holder !== null && holder.pid === owner.pid && holder.started === owner.started

function current(path: string): Owner | null {
  const text = read(path)
  return text === null ? null : parse(text)
}

// Removes the lock if its record is still the one `owner` published.
export function release(path: string, owner: Owner, waitMs = RELEASE_WAIT_MS): void {
  const done = withGuardSync(path, waitMs, () => {
    if (ours(current(path), owner)) rmSync(path, { force: true })
  })
  if (!done) throw new Error(`the guard stayed taken for ${waitMs} ms`)
}

// Rewrites the record with the step's process group, while it is still the one `owner`
// published: written whole under another name, then renamed over the lock.
export function recordGroup(path: string, owner: Owner, group: number | null, waitMs = GROUP_WAIT_MS): void {
  withGuardSync(path, waitMs, () => {
    if (!ours(current(path), owner)) return
    const { group: _, ...rest } = owner
    const temporary = temporaryName(path)
    try {
      writeFileSync(temporary, record(group === null ? rest : { ...rest, group }))
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  })
}

export async function acquire(deps: LockDeps): Promise<Lock> {
  mkdirSync(dirname(deps.path), { recursive: true })
  const announced = new Set<string>()
  const pause = Math.min(deps.interval ?? 5000, SHORT_PAUSE_MS)
  let waitingSince: number | null = null
  for (;;) {
    const owner: Owner = { ...deps.owner, started: new Date(deps.now()).toISOString() }
    if (publish(deps.path, record(owner))) {
      if (waitingSince !== null) {
        deps.log(`lntt ci: took the ci:local lock after ${duration(deps.now() - waitingSince)} of waiting`)
      }
      return {
        path: deps.path,
        owner,
        release: () => release(deps.path, owner),
        setGroup: (group) => {
          // A record that cannot be rewritten leaves the lock to the owner's pid alone.
          try {
            recordGroup(deps.path, owner, group)
          } catch {}
        },
      }
    }
    const text = read(deps.path)
    if (text === null) {
      // Released between the attempt and the read: the next attempt likely takes it.
      await deps.sleep(pause)
      continue
    }
    const verdict = judge(text, deps.path, deps)
    if ('stale' in verdict) {
      const removal = removeStale(deps.path, text)
      if (removal === 'removed') deps.log(verdict.stale)
      if (removal === 'busy') await deps.sleep(pause)
      continue
    }
    if ('owner' in verdict) {
      const { owner: holder, orphan } = verdict
      const key = `${holder.pid}|${holder.started}|${orphan ? holder.group : ''}`
      if (!announced.has(key)) {
        announced.add(key)
        deps.log(
          orphan
            ? `lntt ci: waiting for the ci:local lock held by ${describe(holder, deps.now())}, which is no longer running, but its step (process group ${holder.group}) still is — ${deps.path}`
            : `lntt ci: waiting for the ci:local lock held by ${describe(holder, deps.now())} — ${deps.path}`,
        )
      }
    }
    waitingSince ??= deps.now()
    await deps.sleep(deps.interval ?? 5000)
  }
}

// Whether a process is running: EPERM is a process of another user.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Whether a process group still has a member.
export function groupAlive(group: number): boolean {
  return alive(-group)
}

// Why the lock could not be taken, in one line; `ci local` exits 1 on it.
export class LockError extends Error {}

// The reason is the first line of the error's stderr or message, else its code or name.
export function lockError(error: unknown, path: string): LockError {
  const failure = error as { stderr?: string; message?: string; code?: string; name?: string }
  const reason =
    (failure?.stderr || failure?.message || '').trim().split('\n')[0] || failure?.code || failure?.name || String(error)
  return new LockError(`cannot take the ci:local lock (${reason}) — ${path}; --no-lock runs without it`)
}

// $LNTT_CI_LOCK_POLL_MS shortens the wait between looks, for tests; a value that is not a
// positive number is ignored.
export function pollInterval(env: Record<string, string | undefined>): number | undefined {
  const poll = Number(env.LNTT_CI_LOCK_POLL_MS)
  return Number.isFinite(poll) && poll > 0 ? poll : undefined
}

// The lock for a run from `worktree`, with the real clock, processes and host.
export async function acquireLock(
  worktree: string,
  scope: LockScope,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<Lock> {
  const dir = lockDir(env)
  let path = dir
  const interval = pollInterval(env)
  try {
    path = lockPath(dir, scope, scope === 'project' ? gitCommonDir(worktree) : '')
    return await acquire({
      path,
      owner: { pid: process.pid, host: hostname(), worktree },
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      alive,
      groupAlive,
      log,
      ...(interval ? { interval } : {}),
    })
  } catch (error) {
    throw lockError(error, path)
  }
}
