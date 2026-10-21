// The ci:local lock: one run at a time, so parallel worktrees queue instead of starving
// each other's tests. It is a file in a folder of the machine's cache, holding the owner's
// record (pid, host, worktree, start); a run that finds it taken says whom it waits for,
// and takes it over once the owner is gone, the record never got written, or the owner
// has held it past the maximum hold time.

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type LockScope = 'machine' | 'project'

export interface Owner {
  pid: number
  host: string
  worktree: string
  started: string
}

// A run that holds the lock longer than this is taken to be stuck, and the next waiter
// takes the lock over: a full local CI takes minutes, not hours.
export const MAX_HOLD_MINUTES = 120

// A record is written whole under another name and linked in, so an unreadable one is a
// crash between the two or a file put there by hand; after this long it is stale.
const UNREADABLE_STALE_MS = 10_000

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
  owner: Owner
  now: () => number
  sleep: (ms: number) => Promise<void>
  // Whether a process of this host is running.
  alive: (pid: number) => boolean
  log: (line: string) => void
  // How often a waiter looks at the lock again.
  interval?: number
}

export interface Lock {
  path: string
  release: () => void
}

// The record is written whole under a temporary name, then linked to the lock's: a
// waiter never reads half of it, and a lock that is taken is never overwritten.
function publish(path: string, text: string): boolean {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
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
      !Number.isNaN(Date.parse(owner.started))
    )
      return owner as Owner
  } catch {}
  return null
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

// Why the lock in `text` can be taken over, or null while its owner holds it.
function staleness(text: string, path: string, deps: LockDeps): string | null {
  const owner = parse(text)
  const now = deps.now()
  if (!owner) {
    let modified: number
    try {
      modified = statSync(path).mtimeMs
    } catch {
      return null
    }
    return now - modified > UNREADABLE_STALE_MS
      ? `lntt ci: the ci:local lock has no readable owner record: taking it over — ${path}`
      : null
  }
  if (owner.host === deps.owner.host && !deps.alive(owner.pid)) {
    return `lntt ci: the ci:local lock was held by ${describe(owner, now)}, which is no longer running: taking it over — ${path}`
  }
  if (now - Date.parse(owner.started) > MAX_HOLD_MINUTES * 60_000) {
    return `lntt ci: TAKING OVER the ci:local lock held by ${describe(owner, now)}, past the maximum hold time of ${MAX_HOLD_MINUTES} minutes — ${path}`
  }
  return null
}

// Moves the stale lock aside before deleting it, and deletes it only if it is still the
// record judged stale: two waiters never remove a lock one of them has just taken. A
// record that changed meanwhile is linked back, unless the lock was taken again since.
function removeStale(path: string, text: string): void {
  const aside = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.stale`)
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    if (read(aside) !== text) {
      try {
        linkSync(aside, path)
      } catch {}
    }
  } finally {
    rmSync(aside, { force: true })
  }
}

// Removes the lock if its record is still ours.
export function release(path: string, owner: Owner): void {
  const text = read(path)
  const holder = text === null ? null : parse(text)
  if (holder && holder.pid === owner.pid && holder.started === owner.started) rmSync(path, { force: true })
}

export async function acquire(deps: LockDeps): Promise<Lock> {
  mkdirSync(dirname(deps.path), { recursive: true })
  const record = `${JSON.stringify(deps.owner)}\n`
  const announced = new Set<string>()
  let waitingSince: number | null = null
  for (;;) {
    if (publish(deps.path, record)) {
      if (waitingSince !== null) {
        deps.log(`lntt ci: took the ci:local lock after ${duration(deps.now() - waitingSince)} of waiting`)
      }
      return { path: deps.path, release: () => release(deps.path, deps.owner) }
    }
    const text = read(deps.path)
    if (text === null) continue
    const stale = staleness(text, deps.path, deps)
    if (stale) {
      deps.log(stale)
      removeStale(deps.path, text)
      continue
    }
    const holder = parse(text)
    if (holder && !announced.has(text)) {
      announced.add(text)
      deps.log(`lntt ci: waiting for the ci:local lock held by ${describe(holder, deps.now())} — ${deps.path}`)
    }
    waitingSince ??= deps.now()
    await deps.sleep(deps.interval ?? 5000)
  }
}

// Whether a process of this host is running: EPERM is a process of another user.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// The lock for a run from `worktree`, with the real clock, processes and host.
// $LNTT_CI_LOCK_POLL_MS shortens the wait between looks, for tests.
export function acquireLock(
  worktree: string,
  scope: LockScope,
  log: (line: string) => void,
  env: Record<string, string | undefined> = process.env,
): Promise<Lock> {
  return acquire({
    path: lockPath(lockDir(env), scope, scope === 'project' ? gitCommonDir(worktree) : ''),
    owner: { pid: process.pid, host: hostname(), worktree, started: new Date().toISOString() },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    alive,
    log,
    ...(env.LNTT_CI_LOCK_POLL_MS ? { interval: Number(env.LNTT_CI_LOCK_POLL_MS) } : {}),
  })
}
