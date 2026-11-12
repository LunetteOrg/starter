// The review state store as a service (docs/adr/effect-in-lntt.md#services): a branch's state and
// its ledger of closed findings, kept between rounds in the place src/review-store.ts names, and
// the progress file of the running command, in the worktree's git directory. All of it through
// Effect's FileSystem and Clock: the live layer and the in-memory one share the implementation
// and differ in the file system they are given and in how the place is found.

import * as Clock from 'effect/Clock'
import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type * as PlatformError from 'effect/PlatformError'
import * as Ref from 'effect/Ref'
import { Git, type GitError } from '../git/git.ts'
import type { Closed, Ledger, ReviewState } from '../review.ts'
import { ledgerPathIn, parseLedger, parseState, statePathIn } from '../review-store.ts'
import { ReviewBridge, ReviewFailed } from './bridge.ts'

// What reading or writing the store can end with: the place not found, a file the platform
// refused, a state file that cannot be read.
export type StoreError = ReviewFailed | GitError | PlatformError.PlatformError

export interface Store {
  readonly readState: (branch: string) => Effect.Effect<ReviewState | null, StoreError>
  readonly writeState: (state: ReviewState) => Effect.Effect<void, StoreError>
  // The branch's closed findings; a ledger that cannot be read is said, and is none.
  readonly readLedger: (branch: string) => Effect.Effect<Closed[], StoreError>
  // The same, unsaid: what a summary shows.
  readonly closed: (branch: string) => Effect.Effect<Closed[], StoreError>
  readonly writeLedger: (branch: string, closed: Closed[]) => Effect.Effect<void, StoreError>
  // The command starts its own progress file, before anything that can stop it, so an error is
  // never read as the end of the round before. Once started, emit appends one JSON event per
  // line, with its time; neither ever fails, and emit writes nothing before a start.
  readonly startProgress: Effect.Effect<void>
  readonly started: Effect.Effect<boolean>
  readonly emit: (event: Record<string, unknown>) => Effect.Effect<void>
}

export class ReviewStore extends Context.Service<ReviewStore, Store>()('@lntt/lntt/review/store/ReviewStore') {
  // The store over the file system the spec gives: its place `dir`, the progress in `gitDir`.
  static memory(dir: string, gitDir: string) {
    return Layer.effect(ReviewStore)(makeStore({ dir: Effect.succeed(dir), gitDir: Effect.succeed(gitDir) }))
  }
}

const parent = (path: string) => path.slice(0, path.lastIndexOf('/'))

// The store over Effect's FileSystem, its place and git directory found once, on first use.
export const makeStore = Effect.fnUntraced(function* <E extends StoreError>(where: {
  dir: Effect.Effect<string, E>
  gitDir: Effect.Effect<string, E>
}) {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* Effect.cached(where.dir)
  const gitDir = yield* Effect.cached(where.gitDir)
  const progress = yield* Ref.make<string | null>(null)

  const read = (path: string) =>
    Effect.flatMap(fs.exists(path), (there) =>
      there ? Effect.map(fs.readFileString(path), String) : Effect.succeed(null),
    )
  const write = (path: string, value: unknown) =>
    fs
      .makeDirectory(parent(path), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path, `${JSON.stringify(value, null, 2)}\n`)))
  const ledger = Effect.fnUntraced(function* (branch: string) {
    const path = ledgerPathIn(yield* dir, branch)
    const text = yield* read(path)
    return { path, closed: text === null ? [] : parseLedger(text, branch) }
  })

  return ReviewStore.of({
    readState: Effect.fnUntraced(function* (branch) {
      const path = statePathIn(yield* dir, branch)
      const text = yield* read(path)
      if (text === null) return null
      return yield* Effect.try({
        try: () => parseState(text, path, branch),
        catch: (cause) => new ReviewFailed({ cause }),
      })
    }),
    writeState: (state) => Effect.flatMap(dir, (at) => write(statePathIn(at, state.branch), state)),
    readLedger: Effect.fnUntraced(function* (branch) {
      const { path, closed } = yield* ledger(branch)
      if (closed !== null) return closed
      yield* Console.error(`lntt review: ${path} cannot be read: the branch starts a new ledger`)
      return []
    }),
    closed: (branch) => Effect.map(ledger(branch), ({ closed }) => closed ?? []),
    writeLedger: (branch, closed) =>
      Effect.flatMap(dir, (at) => write(ledgerPathIn(at, branch), { branch, closed } satisfies Ledger)),
    startProgress: Effect.gen(function* () {
      const path = `${yield* gitDir}/lntt-review.progress`
      yield* fs.writeFileString(path, '')
      yield* Ref.set(progress, path)
    }).pipe(Effect.catch(() => Ref.set(progress, null))),
    started: Effect.map(Ref.get(progress), (path) => path !== null),
    emit: (event) =>
      Effect.gen(function* () {
        const path = yield* Ref.get(progress)
        if (path === null) return
        const t = yield* Clock.currentTimeMillis
        yield* fs.writeFileString(path, `${JSON.stringify({ t, ...event })}\n`, { flag: 'a' })
      }).pipe(Effect.ignore),
  })
})

// The store on the machine: the place the operator, the project or the clone names, found from git
// and the project's configuration through the bridge.
export const ReviewStoreLive = Layer.effect(ReviewStore)(
  Effect.gen(function* () {
    const git = yield* Git
    const bridge = yield* ReviewBridge
    return yield* makeStore({
      dir: Effect.gen(function* () {
        const common = yield* git.commonDir
        const data = yield* bridge.config
        return yield* bridge.place(common, yield* git.gitDir, data)
      }),
      gitDir: git.gitDir,
    })
  }),
)
