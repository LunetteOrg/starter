// The references of a text with their titles, on Effect (docs/adr/effect-in-lntt.md): the
// session's repository and each issue's title from gh (Gh), the git directory and the remotes
// from git (Git), the cache through the FileSystem, its times from the Clock. Each git and gh call
// may take GH_TIMEOUT_MS: past it, it counts as failed, and its process is stopped. The mentions
// and the cache's text are plain logic (src/refs.ts).

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcessSpawner } from 'effect/process'
import * as Random from 'effect/Random'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Gh, ghAt } from '../gh/gh.ts'
import { Git, gitAt } from '../git/git.ts'
import {
  CACHE_FILE,
  type Cache,
  entry,
  GH_TIMEOUT_MS,
  LOOKUPS_AT_ONCE,
  mentions,
  mergedCache,
  parseCache,
  type Refs,
  type RefsRun,
  type Resolved,
  repositoryKey,
  type Why,
  whyRefused,
} from '../refs.ts'

// A git or gh call, held to the timeout: None past it.
const timed = <A, E, R>(call: Effect.Effect<A, E, R>) => Effect.timeoutOption(call, GH_TIMEOUT_MS)

// The sha256 of a text, in hexadecimal: what the cache keeps of the remotes.
const digest = (text: string) =>
  Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).pipe(
    Effect.map((hash) => [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')),
  )

// The worktree's git directory, null outside a repository or when git does not answer.
const gitDir = Effect.flatMap(Git, (git) => timed(git.gitDir)).pipe(
  Effect.map((dir) => (dir._tag === 'Some' && dir.value.trim() !== '' ? dir.value.trim() : null)),
  Effect.orElseSucceed(() => null),
)

// The remotes gh resolves the repository from: '' when there is none, null when git does not
// answer. A cached repository holds for as long as they read the same (a fork, `gh repo
// set-default`, a changed URL all change them).
const remotes = Effect.flatMap(Git, (git) => timed(git.remotes)).pipe(
  Effect.map((read) => (read._tag === 'Some' ? read.value : null)),
  Effect.orElseSucceed(() => null),
)

// The session's repository as gh resolves `#N`: null when gh is missing, not logged in, finds no
// GitHub remote, does not answer in time or answers anything but owner/repo.
const repositoryOf = Effect.flatMap(Gh, (gh) => timed(gh.repository)).pipe(
  Effect.map((name) => (name._tag === 'Some' ? repositoryKey(name.value) : null)),
  Effect.orElseSucceed(() => null),
)

// One reference's title and URL, or why it has none: gh missing is off, a timeout failed, a
// refusal by what gh said (whyRefused), an answer not safe to show unknown.
const lookUp = (key: string) => {
  const [, repo, n] = key.match(/^(.+)#(\d+)$/) as string[]
  return Effect.flatMap(Gh, (gh) => timed(gh.issueLink({ repo: repo as string, number: Number(n) }))).pipe(
    Effect.map((answer): { title: string; url: string } | Why =>
      answer._tag === 'None' ? 'failed' : (entry(answer.value.title, answer.value.url) ?? 'unknown'),
    ),
    Effect.catchTag('GhError', (error) => Effect.succeed<Why>(error.missing ? 'off' : whyRefused(error.output))),
  )
}

const none = (ref: string, why: Why): Resolved => ({ ref, title: null, url: null, why })

// What the file holds, null when it cannot be read.
const readFile = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orElseSucceed(() => null))

// What was found, merged with what the file holds just before it is replaced, through a
// temporary file renamed over the cache, so two calls at once never leave a torn file. With no
// lock, a call that writes between another's read and rename can lose its entries: they are only
// asked again. A write that fails is ignored the same way, and its temporary file removed.
const writeCache = Effect.fnUntraced(function* (file: string, found: Cache, now: number) {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${file}.${(yield* Random.nextIntBetween(0, 2 ** 31)).toString(36)}.tmp`
  const text = mergedCache(yield* readFile(file), found, now)
  yield* fs.writeFileString(temporary, text).pipe(
    Effect.andThen(fs.rename(temporary, file)),
    Effect.catch(() => Effect.ignore(fs.remove(temporary, { force: true }))),
  )
})

// The references of a text with their titles. Without the session's repository (outside a git
// repository, gh failing) nothing is looked up and no cached title is read. `cached`: no issue is
// asked of gh, only the cache is read. `now`: the time entries are kept with, the Clock's.
export const resolveRefs = Effect.fnUntraced(function* (
  text: string,
  { cached = false, now = Clock.currentTimeMillis }: { cached?: boolean; now?: Effect.Effect<number> } = {},
) {
  const dir = yield* gitDir
  const file = dir && `${dir}/${CACHE_FILE}`
  const cache = file ? parseCache(yield* readFile(file), yield* now) : null
  const found: Cache = { repository: null, entries: new Map() }
  const read = cache ? yield* remotes : null
  const remotesDigest = read === null ? null : yield* digest(read)
  // A cached repository holds only with remotes read now: git failing (null) matches none.
  let repository = cache?.repository && cache.repository.remotes === remotesDigest ? cache.repository.name : null
  if (cache && !repository) {
    repository = yield* repositoryOf
    if (repository && remotesDigest !== null) {
      found.repository = { name: repository, at: yield* now, remotes: remotesDigest }
    }
  }
  const all = mentions(text, repository)
  const keys = [...new Set(all.flatMap((m) => (m.ref ? [m.ref] : [])))]
  let refs: Resolved[]
  if (!cache || !repository) refs = keys.map((k) => none(k, 'off'))
  else {
    refs = yield* Effect.forEach(
      keys,
      (k) =>
        Effect.gen(function* () {
          const hit = cache.entries.get(k)
          if (hit) return { ref: k, title: hit.title, url: hit.url } satisfies Resolved
          if (cached) return none(k, 'cached')
          const answer = yield* lookUp(k)
          if (typeof answer === 'string') return none(k, answer)
          found.entries.set(k, { ...answer, at: yield* now })
          return { ref: k, ...answer } satisfies Resolved
        }),
      { concurrency: LOOKUPS_AT_ONCE },
    )
  }
  if (file && (found.repository || found.entries.size)) yield* writeCache(file, found, yield* now)
  return { repository, mentions: all, refs } satisfies Refs
})

const encode = (text: string) => new TextEncoder().encode(text)

// Effect's ChildProcessSpawner over a RefsRun, which runs a command to its end with the timeout:
// its answer is the process's output and exit code; a command missing (`code` ENOENT) is the
// spawner's NotFound, any other rejection (a timeout) a failure to run.
export function spawnerOver(run: RefsRun) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const name = command.command
      const answer = yield* Effect.tryPromise({
        try: () => run(name, command.args.map(String), GH_TIMEOUT_MS),
        catch: (cause) =>
          PlatformError.systemError({
            _tag: (cause as { code?: unknown })?.code === 'ENOENT' ? 'NotFound' : 'Unknown',
            module: 'ChildProcess',
            method: 'spawn',
            pathOrDescriptor: name,
            description: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(answer.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(answer.stdout)),
        stderr: Stream.make(encode(answer.stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )
}

// git and gh through a RefsRun, the cache on this machine's file system: what the library's
// resolveRefs runs on.
export const overRun = (run: RefsRun) =>
  Layer.mergeAll(gitAt(), ghAt(), NodeFileSystem.layer).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawnerOver(run))),
  )
