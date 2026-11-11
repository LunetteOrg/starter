// The worktree's lock on Effect (the rules of who holds it: src/worktree-lock.ts). A command
// holds it with lockWorktree, a resource of its scope: taken atomically, touched by a heartbeat
// fiber of the same scope, and released when the scope closes, whether the command succeeded,
// failed or was interrupted (docs/adr/effect-in-lntt.md).

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import {
  GUARD_MS,
  HEARTBEAT_MS,
  type Holder,
  judge,
  lockedMessage,
  lockPath,
  namedPid,
  visible,
} from '../worktree-lock.ts'

// The processes of the machine as the lock sees them: its own pid, and whether another is running.
export class Pids extends Context.Service<
  Pids,
  { readonly self: number; readonly visible: (pid: number) => Effect.Effect<boolean> }
>()('@lntt/lntt/worktree/lock/Pids') {}

export const PidsLive = Layer.succeed(Pids)(
  Pids.of({ self: process.pid, visible: (pid) => Effect.sync(() => visible(pid)) }),
)

// The lock on Node: its files through Effect's file system, the pids through process.kill.
export const WorktreeLockLive = Layer.mergeAll(NodeFileSystem.layer, PidsLive)

// Another command holds the lock: `holder` is who, null when no holder could be read.
export class LockedError extends Data.TaggedError('LockedError')<{ holder: Holder | null }> {
  get message() {
    return lockedMessage(this.holder)
  }
}

const alreadyExists = (error: PlatformError.PlatformError) =>
  error.reason._tag === 'AlreadyExists' ? Effect.succeed(false) : Effect.fail(error)

// Who holds the lock, null when nobody does or the lock cannot be read.
const holder = Effect.fnUntraced(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem
  const pids = yield* Pids
  const read = yield* Effect.all([fs.readFileString(lock), fs.stat(lock)]).pipe(Effect.option)
  if (Option.isNone(read)) return null
  const [text, info] = read.value
  const now = yield* Clock.currentTimeMillis
  const touched = Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() })
  const pid = namedPid(text)
  const seen = pid === null ? false : yield* pids.visible(pid)
  return judge(text, now - touched, pids.self, seen)
})

// The lock names this process.
const mine = Effect.fnUntraced(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem
  const pids = yield* Pids
  const text = yield* fs.readFileString(lock).pipe(Effect.option)
  return Option.isSome(text) && namedPid(text.value) === pids.self
})

// Removing a dead lock is serialised by a guard file: of two runs that judged the lock dead, the
// second finds it alive again once the first has created its own, and leaves it.
const takeOver = Effect.fnUntraced(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem
  const guard = `${lock}.takeover`
  const guarded = yield* fs
    .writeFileString(guard, '', { flag: 'wx' })
    .pipe(Effect.as(true), Effect.catchTag('PlatformError', alreadyExists))
  if (!guarded) {
    // Removing an old guard is not atomic: two runs that both find it old can remove each
    // other's new one. It takes a crash inside a takeover of a few milliseconds, then two runs
    // starting in the same 10 seconds; the worst case is the race a guard removes.
    const now = yield* Clock.currentTimeMillis
    const info = yield* fs.stat(guard).pipe(Effect.option)
    const touched = Option.flatMap(info, (i) => i.mtime)
    if (Option.isSome(touched) && now - touched.value.getTime() > GUARD_MS)
      yield* fs.remove(guard, { force: true }).pipe(Effect.ignore)
    yield* Effect.sleep(Duration.millis(20))
    return
  }
  yield* Effect.gen(function* () {
    if ((yield* holder(lock)) === null) yield* fs.remove(lock, { force: true })
  }).pipe(Effect.ensuring(fs.remove(guard, { force: true }).pipe(Effect.ignore)))
})

// Takes the lock, created complete by linking a file that already holds the pid and the command,
// so there is no instant with an empty lock, and atomically: of runs started together, one gets
// it. It is not released here: lockWorktree releases it with its scope, acquireLock
// (src/worktree-lock.ts) with the process. `judgedDead` is for tests: it runs between a run
// judging the lock dead and removing it.
export const acquire = Effect.fnUntraced(function* (
  gitDir: string,
  command: string,
  options: { judgedDead?: Effect.Effect<void, never, FileSystem.FileSystem> } = {},
) {
  const fs = yield* FileSystem.FileSystem
  const pids = yield* Pids
  const lock = lockPath(gitDir)
  // The file linked to the lock. A run killed between writing and removing it leaves a few bytes
  // in the git directory, overwritten when its pid comes back; nothing reads it.
  const own = `${lock}.${pids.self}`
  yield* fs.writeFileString(own, `${pids.self} ${command}`)
  return yield* Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const linked = yield* fs.link(own, lock).pipe(Effect.as(true), Effect.catchTag('PlatformError', alreadyExists))
      if (linked) return
      const other = yield* holder(lock)
      if (other !== null) return yield* new LockedError({ holder: other })
      if (options.judgedDead) yield* options.judgedDead
      yield* takeOver(lock)
    }
    return yield* new LockedError({ holder: null })
  }).pipe(Effect.ensuring(fs.remove(own, { force: true }).pipe(Effect.ignore)))
})

// Removes the lock when it still names this process: a lock another command took since is its own.
const release = Effect.fnUntraced(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem
  if (yield* mine(lock)) yield* fs.remove(lock, { force: true })
})

// The holder touches its lock every `heartbeat`, while it still names this process.
const touch = Effect.fnUntraced(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* mine(lock))) return
  const now = yield* Clock.currentTimeMillis
  yield* fs.utimes(lock, now, now)
})

// The worktree's lock as a resource of the current scope: released when the scope closes, the
// heartbeat stopped first. A lock another command holds fails with LockedError.
export const lockWorktree = (
  gitDir: string,
  command: string,
  options: { heartbeat?: Duration.Input; judgedDead?: Effect.Effect<void, never, FileSystem.FileSystem> } = {},
) =>
  Effect.gen(function* () {
    const lock = lockPath(gitDir)
    yield* Effect.acquireRelease(acquire(gitDir, command, options), () => release(lock).pipe(Effect.ignore))
    const every = options.heartbeat ?? Duration.millis(HEARTBEAT_MS)
    yield* Effect.forkScoped(Effect.forever(Effect.sleep(every).pipe(Effect.andThen(touch(lock).pipe(Effect.ignore)))))
  })
