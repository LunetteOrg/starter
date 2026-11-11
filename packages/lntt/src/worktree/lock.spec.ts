import { assert, describe, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'
import * as TestClock from 'effect/testing/TestClock'
import { FRESH_MS, HEARTBEAT_MS, lockPath } from '../worktree-lock.ts'
import { type LockedError, lockWorktree, Pids } from './lock.ts'

const GIT_DIR = '/repo/.git'
const LOCK = lockPath(GIT_DIR)
const SELF = 100
// A process that is running, and one that is gone.
const LIVE = 200
const GONE = 999_999
const OLD = FRESH_MS * 4
const HOUR = 60 * 60 * 1000

const failure = (method: string, path: string, tag: 'AlreadyExists' | 'NotFound') =>
  PlatformError.systemError({ _tag: tag, module: 'FileSystem', method, pathOrDescriptor: path })

// A file system in memory: each file its text and when it was last touched, by the test's clock.
// `linkFails`: every link finds the lock already there, as when other runs keep taking it.
function inMemory(options: { linkFails?: boolean } = {}) {
  const files = new Map<string, { text: string; mtime: number }>()
  const fileSystem = FileSystem.makeNoop({
    readFileString: (path) => {
      const file = files.get(path)
      return file ? Effect.succeed(file.text) : Effect.fail(failure('readFileString', path, 'NotFound'))
    },
    writeFileString: (path, text, options) =>
      Effect.gen(function* () {
        if (options?.flag === 'wx' && files.has(path)) return yield* failure('writeFileString', path, 'AlreadyExists')
        files.set(path, { text, mtime: yield* Clock.currentTimeMillis })
      }),
    stat: (path) => {
      const file = files.get(path)
      if (!file) return Effect.fail(failure('stat', path, 'NotFound'))
      return Effect.succeed({ mtime: Option.some(new Date(file.mtime)) } as FileSystem.File.Info)
    },
    utimes: (path, _atime, mtime) =>
      Effect.suspend(() => {
        const file = files.get(path)
        if (!file) return Effect.fail(failure('utimes', path, 'NotFound'))
        // As Node's fs.utimes: a Date, or a number of seconds.
        file.mtime = mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000
        return Effect.void
      }),
    link: (from, to) =>
      Effect.suspend(() => {
        const file = files.get(from)
        if (!file) return Effect.fail(failure('link', from, 'NotFound'))
        if (files.has(to) || options.linkFails) return Effect.fail(failure('link', to, 'AlreadyExists'))
        files.set(to, { ...file })
        return Effect.void
      }),
    remove: (path, options) =>
      Effect.suspend(() => {
        if (!files.delete(path) && !options?.force) return Effect.fail(failure('remove', path, 'NotFound'))
        return Effect.void
      }),
  })
  const pids = Pids.of({ self: SELF, visible: (pid) => Effect.succeed(pid === LIVE || pid === SELF) })
  // A lock as another run wrote it, last touched `agoMs` ago.
  const held = (text: string, agoMs = 0) =>
    Effect.map(Clock.currentTimeMillis, (now) => void files.set(LOCK, { text, mtime: now - agoMs }))
  const layer = Layer.mergeAll(Layer.succeed(FileSystem.FileSystem)(fileSystem), Layer.succeed(Pids)(pids))
  return { files, held, layer, text: () => files.get(LOCK)?.text }
}

// The message a refusal carries, or `taken` when the lock was taken.
const outcome = <R>(effect: Effect.Effect<void, LockedError | PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.as('taken'),
    Effect.catchTag('LockedError', (error) => Effect.succeed(error.message)),
  )

describe('lockWorktree', () => {
  it.effect('is taken with the pid and the command, and released when its scope closes', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockWorktree(GIT_DIR, 'lntt review')
          assert.strictEqual(fs.text(), `${SELF} lntt review`)
        }),
      )
      assert.strictEqual(fs.text(), undefined)
      assert.deepStrictEqual([...fs.files.keys()], [], 'the file linked to the lock is gone too')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('is released when the command fails', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      const ending = yield* Effect.exit(
        Effect.scoped(lockWorktree(GIT_DIR, 'lntt review').pipe(Effect.andThen(Effect.fail('the round failed')))),
      )
      assert.ok(Exit.isFailure(ending))
      assert.strictEqual(fs.text(), undefined)
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('is released when the command is interrupted, and its heartbeat stops', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      const taken = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          lockWorktree(GIT_DIR, 'lntt review').pipe(
            Effect.andThen(Deferred.succeed(taken, undefined)),
            Effect.andThen(Effect.never),
          ),
        ),
      )
      yield* Deferred.await(taken)
      assert.strictEqual(fs.text(), `${SELF} lntt review`)
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(fs.text(), undefined)
      // A heartbeat still running would fail to touch a lock that is gone: nothing comes back.
      yield* TestClock.adjust(Duration.millis(HEARTBEAT_MS * 3))
      assert.strictEqual(fs.text(), undefined)
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('is refused while a live process holds it, naming its command and pid; the holder keeps it', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      for (const command of ['lntt review', 'lntt check tests mutate']) {
        yield* fs.held(`${LIVE} ${command}`)
        const refused = yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt something')))
        assert.strictEqual(refused, `${command} is already running in this worktree (pid ${LIVE})`)
        assert.strictEqual(fs.text(), `${LIVE} ${command}`)
      }
      assert.deepStrictEqual([...fs.files.keys()], [LOCK], 'the file linked to the lock is gone')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a lock that names no command (an older lntt) is refused as another lntt command', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(String(LIVE))
      const refused = yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review')))
      assert.strictEqual(refused, `another lntt command is already running in this worktree (pid ${LIVE})`)
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a fresh empty lock is held by a command starting; an old one is taken over', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held('', 500)
      const refused = yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review')))
      assert.strictEqual(refused, 'another lntt command is already running in this worktree (pid starting)')
      yield* fs.held('', 3000)
      assert.strictEqual(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), 'taken')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a lock whose process is gone, untouched for a while, is taken over', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(`${GONE} lntt review`, OLD)
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockWorktree(GIT_DIR, 'lntt check tests mutate')
          assert.strictEqual(fs.text(), `${SELF} lntt check tests mutate`)
        }),
      )
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a pid unseen, in a lock touched a moment ago, is a live holder (another pid namespace)', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(`${GONE} lntt review`, 1000)
      const refused = yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt check tests mutate')))
      assert.strictEqual(refused, `lntt review is already running in this worktree (pid ${GONE})`)
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a lock with no valid pid, or naming this very process, is taken over', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      for (const text of ['garbage', `${SELF} lntt review`]) {
        yield* fs.held(text)
        assert.strictEqual(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), 'taken')
      }
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a live pid holds a lock untouched for 11 hours, not one untouched for 13: its pid was reused', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(`${LIVE} lntt review`, 11 * HOUR)
      assert.match(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), /\(pid 200\)/)
      yield* fs.held(`${LIVE} lntt review`, 13 * HOUR)
      assert.strictEqual(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), 'taken')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('the holder touches its lock while it holds it, and never a lock another process took', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* lockWorktree(GIT_DIR, 'lntt review')
          yield* TestClock.adjust(Duration.millis(HEARTBEAT_MS * 4 + 1))
          const now = yield* Clock.currentTimeMillis
          const age = now - (fs.files.get(LOCK)?.mtime ?? 0)
          assert.ok(age >= 0 && age < HEARTBEAT_MS, `the heartbeat refreshed it to now, not ${age} ms from now`)
          yield* fs.held(`${LIVE} lntt review`, OLD)
          const before = fs.files.get(LOCK)?.mtime
          yield* TestClock.adjust(Duration.millis(HEARTBEAT_MS * 2))
          assert.strictEqual(fs.files.get(LOCK)?.mtime, before)
        }),
      )
      assert.strictEqual(fs.text(), `${LIVE} lntt review`, 'the release leaves a lock that names another process')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a lock its holder touched, then left when it died, is taken over once it is no longer fresh', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      const taken = yield* Deferred.make<void>()
      const holder = yield* Effect.forkChild(
        lockWorktree(GIT_DIR, 'lntt review', { heartbeat: Duration.millis(1000) }).pipe(
          Effect.andThen(Deferred.succeed(taken, undefined)),
          Effect.andThen(Effect.never),
          Effect.scoped,
        ),
      )
      yield* Deferred.await(taken)
      yield* TestClock.adjust(Duration.millis(3500))
      assert.strictEqual(fs.files.get(LOCK)?.mtime, 3000, 'touched every second, the option given')
      // The holder dies with its lock in place: the lock now names a pid that is gone.
      const lock = fs.files.get(LOCK)
      yield* Fiber.interrupt(holder)
      fs.files.set(LOCK, { text: `${GONE} lntt review`, mtime: lock?.mtime ?? 0 })
      assert.match(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), /\(pid 999999\)/)
      yield* TestClock.adjust(Duration.millis(FRESH_MS))
      assert.strictEqual(yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review'))), 'taken')
    }).pipe(Effect.provide(fs.layer))
  })

  // #287: two reviews of one worktree ran at once. Taking over a dead lock was unlink then create:
  // a second run that had judged the lock dead, and was about to remove it, removed the one the
  // first run had just created, and both held "the" lock.
  it.effect('a run that judged the lock dead does not remove the live lock another run created since', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(`${GONE} lntt review`, OLD)
      const refused = yield* outcome(
        Effect.scoped(lockWorktree(GIT_DIR, 'lntt review', { judgedDead: fs.held(`${LIVE} lntt review`) })),
      )
      assert.strictEqual(refused, `lntt review is already running in this worktree (pid ${LIVE})`)
      assert.strictEqual(fs.text(), `${LIVE} lntt review`, 'the live lock is still there')
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('gives up after 50 attempts with no holder to name, the file it linked removed', () => {
    const fs = inMemory({ linkFails: true })
    return Effect.gen(function* () {
      yield* fs.held(`${GONE} lntt review`, OLD)
      const refused = yield* outcome(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review')))
      assert.strictEqual(refused, 'another lntt command is already running in this worktree (pid unknown)')
      assert.deepStrictEqual([...fs.files.keys()], [])
    }).pipe(Effect.provide(fs.layer))
  })

  it.effect('a guard a crashed takeover left behind does not block the next one', () => {
    const fs = inMemory()
    return Effect.gen(function* () {
      yield* fs.held(`${GONE} lntt review`, OLD)
      const now = yield* Clock.currentTimeMillis
      fs.files.set(`${LOCK}.takeover`, { text: '', mtime: now - OLD })
      const fiber = yield* Effect.forkChild(Effect.scoped(lockWorktree(GIT_DIR, 'lntt review')))
      // The run that finds the guard waits 20 ms before it tries again.
      yield* TestClock.adjust(Duration.millis(20))
      yield* Fiber.join(fiber)
      assert.strictEqual(fs.files.has(`${LOCK}.takeover`), false)
    }).pipe(Effect.provide(fs.layer))
  })
})
