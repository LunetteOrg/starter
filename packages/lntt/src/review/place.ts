// Where lntt review keeps what a branch carries between rounds (src/review-store.ts names the
// files in it), on Effect (docs/adr/effect-in-lntt.md): the place resolved through Path and
// Digest, the old files of a worktree moved in through FileSystem, the repository read through
// Git, the configuration through ProjectConfig and the operator profile from src/config/load.ts.
//
// The place is, in order: the operator profile's `review.stateDir`, the project's
// `delivery.review.stateDir`, the clone's common git directory (`lntt-review/` in it). A
// configured place is shared by clones, so it holds a folder per repository, `<org>/<repo>`.
//
// `lntt review status` and `cost`, not yet on Effect, run it through runPlace (src/review/host.ts
// loads this module when they need the place).

import * as NodeChildProcessSpawner from '@effect/platform-node-shared/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Digest from 'effect/crypto/Digest'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import { loadOperator, ProjectConfig, ProjectConfigLive } from '../config/load.ts'
import { mainCheckout, slugOf } from '../config/operator.ts'
import { Git, GitLive } from '../git/git.ts'
import { ledgerPathIn, statePathIn } from '../review-store.ts'

export interface PlaceInput {
  // `git rev-parse --path-format=absolute --git-common-dir`
  common: string
  // The main checkout: where a relative project value starts.
  main: string
  // `<org>/<repo>` from the origin URL, when there is one.
  slug: string | undefined
  // The operator profile's review.stateDir, and the project's delivery.review.stateDir.
  operator: unknown
  project: unknown
  home: string
}

export interface Place {
  dir: string
  source: 'the operator profile (review.stateDir)' | 'delivery.review.stateDir' | 'the git common directory'
}

// A stateDir that is not a path, or an operator's that is relative.
export class PlaceInvalid extends Data.TaggedError('PlaceInvalid')<{ message: string }> {}

const given = (value: unknown, where: string) =>
  value === undefined
    ? Effect.succeed(undefined)
    : typeof value === 'string' && value !== ''
      ? Effect.succeed(value)
      : Effect.fail(new PlaceInvalid({ message: `${where} must be a path, not ${JSON.stringify(value)}` }))

export const resolvePlace = Effect.fnUntraced(function* (
  input: PlaceInput,
): Effect.fn.Return<Place, PlaceInvalid, Path.Path | Digest.Digest> {
  const path = yield* Path.Path
  const expand = (value: string) =>
    value === '~' ? input.home : value.startsWith('~/') ? path.join(input.home, value.slice(2)) : value
  const operator = yield* given(input.operator, "the operator profile's review.stateDir")
  const project = yield* given(input.project, 'delivery.review.stateDir')
  let base: string
  let source: Place['source']
  if (operator !== undefined) {
    base = expand(operator)
    if (!path.isAbsolute(base)) {
      return yield* new PlaceInvalid({
        message: `the operator profile's review.stateDir must be an absolute path or start with ~: ${operator}`,
      })
    }
    source = 'the operator profile (review.stateDir)'
  } else if (project !== undefined) {
    base = path.resolve(input.main, expand(project))
    source = 'delivery.review.stateDir'
  } else {
    return { dir: path.join(input.common, 'lntt-review'), source: 'the git common directory' }
  }
  // Outside the clone the repository is part of the key; with no origin, its git directory is.
  // An origin whose org or repo is `.` or `..` would leave the place: the git directory keys it.
  const named = input.slug?.split('/').every((part) => part !== '.' && part !== '..')
  if (named && input.slug) return { dir: path.join(base, input.slug), source }
  const hex = yield* (yield* Digest.Digest).digestHex(Digest.sha1, new TextEncoder().encode(input.common))
  return { dir: path.join(base, 'local', hex.slice(0, 12)), source }
})

// A rename that crosses filesystems: Node's EXDEV, in the cause the platform keeps.
const crossDevice = (error: PlatformError) => (error.cause as { code?: unknown } | undefined)?.code === 'EXDEV'

// A place on another filesystem than the git directory cannot be reached by a rename: the file is
// copied beside its destination, which is then renamed in place, so a copy cut short leaves a
// `.partial` file (never read: it does not end in `.json`) and not a truncated state.
export const move = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs
    .rename(from, to)
    .pipe(
      Effect.catchTag('PlatformError', (error) =>
        crossDevice(error)
          ? fs
              .copyFile(from, `${to}.partial`)
              .pipe(Effect.andThen(fs.rename(`${to}.partial`, to)), Effect.andThen(fs.remove(from)))
          : Effect.fail(error),
      ),
    )
})

// The branch an old file names, or undefined when it cannot be read.
const branchOf = (text: string): string | undefined => {
  try {
    const branch = (JSON.parse(text) as { branch?: unknown } | null)?.branch
    return typeof branch === 'string' && branch !== '' ? branch : undefined
  } catch {
    return undefined
  }
}

// What a worktree kept in its own git directory before the place existed. Each file is read
// once: moved to the file of the branch it names (the newer wins when the place already has
// one), then it is gone from the old name, so the old place is never read again. One that
// cannot be read is set aside with the suffix `.unreadable`. `say` gets one line per file.
export const migrateOld = Effect.fnUntraced(function* (
  gitDir: string,
  dir: string,
  say: (line: string) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const mtime = (file: string) => Effect.map(fs.stat(file), (info) => Option.getOrUndefined(info.mtime)?.getTime() ?? 0)
  for (const [kind, name, target] of [
    ['state', 'lntt-review.json', statePathIn],
    ['ledger', 'lntt-review-ledger.json', ledgerPathIn],
  ] as const) {
    const old = path.join(gitDir, name)
    if (!(yield* fs.exists(old))) continue
    const branch = branchOf(yield* fs.readFileString(old))
    if (branch === undefined) {
      yield* fs.rename(old, `${old}.unreadable`)
      yield* say(`${old} cannot be read: set aside as ${name}.unreadable, not migrated`)
      continue
    }
    const to = target(dir, branch)
    if ((yield* fs.exists(to)) && (yield* mtime(to)) >= (yield* mtime(old))) {
      yield* fs.remove(old)
      yield* say(`the ${kind} of ${branch} in ${old} is older than the one in ${to}: dropped`)
      continue
    }
    yield* fs.makeDirectory(path.dirname(to), { recursive: true })
    yield* move(old, to)
    yield* say(`moved the ${kind} of ${branch} from ${old} to ${to}`)
  }
})

// The place of this clone, from git, the project's configuration and the operator profile under
// `home`; the first look also takes in what this worktree kept in its git directory before the
// place existed, and says what that moved.
export const placeOf = Effect.fnUntraced(function* (home: string) {
  const git = yield* Git
  const common = yield* git.commonDir
  const gitDir = yield* git.gitDir
  const data = yield* (yield* ProjectConfig).data
  const project = (data.delivery as { review?: { stateDir?: unknown } } | undefined)?.review?.stateDir
  const { profile } = yield* loadOperator(home)
  const placed = yield* resolvePlace({
    common,
    main: mainCheckout(common) ?? common,
    slug: slugOf(yield* git.originUrl),
    operator: (profile.review as { stateDir?: unknown } | undefined)?.stateDir,
    project,
    home,
  })
  yield* migrateOld(gitDir, placed.dir, (line) => Console.error(`lntt review: ${line}`))
  return placed
})

const NodeLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

// What placeOf needs, on the machine.
export const PlaceLive = Layer.mergeAll(
  ProjectConfigLive,
  GitLive.pipe(Layer.provide(NodeChildProcessSpawner.layer)),
  Digest.layerWebCrypto,
).pipe(Layer.provideMerge(NodeLive))

// The place for a caller not on Effect: it rejects with the failure, its message what to say.
export const runPlace = (home: string): Promise<Place> =>
  Effect.runPromise(placeOf(home).pipe(Effect.provide(PlaceLive)))
