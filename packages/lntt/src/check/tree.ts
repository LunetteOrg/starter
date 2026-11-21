// The project as `lntt check` reads it: its files and their text, read once through Effect's
// FileSystem, so the checks of the decision logs and of the tests stay plain functions over what
// was read (docs/adr/effect-in-lntt.md: pure logic stays plain). A spec builds one from a record
// with treeOf.

import * as ByteSize from 'effect/ByteSize'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

// A file larger than this is not read: its size is known, its text is not. Far past any file a
// check reads as text (in this repository the largest is a lockfile of a few hundred KB).
export const READ_LIMIT = 16 * 1024 * 1024

// What no check reads as text: images, fonts, archives, media, compiled code. Their size is
// known, their text is not.
export const BINARY =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|jar|class|wasm|node|so|dylib|dll|exe|bin|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|sqlite|db)$/i

export interface Tree {
  // The project's root, absolute.
  readonly root: string
  // The files a check reads, relative to the root: tracked or new and not ignored.
  readonly files: string[]
  // A file's text, null when it is no file, a binary file, or one too large to read.
  text(path: string): string | null
  // A file, read or not.
  isFile(path: string): boolean
  // Its size in bytes, 0 when it is no file.
  size(path: string): number
}

export interface Entry {
  text: string | null
  size: number
}

// A tree from what is known of each file, keyed by its path relative to the root; `files` is the
// project's list, the paths read besides it (a file a command names) are only in `entries`.
export function treeOf(root: string, files: string[], entries: Map<string, Entry>): Tree {
  return {
    root,
    files,
    text: (path) => entries.get(normal(path))?.text ?? null,
    isFile: (path) => entries.has(normal(path)),
    size: (path) => entries.get(normal(path))?.size ?? 0,
  }
}

// A record of texts as a tree: what a spec gives.
export function memoryTree(root: string, texts: Record<string, string>, files = Object.keys(texts).sort()): Tree {
  const entries = new Map(
    Object.entries(texts).map(([path, text]) => [path, { text, size: new TextEncoder().encode(text).length }]),
  )
  return treeOf(root, files, entries)
}

const normal = (path: string) => path.replace(/^\.\//, '')

// Reads `files`, and `also` (paths relative to the root that a command names), into a tree. A
// listed path that is not there (deleted in the working tree) leaves the list; one that is not a
// file (a submodule) stays in it, unread, as does a binary file or one past `limit`. A file that
// is there and cannot be read fails the read: a check never passes on a file it did not read.
export const readTree = Effect.fnUntraced(function* (
  root: string,
  files: string[],
  also: string[] = [],
  limit: number = READ_LIMIT,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = new Map<string, Entry>()
  const there = new Set<string>()
  const read = (file: string) =>
    Effect.gen(function* () {
      const abs = path.join(root, file)
      // Only a path that is not there is left out: any other failure fails the read.
      const info = yield* fs
        .stat(abs)
        .pipe(
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound' ? Effect.succeed(null) : Effect.fail(error),
          ),
        )
      if (info === null) return
      there.add(normal(file))
      if (info.type !== 'File') return
      const size = Number(ByteSize.toBigInt(info.size))
      const text = size > limit || BINARY.test(file) ? null : yield* fs.readFileString(abs)
      entries.set(normal(file), { text, size })
    })
  yield* Effect.forEach([...new Set([...files, ...also])], read, { concurrency: 16, discard: true })
  return treeOf(
    root,
    files.filter((file) => there.has(normal(file))),
    entries,
  )
})
