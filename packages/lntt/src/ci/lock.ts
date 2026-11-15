// The ci:local lock on Effect: one run at a time, so parallel worktrees queue instead of starving
// each other's tests. Its files through Effect's FileSystem, the time through the Clock, the
// processes through CiProcesses; its rules are plain (src/ci/lock-rules.ts). `ciLock` takes it as
// a resource of the current scope: released when the scope closes, whether the run ended, failed
// or was interrupted. The library's `acquireLock` is the synchronous shell in src/ci/lock-sync.ts.

import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import { Git } from '../git/git.ts'
import {
  failureReason,
  GROUP_WAIT_MS,
  GUARD_STALE_MS,
  held,
  holderKey,
  type LockScope,
  lockFailure,
  lockPath,
  type Owner,
  ours,
  overdue,
  POLL_MS,
  parse,
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

// The processes the lock judges: this one (its pid and its host, for the record), and whether
// another is running or its process group still has a member.
export class CiProcesses extends Context.Service<
  CiProcesses,
  {
    readonly self: number
    readonly host: string
    readonly alive: (pid: number) => Effect.Effect<boolean>
    readonly groupAlive: (group: number) => Effect.Effect<boolean>
  }
>()('@lntt/lntt/ci/lock/CiProcesses') {
  // Processes in memory: this one is `self`; `running` and `groups` are the pids and the groups
  // that still run, which a spec changes as it goes.
  static memory(options: { self: number; host?: string; running: Set<number>; groups?: Set<number> }) {
    return Layer.succeed(CiProcesses)(
      CiProcesses.of({
        self: options.self,
        host: options.host ?? 'host',
        alive: (pid) => Effect.sync(() => options.running.has(pid)),
        groupAlive: (group) => Effect.sync(() => options.groups?.has(group) ?? false),
      }),
    )
  }
}

// The lock could not be taken: one line, naming the lock and --no-lock; `ci local` exits 1 on it.
export class CiLockError extends Data.TaggedError('CiLockError')<{ message: string }> {}

export interface CiLock {
  path: string
  // The record as published: `started` is the moment the lock was taken.
  owner: Owner
  // Records the process group of the step being run (null once it is gone), so a waiter does not
  // take the lock over from a step that outlived its owner. A record that cannot be rewritten
  // leaves the lock to the owner's pid alone.
  setGroup: (group: number | null) => Effect.Effect<void>
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'

const uuid = Effect.sync(() => crypto.randomUUID())

const temporary = (path: string) =>
  Effect.gen(function* () {
    const processes = yield* CiProcesses
    return temporaryName(path, processes.self, yield* uuid)
  })

const reason = (error: PlatformError.PlatformError) => error.reason._tag

// A file's text, null when there is none.
const read = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(path).pipe(
      Effect.map((text): string | null => text),
      Effect.catchTag('PlatformError', (error) =>
        reason(error) === 'NotFound' ? Effect.succeed(null) : Effect.fail(error),
      ),
    ),
  )

// When a file was last written, null when it cannot be told.
const modified = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (at) => at.getTime()))),
      Effect.orElseSucceed(() => null),
    ),
  )

// The record is written whole under a temporary name, then linked to the lock's: a waiter never
// reads half of it, and a lock that is taken is never overwritten.
const publish = Effect.fnUntraced(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const aside = yield* temporary(path)
  return yield* Effect.gen(function* () {
    yield* fs.writeFileString(aside, text)
    return yield* fs.link(aside, path).pipe(
      Effect.as(true),
      Effect.catchTag('PlatformError', (error) =>
        reason(error) === 'AlreadyExists' ? Effect.succeed(false) : Effect.fail(error),
      ),
    )
  }).pipe(Effect.ensuring(fs.remove(aside, { force: true }).pipe(Effect.ignore)))
})

// Removes the guard left by a crash, `seen` its content, if it is still that guard and still old;
// whether it did. Renamed aside first, so that of two waiters that judged it stale only one gets
// it; a fresh guard renamed aside by the other is linked back. While it is aside a third run can
// take the guard: no rename is conditional, so that instant stays open, and the age is checked
// again right before it to keep it rare.
export const removeStaleGuard = Effect.fnUntraced(function* (guard: string, seen: string) {
  const fs = yield* FileSystem.FileSystem
  const old = (path: string) =>
    Effect.flatMap(Effect.all([Clock.currentTimeMillis, modified(path)]), ([now, at]) =>
      Effect.succeed(at !== null && now - at > GUARD_STALE_MS),
    )
  const aside = yield* temporary(guard)
  if (!(yield* old(guard))) return false
  const moved = yield* fs.rename(guard, aside).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
  if (!moved) return false
  return yield* Effect.gen(function* () {
    const stale = (yield* read(aside).pipe(Effect.orElseSucceed(() => null))) === seen && (yield* old(aside))
    if (!stale) yield* fs.link(aside, guard).pipe(Effect.ignore)
    return stale
  }).pipe(Effect.ensuring(fs.remove(aside, { force: true }).pipe(Effect.ignore)))
})

// The takeover guard: every change to a published lock (a stale one removed, a release, a new
// process group recorded) happens under it, so none of them acts on a record another run has just
// replaced. Gives its release, or null while another run holds it; a guard left by a crash is
// removed, and the next attempt takes it.
const takeGuard = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const guard = `${path}.takeover`
  const token = yield* uuid
  const taken = yield* fs.writeFileString(guard, token, { flag: 'wx' }).pipe(
    Effect.as(true),
    Effect.catchTag('PlatformError', (error) =>
      reason(error) === 'AlreadyExists' ? Effect.succeed(false) : Effect.fail(error),
    ),
  )
  if (taken) {
    return Option.some(
      Effect.gen(function* () {
        if ((yield* read(guard)) === token) yield* fs.remove(guard, { force: true })
      }).pipe(Effect.ignore),
    )
  }
  yield* Effect.gen(function* () {
    const seen = yield* read(guard)
    const at = yield* modified(guard)
    if (seen !== null && at !== null && (yield* Clock.currentTimeMillis) - at > GUARD_STALE_MS)
      yield* removeStaleGuard(guard, seen)
  }).pipe(Effect.ignore)
  return Option.none<Effect.Effect<void>>()
})

// A change under the guard: waits for it in short steps, up to `waitMs`, then gives up without
// making the change; whether it made it.
const withGuard = Effect.fnUntraced(function* <E, R>(path: string, waitMs: number, change: Effect.Effect<void, E, R>) {
  const until = (yield* Clock.currentTimeMillis) + waitMs
  let free = yield* takeGuard(path)
  while (Option.isNone(free)) {
    if ((yield* Clock.currentTimeMillis) >= until) return false
    yield* Effect.sleep(Duration.millis(10))
    free = yield* takeGuard(path)
  }
  yield* change.pipe(Effect.ensuring(free.value))
  return true
})

const current = (path: string) => Effect.map(read(path), (text) => (text === null ? null : parse(text)))

// Removes the lock if its record is still the one `owner` published; false when the guard stayed
// taken for `waitMs`.
export const release = (path: string, owner: Owner, waitMs = RELEASE_WAIT_MS) =>
  withGuard(
    path,
    waitMs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (ours(yield* current(path), owner)) yield* fs.remove(path, { force: true })
    }),
  )

// Rewrites the record with the step's process group, while it is still the one `owner` published:
// written whole under another name, then renamed over the lock.
export const recordGroup = (path: string, owner: Owner, group: number | null, waitMs = GROUP_WAIT_MS) =>
  withGuard(
    path,
    waitMs,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if (!ours(yield* current(path), owner)) return
      const aside = yield* temporary(path)
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(aside, record(withGroup(owner, group)))
        yield* fs.rename(aside, path)
      }).pipe(Effect.ensuring(fs.remove(aside, { force: true }).pipe(Effect.ignore)))
    }),
  )

const judge = Effect.fnUntraced(function* (text: string, path: string) {
  const processes = yield* CiProcesses
  const owner = parse(text)
  const now = yield* Clock.currentTimeMillis
  if (!owner) return unreadable(path, now, yield* modified(path))
  const late = overdue(path, owner, now)
  if (late) return late
  const alive = yield* processes.alive(owner.pid)
  const group = !alive && owner.group !== undefined ? yield* processes.groupAlive(owner.group) : false
  return held(path, owner, now, alive, group) satisfies Verdict
})

// Removes the stale lock under the takeover guard, and only if it is still the record judged
// stale: a lock another run took meanwhile stays ('changed'). 'busy' while another run holds the
// guard.
const removeStale = Effect.fnUntraced(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const free = yield* takeGuard(path)
  if (Option.isNone(free)) return 'busy' as const
  return yield* Effect.gen(function* () {
    if ((yield* read(path)) !== text) return 'changed' as const
    yield* fs.remove(path, { force: true })
    return 'removed' as const
  }).pipe(Effect.ensuring(free.value))
})

export interface LockInput {
  path: string
  worktree: string
  log: (line: string) => Effect.Effect<void>
  // How often a waiter looks at the lock again (default 5 s).
  interval?: number
}

// Takes the lock, waiting for its holder as long as it runs; not released here (ciLock releases it
// with its scope).
export const acquire = Effect.fnUntraced(function* (input: LockInput) {
  const fs = yield* FileSystem.FileSystem
  const processes = yield* CiProcesses
  yield* fs.makeDirectory(parentOf(input.path), { recursive: true })
  const announced = new Set<string>()
  const interval = input.interval ?? POLL_MS
  const pause = Duration.millis(Math.min(interval, SHORT_PAUSE_MS))
  let waitingSince: number | null = null
  for (;;) {
    const now = yield* Clock.currentTimeMillis
    const owner: Owner = {
      pid: processes.self,
      host: processes.host,
      worktree: input.worktree,
      started: new Date(now).toISOString(),
    }
    if (yield* publish(input.path, record(owner))) {
      if (waitingSince !== null) yield* input.log(tookLine(now - waitingSince))
      return owner
    }
    const text = yield* read(input.path)
    if (text === null) {
      // Released between the attempt and the read: the next attempt likely takes it.
      yield* Effect.sleep(pause)
      continue
    }
    const verdict = yield* judge(text, input.path)
    if ('stale' in verdict) {
      const removal = yield* removeStale(input.path, text)
      if (removal === 'removed') yield* input.log(verdict.stale)
      if (removal === 'busy') yield* Effect.sleep(pause)
      continue
    }
    if ('owner' in verdict) {
      const key = holderKey(verdict.owner, verdict.orphan)
      if (!announced.has(key)) {
        announced.add(key)
        yield* input.log(waitingLine(input.path, verdict.owner, verdict.orphan, yield* Clock.currentTimeMillis))
      }
    }
    waitingSince ??= yield* Clock.currentTimeMillis
    yield* Effect.sleep(Duration.millis(interval))
  }
})

// Where the lock of `scope` is, in the lock folder `dir`: the project scope asks git for the
// repository's common dir.
export const lockFile = Effect.fnUntraced(function* (dir: string, scope: LockScope) {
  if (scope === 'machine') return lockPath(dir, scope, '', '')
  const commonDir = yield* Effect.flatMap(Git, (git) => git.commonDir)
  const digest = yield* Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(commonDir)))
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return lockPath(dir, scope, commonDir, hash)
})

// The lock as a resource of the current scope. A lock that cannot be taken is a CiLockError; one
// that cannot be given back is one line, and the run's outcome stands: its record goes stale by
// the dead pid.
export const ciLock = (input: Omit<LockInput, 'path'> & { dir: string; scope: LockScope }) =>
  Effect.gen(function* () {
    const path = yield* lockFile(input.dir, input.scope).pipe(
      Effect.mapError((error) => new CiLockError({ message: lockFailure(error, input.dir) })),
    )
    const services = yield* Effect.context<FileSystem.FileSystem | CiProcesses>()
    const owner = yield* Effect.acquireRelease(
      acquire({ ...input, path }).pipe(
        Effect.mapError((error) => new CiLockError({ message: lockFailure(error, path) })),
      ),
      (owner) =>
        release(path, owner).pipe(
          Effect.map((done) => (done ? null : `the guard stayed taken for ${RELEASE_WAIT_MS} ms`)),
          Effect.catch((error) => Effect.succeed(failureReason(error))),
          Effect.flatMap((reason) =>
            reason === null
              ? Effect.void
              : input.log(`lntt ci: cannot give the ci:local lock back (${reason}) — ${path}`),
          ),
        ),
    )
    return {
      path,
      owner,
      setGroup: (group) => recordGroup(path, owner, group).pipe(Effect.ignore, Effect.provideContext(services)),
    } satisfies CiLock
  })
