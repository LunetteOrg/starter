import { assert, describe, it } from '@effect/vitest'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import * as TestClock from 'effect/testing/TestClock'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { acquire, CiLockError, CiProcesses, ciLock, recordGroup, release } from './lock.ts'
import type { Owner } from './lock-rules.ts'

const START = Date.parse('2026-10-21T10:00:00Z')
const DIR = '/cache/lntt'
const PATH = `${DIR}/ci-local.lock`

const other = (fields: Partial<Owner> = {}): Owner => ({
  pid: 2000,
  host: 'here',
  worktree: '/w/other',
  started: new Date(START - 5 * 60_000).toISOString(),
  ...fields,
})

// The lock's world in memory: its files, the processes that run (this one is 1000), the lines it
// logs; the TestClock starts at START.
function world(options: { running?: number[]; groups?: number[] } = {}) {
  const fs = memoryFileSystem({ dirs: [DIR] })
  const running = new Set([1000, ...(options.running ?? [2000])])
  const groups = new Set(options.groups ?? [])
  const lines: string[] = []
  const layer = Layer.mergeAll(fs.layer, CiProcesses.memory({ self: 1000, running, groups }), Git.memory({}))
  const input = { path: PATH, worktree: '/w/me', log: (line: string) => Effect.sync(() => lines.push(line)) }
  const record = () => JSON.parse(fs.text(PATH) ?? 'null') as Owner | null
  return { fs, running, groups, lines, layer, input, record }
}

const at = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.andThen(TestClock.setTime(START), effect)

// Moves the clock until `done`, `step` at a time, at most `times` times.
const advance = Effect.fnUntraced(function* (done: () => boolean, step = 5000, times = 20) {
  for (let i = 0; i < times && !done(); i++) {
    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.millis(step))
  }
})

describe('acquire', () => {
  it.effect('a free lock is taken at once, with the owner record, and nothing left beside it', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        const owner = yield* acquire(w.input)
        assert.deepStrictEqual(owner, {
          pid: 1000,
          host: 'host',
          worktree: '/w/me',
          started: new Date(START).toISOString(),
        })
        assert.deepStrictEqual(w.record(), owner)
        assert.deepStrictEqual(w.lines, [])
        const fs = yield* FileSystem.FileSystem
        assert.deepStrictEqual(yield* fs.readDirectory(DIR), ['ci-local.lock'])
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'a held lock is waited for, naming its holder once, until it is released; started is when it was taken',
    () => {
      const w = world()
      return at(
        Effect.gen(function* () {
          yield* w.fs.put(PATH, JSON.stringify(other()))
          const fiber = yield* Effect.forkChild(acquire(w.input))
          yield* advance(() => false, 5000, 2)
          assert.strictEqual(w.lines.length, 1)
          w.fs.files.delete(PATH)
          yield* advance(() => fiber.pollUnsafe() !== undefined, 5000, 2)
          const owner = yield* Fiber.join(fiber)
          assert.match(
            w.lines[0] as string,
            /^lntt ci: waiting for the ci:local lock held by \/w\/other \(pid 2000 on here, since \d\d:\d\d, 5m ago\) — \/cache\/lntt\/ci-local\.lock$/,
          )
          assert.match(w.lines[1] as string, /took the ci:local lock after 15s of waiting/)
          // The time spent waiting is not counted as hold time.
          assert.strictEqual(owner.started, new Date(START + 15_000).toISOString())
          assert.deepStrictEqual(w.record(), owner)
        }),
      ).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a lock whose owner is no longer running is taken over, said once', () => {
    const w = world({ running: [] })
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, JSON.stringify(other({ host: 'elsewhere' })))
        yield* acquire(w.input)
        assert.strictEqual(w.record()?.pid, 1000)
        assert.strictEqual(w.lines.length, 1)
        assert.match(
          w.lines[0] as string,
          /held by \/w\/other \(pid 2000 on elsewhere, .*which is no longer running: taking it over/,
        )
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('an owner gone while its step still runs is waited for, said once, until the step ends', () => {
    const w = world({ running: [], groups: [4242] })
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, JSON.stringify(other({ group: 4242 })))
        const fiber = yield* Effect.forkChild(acquire(w.input))
        yield* advance(() => false, 5000, 3)
        w.groups.delete(4242)
        yield* advance(() => fiber.pollUnsafe() !== undefined)
        yield* Fiber.join(fiber)
        assert.strictEqual(w.lines.length, 3)
        assert.match(
          w.lines[0] as string,
          /waiting for the ci:local lock held by \/w\/other .*, which is no longer running, but its step \(process group 4242\) still is — /,
        )
        assert.match(w.lines[1] as string, /which is no longer running: taking it over/)
        assert.match(w.lines[2] as string, /took the ci:local lock after/)
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('a holder that becomes an orphan with its step still running is announced again', () => {
    const w = world({ groups: [4242] })
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, JSON.stringify(other({ group: 4242 })))
        const fiber = yield* Effect.forkChild(acquire(w.input))
        yield* advance(() => false, 5000, 2)
        w.running.delete(2000)
        yield* advance(() => false, 5000, 2)
        w.fs.files.delete(PATH)
        yield* advance(() => fiber.pollUnsafe() !== undefined)
        yield* Fiber.join(fiber)
        assert.strictEqual(w.lines.length, 3)
        assert.notMatch(w.lines[0] as string, /still is/)
        assert.match(
          w.lines[1] as string,
          /which is no longer running, but its step \(process group 4242\) still is — /,
        )
        assert.match(w.lines[2] as string, /took the ci:local lock after/)
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('a lock held past the maximum hold time and its grace is taken over, loudly', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, JSON.stringify(other({ started: new Date(START - 123 * 60_000).toISOString() })))
        yield* acquire(w.input)
        assert.strictEqual(w.record()?.pid, 1000)
        assert.match(
          w.lines[0] as string,
          /TAKING OVER the ci:local lock held by \/w\/other .*past the maximum hold time/,
        )
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('an unreadable record is waited on while fresh, silently, and taken over once older than 10 s', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, '')
        const fiber = yield* Effect.forkChild(acquire(w.input))
        yield* advance(() => false, 5000, 2)
        assert.deepStrictEqual(w.lines, [])
        yield* advance(() => fiber.pollUnsafe() !== undefined)
        yield* Fiber.join(fiber)
        assert.match(w.lines[0] as string, /no readable owner record: taking it over/)
        assert.strictEqual(w.record()?.pid, 1000)
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('a record replaced between the verdict and the removal survives', () => {
    const fs = memoryFileSystem({ dirs: [DIR] })
    const lines: string[] = []
    // Another waiter takes the lock over while this one judges the old record.
    const processes = Layer.succeed(CiProcesses)(
      CiProcesses.of({
        self: 1000,
        host: 'host',
        alive: (pid) =>
          Effect.sync(() => {
            if (pid === 2000) fs.files.set(PATH, { text: JSON.stringify(other({ pid: 3000 })), mtime: START })
            return pid !== 2000
          }),
        groupAlive: () => Effect.succeed(false),
      }),
    )
    return at(
      Effect.gen(function* () {
        yield* fs.put(PATH, JSON.stringify(other()))
        const fiber = yield* Effect.forkChild(
          acquire({ path: PATH, worktree: '/w/me', log: (line) => Effect.sync(() => lines.push(line)) }),
        )
        yield* advance(() => lines.length > 0, 10, 10)
        assert.strictEqual(JSON.parse(fs.text(PATH) ?? '{}').pid, 3000)
        fs.files.delete(PATH)
        yield* advance(() => fiber.pollUnsafe() !== undefined)
        yield* Fiber.join(fiber)
        assert.notMatch(lines.join('\n'), /taking it over/)
        assert.match(lines[0] as string, /waiting for the ci:local lock held by \/w\/other \(pid 3000/)
      }),
    ).pipe(Effect.provide(Layer.merge(fs.layer, processes)))
  })

  it.effect('a takeover guard left by a crash is removed after 10 s; a fresh one is waited for', () => {
    const w = world({ running: [] })
    return at(
      Effect.gen(function* () {
        yield* w.fs.put(PATH, JSON.stringify(other()))
        yield* w.fs.put(`${PATH}.takeover`, 'crashed')
        const fiber = yield* Effect.forkChild(acquire(w.input))
        yield* advance(() => false, 50, 4)
        assert.strictEqual(w.record()?.pid, 2000)
        yield* advance(() => fiber.pollUnsafe() !== undefined, 5000)
        yield* Fiber.join(fiber)
        assert.strictEqual(w.record()?.pid, 1000)
        assert.strictEqual(w.fs.text(`${PATH}.takeover`), undefined)
      }),
    ).pipe(Effect.provide(w.layer))
  })
})

describe('release and the step’s group', () => {
  it.effect('release removes only a lock whose record is the one it published', () => {
    const w = world()
    const mine = other({ pid: 1000 })
    return at(
      Effect.gen(function* () {
        for (const record of [other(), { ...mine, started: new Date(START).toISOString() }, { ...mine, pid: 2000 }]) {
          yield* w.fs.put(PATH, JSON.stringify(record))
          assert.strictEqual(yield* release(PATH, mine), true)
          assert.notStrictEqual(w.fs.text(PATH), undefined)
        }
        yield* w.fs.put(PATH, JSON.stringify({ ...mine, group: 12 }))
        yield* release(PATH, mine)
        assert.strictEqual(w.fs.text(PATH), undefined)
        assert.strictEqual(yield* release(PATH, mine), true)
        const fs = yield* FileSystem.FileSystem
        assert.deepStrictEqual(yield* fs.readDirectory(DIR), [])
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('the step’s process group is recorded while the record is still ours, written whole', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        const owner = yield* acquire(w.input)
        yield* recordGroup(PATH, owner, 77)
        assert.deepStrictEqual(w.record(), { ...owner, group: 77 })
        yield* recordGroup(PATH, owner, null)
        assert.deepStrictEqual(w.record(), owner)
        yield* w.fs.put(PATH, JSON.stringify(other()))
        yield* recordGroup(PATH, owner, 78)
        assert.deepStrictEqual(w.record(), other())
        const fs = yield* FileSystem.FileSystem
        assert.deepStrictEqual(yield* fs.readDirectory(DIR), ['ci-local.lock'])
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'a fresh guard held by another run bounds the wait: the group gives up after 200 ms, the release after 2 s',
    () => {
      const w = world()
      return at(
        Effect.gen(function* () {
          const owner = yield* acquire(w.input)
          yield* w.fs.put(`${PATH}.takeover`, 'another run')
          const grouped = yield* Effect.forkChild(recordGroup(PATH, owner, 77))
          yield* advance(() => grouped.pollUnsafe() !== undefined, 10, 30)
          assert.strictEqual(yield* Fiber.join(grouped), false)
          assert.deepStrictEqual(w.record(), owner)
          const released = yield* Effect.forkChild(release(PATH, owner))
          yield* advance(() => released.pollUnsafe() !== undefined, 100, 30)
          assert.strictEqual(yield* Fiber.join(released), false)
          // Left to go stale by its owner's dead pid.
          assert.deepStrictEqual(w.record(), owner)
        }),
      ).pipe(Effect.provide(w.layer))
    },
  )
})

describe('ciLock', () => {
  const machine = (w: ReturnType<typeof world>) =>
    ciLock({ dir: DIR, scope: 'machine', worktree: '/w/me', log: w.input.log })

  it.effect('is a resource of the scope: given back when it closes, interrupted or not', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        const lock = yield* Effect.scoped(
          Effect.gen(function* () {
            const lock = yield* machine(w)
            yield* lock.setGroup(5)
            assert.deepStrictEqual(w.record(), { ...lock.owner, group: 5 })
            return lock
          }),
        )
        assert.strictEqual(lock.path, PATH)
        assert.strictEqual(w.fs.text(PATH), undefined)
        const fiber = yield* Effect.forkChild(Effect.scoped(Effect.andThen(machine(w), Effect.never)))
        yield* advance(() => w.fs.text(PATH) !== undefined, 10, 10)
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(w.fs.text(PATH), undefined)
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('a lock that cannot be given back is one line, and the scope closes all the same', () => {
    const w = world()
    return at(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.scoped(Effect.andThen(machine(w), w.fs.put(`${PATH}.takeover`, 'another run'))),
        )
        yield* advance(() => fiber.pollUnsafe() !== undefined, 100, 30)
        assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
        assert.deepStrictEqual(w.lines, [
          `lntt ci: cannot give the ci:local lock back (the guard stayed taken for 2000 ms) — ${PATH}`,
        ])
      }),
    ).pipe(Effect.provide(w.layer))
  })

  it.effect('the project scope names the lock after the repository’s common dir, shared by its worktrees', () => {
    const w = world()
    const git = Git.memory({ commonDir: Effect.succeed('/r/app/.git') })
    return at(
      Effect.gen(function* () {
        const lock = yield* Effect.scoped(ciLock({ dir: DIR, scope: 'project', worktree: '/w/me', log: w.input.log }))
        assert.match(lock.path, /^\/cache\/lntt\/ci-local-app-[0-9a-f]{12}\.lock$/)
      }),
    ).pipe(Effect.provide(Layer.merge(w.layer, git)))
  })

  it.effect('a lock that cannot be taken is a CiLockError: one line naming the lock and --no-lock', () => {
    const failing = FileSystem.layerNoop({
      makeDirectory: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: 'BadResource',
            module: 'FileSystem',
            method: 'makeDirectory',
            pathOrDescriptor: path,
            cause: new Error(`ENOTDIR: not a directory, mkdir '${path}'`),
          }),
        ),
    })
    const processes = CiProcesses.memory({ self: 1000, running: new Set() })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        Effect.scoped(ciLock({ dir: '/x/file/locks', scope: 'machine', worktree: '/w/me', log: () => Effect.void })),
      )
      assert.instanceOf(error, CiLockError)
      assert.strictEqual(
        error.message,
        "cannot take the ci:local lock (ENOTDIR: not a directory, mkdir '/x/file/locks') — /x/file/locks/ci-local.lock; --no-lock runs without it",
      )
    }).pipe(Effect.provide(Layer.mergeAll(failing, processes, Git.memory({}))))
  })
})
