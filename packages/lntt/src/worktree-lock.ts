// One lock per worktree, shared by every command that reads or rewrites the worktree
// while it runs: `lntt review` (a round, a reply, `allow`) and `lntt check tests mutate`.
// Either refuses to start while the other holds it. The file sits in the worktree's git
// directory and holds `<pid> <command>`.

import { closeSync, linkSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class LockedError extends Error {}

// A holder touches its lock this often, and a lock touched within FRESH_MS counts as held
// even when its pid cannot be seen (another pid namespace answers ESRCH for a live process).
export const HEARTBEAT_MS = 5_000
export const FRESH_MS = 15_000
// A takeover guard older than this was left by a run that died inside the takeover.
const GUARD_MS = 10_000

export function lockPath(gitDir: string): string {
  return join(gitDir, 'lntt-review.lock')
}

export type Holder = { pid: number | null; command: string | null }

// ESRCH is a pid that is gone; EPERM is a process of another user, which is running.
function visible(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Who holds the lock, or null when nobody does: no file, a file naming no pid, this very
// process, or a pid that is gone in a lock nobody has touched lately. A file just created
// by an older lntt is empty for an instant, so a fresh empty one counts as held.
function holder(lock: string): Holder | null {
  let text: string
  let age: number
  try {
    text = readFileSync(lock, 'utf8').trim()
    age = Date.now() - statSync(lock).mtimeMs
  } catch {
    return null
  }
  if (text === '') return age < 2_000 ? { pid: null, command: null } : null
  const [first = '', ...rest] = text.split(/\s+/)
  const pid = Number(first)
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  const found = { pid, command: rest.join(' ') || null }
  return visible(pid) || age < FRESH_MS ? found : null
}

// The holder of the worktree's lock, null when nobody holds it.
export function heldBy(gitDir: string): Holder | null {
  return holder(lockPath(gitDir))
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Removing a dead lock is serialised by a guard file: of two runs that judged the lock
// dead, the second finds it alive again once the first has created its own, and leaves it.
function takeOver(lock: string): void {
  const guard = `${lock}.takeover`
  let fd: number
  try {
    fd = openSync(guard, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      if (Date.now() - statSync(guard).mtimeMs > GUARD_MS) rmSync(guard, { force: true })
    } catch {}
    sleep(20)
    return
  }
  try {
    if (holder(lock) === null) rmSync(lock, { force: true })
  } finally {
    closeSync(fd)
    rmSync(guard, { force: true })
  }
}

const beating = new Map<string, NodeJS.Timeout>()

function mine(lock: string): boolean {
  try {
    return readFileSync(lock, 'utf8').trim().split(/\s+/)[0] === String(process.pid)
  } catch {
    return false
  }
}

// The lock goes with the process, and its heartbeat with it.
export function releaseLock(gitDir: string): void {
  const lock = lockPath(gitDir)
  const timer = beating.get(lock)
  if (timer) clearInterval(timer)
  beating.delete(lock)
  if (mine(lock)) rmSync(lock, { force: true })
}

// Created complete by linking a file that already holds the pid and the command, so there is
// no instant with an empty lock, and atomically: of runs started together, one gets it.
// `judgedDead` is for tests: it runs between a run judging the lock dead and removing it.
export function acquireLock(
  gitDir: string,
  command: string,
  options: { heartbeatMs?: number; judgedDead?: () => void } = {},
): void {
  const lock = lockPath(gitDir)
  const own = `${lock}.${process.pid}`
  writeFileSync(own, `${process.pid} ${command}`)
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        linkSync(own, lock)
        process.on('exit', () => releaseLock(gitDir))
        const timer = setInterval(() => {
          try {
            if (mine(lock)) utimesSync(lock, new Date(), new Date())
          } catch {}
        }, options.heartbeatMs ?? HEARTBEAT_MS)
        timer.unref()
        beating.set(lock, timer)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const other = holder(lock)
      if (other !== null) {
        throw new LockedError(
          `${other.command ?? 'another lntt command'} is already running in this worktree (pid ${other.pid ?? 'starting'})`,
        )
      }
      options.judgedDead?.()
      takeOver(lock)
    }
    throw new LockedError('another lntt command is already running in this worktree (pid unknown)')
  } finally {
    rmSync(own, { force: true })
  }
}
