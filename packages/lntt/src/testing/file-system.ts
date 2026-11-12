// Effect's FileSystem in memory, for the specs of lntt (docs/adr/effect-in-lntt.md#tests-beside-each-module).
// It follows Node's semantics where a module relies on them, so a spec fails where Node would:
// a file is written only in a directory that exists, `wx` refuses a file that exists, `a`
// appends, `link` refuses a target that exists, `utimes` reads a number as seconds, `rename`
// across two filesystems fails with Node's EXDEV in its cause, and a missing path is NotFound. A file's mtime is the Clock's time when it was written. Not
// published: tsconfig.build.json leaves src/testing/ out.

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as PlatformError from 'effect/PlatformError'

export interface MemoryFile {
  text: string
  mtime: number
}

const failure = (
  method: string,
  path: string,
  tag: 'AlreadyExists' | 'NotFound' | 'PermissionDenied' | 'Unknown',
  cause?: unknown,
) => PlatformError.systemError({ _tag: tag, module: 'FileSystem', method, pathOrDescriptor: path, cause })

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'

// `dirs`: the directories that exist from the start, with their ancestors. `linkFails`: every
// link finds its target already there, as when other runs keep taking a lock. `devices`: the
// directories mounted on a filesystem of their own, which a rename cannot cross. `unreadable`: the
// directories that cannot be searched, where `exists` fails with PermissionDenied (only `exists`:
// the other operations read the files as they are).
export function memoryFileSystem(
  options: { dirs?: string[]; linkFails?: boolean; devices?: string[]; unreadable?: string[] } = {},
) {
  const files = new Map<string, MemoryFile>()
  const dirs = new Set<string>(['/'])
  const links = { count: 0 }
  const makeDir = (path: string) => {
    for (let at = path; at !== '/' && at !== ''; at = parent(at)) dirs.add(at)
  }
  for (const dir of options.dirs ?? []) makeDir(dir)

  const device = (path: string) =>
    (options.devices ?? []).find((dir) => path === dir || path.startsWith(`${dir}/`)) ?? '/'
  const copy = (method: string, from: string, to: string) =>
    Effect.suspend(() => {
      const file = files.get(from)
      if (!file) return Effect.fail(failure(method, from, 'NotFound'))
      if (!dirs.has(parent(to))) return Effect.fail(failure(method, to, 'NotFound'))
      files.set(to, { ...file })
      return Effect.void
    })

  const write = (method: string, path: string, text: string, flag: string | undefined) =>
    Effect.gen(function* () {
      if (!dirs.has(parent(path))) return yield* failure(method, path, 'NotFound')
      const now = yield* Clock.currentTimeMillis
      const file = files.get(path)
      if (flag === 'wx' && file) return yield* failure(method, path, 'AlreadyExists')
      files.set(path, { text: flag === 'a' && file ? file.text + text : text, mtime: now })
    })

  const fileSystem = FileSystem.makeNoop({
    exists: (path) =>
      (options.unreadable ?? []).some((dir) => path.startsWith(`${dir}/`))
        ? Effect.fail(failure('exists', path, 'PermissionDenied'))
        : Effect.sync(() => files.has(path) || dirs.has(path)),
    makeDirectory: (path, options) =>
      Effect.suspend(() => {
        if (!options?.recursive && !dirs.has(parent(path)))
          return Effect.fail(failure('makeDirectory', path, 'NotFound'))
        makeDir(path)
        return Effect.void
      }),
    readFileString: (path) => {
      const file = files.get(path)
      return file ? Effect.succeed(file.text) : Effect.fail(failure('readFileString', path, 'NotFound'))
    },
    writeFileString: (path, text, options) => write('writeFileString', path, text, options?.flag),
    stat: (path) => {
      const file = files.get(path)
      if (!file && dirs.has(path))
        return Effect.succeed({ type: 'Directory', mtime: Option.none() } as FileSystem.File.Info)
      if (!file) return Effect.fail(failure('stat', path, 'NotFound'))
      return Effect.succeed({ type: 'File', mtime: Option.some(new Date(file.mtime)) } as FileSystem.File.Info)
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
        links.count++
        const file = files.get(from)
        if (!file) return Effect.fail(failure('link', from, 'NotFound'))
        if (files.has(to) || options.linkFails) return Effect.fail(failure('link', to, 'AlreadyExists'))
        files.set(to, { ...file })
        return Effect.void
      }),
    copyFile: (from, to) => copy('copyFile', from, to),
    // As Node's fs.rename: a file only, within one filesystem.
    rename: (from, to) =>
      device(from) === device(to)
        ? copy('rename', from, to).pipe(Effect.andThen(Effect.sync(() => files.delete(from))))
        : Effect.fail(
            failure(
              'rename',
              from,
              'Unknown',
              Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }),
            ),
          ),
    remove: (path, options) =>
      Effect.suspend(() => {
        if (!files.delete(path) && !options?.force) return Effect.fail(failure('remove', path, 'NotFound'))
        return Effect.void
      }),
  })

  return {
    files,
    links,
    layer: Layer.succeed(FileSystem.FileSystem)(fileSystem),
    // A file as another process wrote it, last touched `agoMs` before the Clock's time; its
    // directories are created.
    put: (path: string, text: string, agoMs = 0) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        makeDir(parent(path))
        files.set(path, { text, mtime: now - agoMs })
      }),
    text: (path: string) => files.get(path)?.text,
  }
}
