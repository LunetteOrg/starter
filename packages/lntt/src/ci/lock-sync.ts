// The ci:local lock for the library (`acquireLock` in `@lntt/lntt/ci`): a synchronous shell over
// `node:` around the lock's plain rules (src/ci/lock-rules.ts), whose `release` and `setGroup`
// return when the file is changed, and which loads no Effect. `lntt ci local` takes the lock on
// Effect, as a resource of its scope (src/ci/lock.ts); both act on the same files the same way.
// Transitional: the shell goes with #341.

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
import { dirname } from 'node:path'
import {
  GROUP_WAIT_MS,
  GUARD_STALE_MS,
  held,
  holderKey,
  type Identity,
  type LockScope,
  lockDir,
  lockFailure,
  lockPath,
  type Owner,
  ours,
  overdue,
  POLL_MS,
  parse,
  pollInterval,
  RELEASE_WAIT_MS,
  record,
  SHORT_PAUSE_MS,
  temporaryName,
  tookLine,
  unreadable,
  type Verdict,
  waitingLine,
  withGroup,
} from './lock-rules.ts'

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

const tmp = (path: string) => temporaryName(path, process.pid, randomUUID())

// The record is written whole under a temporary name, then linked to the lock's: a
// waiter never reads half of it, and a lock that is taken is never overwritten.
function publish(path: string, text: string): boolean {
  const temporary = tmp(path)
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

// The takeover guard: every change to a published lock happens under it. Its release, or null
// while another run holds it; a guard left by a crash is removed, and the next attempt takes it.
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

// Removes the guard left by a crash, `seen` its content, if it is still that guard and still old;
// whether it did. Renamed aside first, so that of two waiters that judged it stale only one gets
// it; a fresh guard renamed aside by the other is linked back.
export function removeStaleGuard(guard: string, seen: string, now: () => number = Date.now): boolean {
  const aside = tmp(guard)
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

// The guard for a synchronous change: waits for it in short steps, up to `waitMs`, then gives up
// without making the change; whether it made it.
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

function judge(text: string, path: string, deps: LockDeps): Verdict {
  const owner = parse(text)
  const now = deps.now()
  if (!owner) {
    let modified: number | null = null
    try {
      modified = statSync(path).mtimeMs
    } catch {}
    return unreadable(path, now, modified)
  }
  return (
    overdue(path, owner, now) ??
    held(path, owner, now, deps.alive(owner.pid), owner.group !== undefined && deps.groupAlive(owner.group))
  )
}

// Removes the stale lock under the takeover guard, and only if it is still the record judged
// stale. 'busy' while another run holds the guard.
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

// Rewrites the record with the step's process group, while it is still the one `owner` published.
export function recordGroup(path: string, owner: Owner, group: number | null, waitMs = GROUP_WAIT_MS): void {
  withGuardSync(path, waitMs, () => {
    if (!ours(current(path), owner)) return
    const temporary = tmp(path)
    try {
      writeFileSync(temporary, record(withGroup(owner, group)))
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  })
}

export async function acquire(deps: LockDeps): Promise<Lock> {
  mkdirSync(dirname(deps.path), { recursive: true })
  const announced = new Set<string>()
  const interval = deps.interval ?? POLL_MS
  const pause = Math.min(interval, SHORT_PAUSE_MS)
  let waitingSince: number | null = null
  for (;;) {
    const owner: Owner = { ...deps.owner, started: new Date(deps.now()).toISOString() }
    if (publish(deps.path, record(owner))) {
      if (waitingSince !== null) deps.log(tookLine(deps.now() - waitingSince))
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
      const key = holderKey(verdict.owner, verdict.orphan)
      if (!announced.has(key)) {
        announced.add(key)
        deps.log(waitingLine(deps.path, verdict.owner, verdict.orphan, deps.now()))
      }
    }
    waitingSince ??= deps.now()
    await deps.sleep(interval)
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

// Why the lock could not be taken, in one line; `ci local` exits 1 on it.
export class LockError extends Error {}

export function lockError(error: unknown, path: string): LockError {
  return new LockError(lockFailure(error, path))
}

// The lock for a run from `worktree`, with the real clock, processes and host.
export async function acquireLock(
  worktree: string,
  scope: LockScope,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<Lock> {
  const dir = lockDir(env, homedir())
  let path = dir
  const interval = pollInterval(env)
  try {
    const commonDir =
      scope === 'project'
        ? execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd: worktree,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()
        : ''
    path = lockPath(dir, scope, commonDir, createHash('sha256').update(commonDir).digest('hex'))
    return await acquire({
      path,
      owner: { pid: process.pid, host: hostname(), worktree },
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      alive,
      groupAlive: (group) => alive(-group),
      log,
      ...(interval ? { interval } : {}),
    })
  } catch (error) {
    throw lockError(error, path)
  }
}
