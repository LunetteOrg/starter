// The worktree's lock for the commands not yet on Effect: a synchronous shell over node: around the
// rules of src/worktree/holder.ts. The lock is taken by one Effect (src/worktree/lock.ts);
// `lntt review` holds it as a resource of its scope (lockWorktree), released however the command
// ends. This module loads no Effect when it is imported, because `lntt check` and `lntt review
// status` import it: it holds the lock's holder read synchronously, and the Promise entry of
// `lntt check tests mutate`, which loads Effect only when it runs, and whose lock goes with the
// process's exit until that command moves to Effect (#337). Transitional, like src/config/sync.ts.

import { readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { HEARTBEAT_MS, type Holder, judge, lockPath, namedPid } from './worktree/holder.ts'

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

// The Promise entry, for `lntt check tests mutate`, still on Promises: the lock is taken by the
// same Effect as a round's, and goes with the process's exit, its heartbeat a timer of its own.
// A command on Effect holds it with lockWorktree instead.

const beating = new Map<string, NodeJS.Timeout>()
// The locks whose release this process's exit already runs: one listener each.
const onExit = new Set<string>()

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
  if (!onExit.has(lock)) {
    onExit.add(lock)
    process.on('exit', () => releaseLock(gitDir))
  }
  clearInterval(beating.get(lock))
  const timer = setInterval(() => {
    try {
      if (mine(lock)) utimesSync(lock, new Date(), new Date())
    } catch {}
  }, options.heartbeatMs ?? HEARTBEAT_MS)
  timer.unref()
  beating.set(lock, timer)
}
