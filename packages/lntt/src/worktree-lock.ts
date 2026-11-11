// One lock per worktree, shared by every command that reads or rewrites the worktree
// while it runs: `lntt review` (a round, a reply, `allow`) and `lntt check tests mutate`.
// Either refuses to start while the other holds it. The file sits in the worktree's git
// directory and holds `<pid> <command>`.
//
// The lock is taken by one Effect (src/worktree/lock.ts). `lntt review` holds it as a resource
// of its scope (lockWorktree), released however the command ends. This module imports no
// Effect, because `lntt check` and `lntt review status` load it: it holds the rules of who
// holds the lock, the lock's holder read synchronously, and the Promise entry of
// `lntt check tests mutate`, whose lock goes with the process's exit until it moves to Effect.

import { readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

// A holder touches its lock this often, and a lock touched within FRESH_MS counts as held
// even when its pid cannot be seen (another pid namespace answers ESRCH for a live process).
export const HEARTBEAT_MS = 5_000
export const FRESH_MS = 15_000
// A takeover guard older than this was left by a run that died inside the takeover.
export const GUARD_MS = 10_000
// A pid answers for a holder that is gone once the system reuses it for another process, so
// a lock untouched this long is dead whatever its pid does. A holder blocked in a long
// synchronous step (the mutations of a round) does not touch the lock, which is why the
// limit is far past any round or mutation run.
export const MAX_HOLD_MS = 12 * 60 * 60 * 1000
// A file just created by an older lntt is empty for an instant: held this long.
const EMPTY_MS = 2_000

export function lockPath(gitDir: string): string {
  return join(gitDir, 'lntt-review.lock')
}

export type Holder = { pid: number | null; command: string | null }

// The pid a lock's text names, null when it names none.
export function namedPid(text: string): number | null {
  const pid = Number(text.trim().split(/\s+/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

// Who holds a lock with this text, last touched `ageMs` ago, as seen from the process `self`;
// `visible` says whether the pid it names is running. Null when nobody does: a file naming no
// pid, this very process, a pid that is gone in a lock nobody has touched lately, or a lock
// untouched for MAX_HOLD_MS. A fresh empty file counts as held.
export function judge(text: string, ageMs: number, self: number, visible: boolean): Holder | null {
  const trimmed = text.trim()
  if (trimmed === '') return ageMs < EMPTY_MS ? { pid: null, command: null } : null
  const pid = namedPid(trimmed)
  if (pid === null || pid === self) return null
  const command = trimmed.split(/\s+/).slice(1).join(' ') || null
  return (visible && ageMs < MAX_HOLD_MS) || ageMs < FRESH_MS ? { pid, command } : null
}

// What a refusal says of the holder: its command, and its pid, `starting` for a lock that
// names none yet, `unknown` when no holder could be read.
export function lockedMessage(holder: Holder | null): string {
  if (holder === null) return 'another lntt command is already running in this worktree (pid unknown)'
  return `${holder.command ?? 'another lntt command'} is already running in this worktree (pid ${holder.pid ?? 'starting'})`
}

// A lock refused because another command holds it (LockedError of src/worktree/lock.ts), told
// apart without loading Effect.
export function isLocked(error: unknown): error is Error {
  return error instanceof Error && (error as { _tag?: unknown })._tag === 'LockedError'
}

// ESRCH is a pid that is gone; EPERM is a process of another user, which is running.
export function visible(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(lock: string): { text: string; ageMs: number } | null {
  try {
    return { text: readFileSync(lock, 'utf8'), ageMs: Date.now() - statSync(lock).mtimeMs }
  } catch {
    return null
  }
}

// The holder of the worktree's lock, null when nobody holds it.
export function heldBy(gitDir: string): Holder | null {
  const read = readLock(lockPath(gitDir))
  if (read === null) return null
  const pid = namedPid(read.text)
  return judge(read.text, read.ageMs, process.pid, pid !== null && visible(pid))
}

// The Promise entry, for `lntt check tests mutate`, still on Promises: the lock is taken by the
// same Effect as a round's, and goes with the process's exit, its heartbeat a timer of its own.
// A command on Effect holds it with lockWorktree instead.

const beating = new Map<string, NodeJS.Timeout>()

function mine(lock: string): boolean {
  const read = readLock(lock)
  return read !== null && namedPid(read.text) === process.pid
}

export function releaseLock(gitDir: string): void {
  const lock = lockPath(gitDir)
  const timer = beating.get(lock)
  if (timer) clearInterval(timer)
  beating.delete(lock)
  if (mine(lock)) rmSync(lock, { force: true })
}

export async function acquireLock(
  gitDir: string,
  command: string,
  options: { heartbeatMs?: number } = {},
): Promise<void> {
  const [Effect, { acquire, WorktreeLockLive }] = await Promise.all([
    import('effect/Effect'),
    import('./worktree/lock.ts'),
  ])
  await Effect.runPromise(acquire(gitDir, command).pipe(Effect.provide(WorktreeLockLive)))
  const lock = lockPath(gitDir)
  process.on('exit', () => releaseLock(gitDir))
  const timer = setInterval(() => {
    try {
      if (mine(lock)) utimesSync(lock, new Date(), new Date())
    } catch {}
  }, options.heartbeatMs ?? HEARTBEAT_MS)
  timer.unref()
  beating.set(lock, timer)
}
