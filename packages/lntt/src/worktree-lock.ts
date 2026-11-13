// The worktree's lock read synchronously: a shell over node: around the rules of
// src/worktree/holder.ts, for `lntt review status`, not on Effect. The lock is taken by one Effect
// (src/worktree/lock.ts): `lntt review` and `lntt check tests mutate` hold it as a resource of their
// scope (lockWorktree), released however the command ends. This module loads no Effect when it is
// imported. Transitional, like src/config/sync.ts.

import { readFileSync, statSync } from 'node:fs'
import { type Holder, judge, lockPath, namedPid } from './worktree/holder.ts'

export {
  EMPTY_MS,
  FRESH_MS,
  GUARD_MS,
  HEARTBEAT_MS,
  type Holder,
  isLocked,
  judge,
  lockedMessage,
  lockPath,
  MAX_HOLD_MS,
  namedPid,
} from './worktree/holder.ts'

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
