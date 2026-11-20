// What `lntt dump` and `lntt issue` read from the machine for a report, on Effect
// (docs/adr/effect-in-lntt.md): the project's files through the FileSystem, git's remotes, the
// harness's version and the failing command through the spawner, lntt's own package from
// PackageDir. What the dump says is plain (src/dump.ts).

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import { captured } from '../captured.ts'
import { loadConfig } from '../config/load.ts'
import {
  type DumpFacts,
  dumpOf,
  type FailedCommand,
  harnessCommand,
  LEFTHOOKS,
  LOCKS,
  lnttPackages,
  OUTPUT_LIMIT,
  OUTPUT_STOPPED,
  type ProjectFacts,
  redactionOf,
  remotesIn,
  stoppedAfter,
  versionIn,
} from '../dump.ts'
import { PackageDir } from '../sync/project.ts'

type Env = Record<string, string | undefined>

// What a report reads from the session, at the edge: Node's version, the OS, the operator's home.
export interface Machine {
  node: string
  os: string
  home: string
}

// A file's text, null when it is no file.
const textOf = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(file).pipe(Effect.option)
  if (info._tag === 'None' || info.value.type !== 'File') return null
  return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => null))
})

// A JSON file's object, null when it is no file or not JSON.
const jsonOf = Effect.fnUntraced(function* (file: string) {
  const text = yield* textOf(file)
  if (text === null) return null
  try {
    const data = JSON.parse(text) as unknown
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
})

// The directory of lntt's package.json, above its code (src/ in this repository, dist/src/ once
// packed), and its version.
export const lnttPackage = Effect.gen(function* () {
  const path = yield* Path.Path
  for (let dir = yield* PackageDir; ; dir = path.dirname(dir)) {
    const pkg = yield* jsonOf(path.join(dir, 'package.json'))
    if (pkg?.name === '@lntt/lntt') return { dir, version: typeof pkg.version === 'string' ? pkg.version : 'unknown' }
    if (path.dirname(dir) === dir)
      return yield* Effect.die(new Error('the package.json of @lntt/lntt is not above its code'))
  }
})

// `<command> --version`, its version; null when it does not run, or not within five seconds.
const versionOf = Effect.fnUntraced(function* (command: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const said = yield* captured(spawner, command, ['--version']).pipe(
    Effect.timeoutOption(Duration.seconds(5)),
    Effect.orElseSucceed(() => ({ _tag: 'None' }) as const),
  )
  if (said._tag === 'None' || said.value.code !== 0) return null
  return versionIn(said.value.out)
})

// The git remotes of the project at `root`; none when git cannot tell.
const remotesOf = Effect.fnUntraced(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const said = yield* captured(spawner, 'git', ['remote', '-v'], root).pipe(Effect.option)
  return said._tag === 'Some' && said.value.code === 0 ? remotesIn(said.value.out) : []
})

// The folders of a directory, sorted; none when it is no directory.
const foldersOf = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]))
  const folders: string[] = []
  for (const name of names) {
    const info = yield* fs.stat(path.join(dir, name)).pipe(Effect.option)
    if (info._tag === 'Some' && info.value.type === 'Directory') folders.push(name)
  }
  return folders.sort()
})

const projectFacts = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pkg = yield* jsonOf(path.join(root, 'package.json'))
  const locks: string[] = []
  for (const [file] of LOCKS) if (yield* fs.exists(path.join(root, file))) locks.push(file)
  const skills: ProjectFacts['skills'] = []
  for (const dir of ['.agents/skills', '.claude/skills'])
    skills.push({ dir, names: yield* foldersOf(path.join(root, dir)) })
  let lefthook: string | null = null
  for (const file of LEFTHOOKS) {
    lefthook = yield* textOf(path.join(root, file))
    if (lefthook !== null) break
  }
  const installed: Record<string, string | null> = {}
  for (const name of Object.keys(lnttPackages(pkg))) {
    const version = (yield* jsonOf(path.join(root, 'node_modules', name, 'package.json')))?.version
    installed[name] = typeof version === 'string' ? version : null
  }
  const config = yield* loadConfig(root).pipe(
    Effect.map((loaded): ProjectFacts['config'] => ({ path: loaded.path, data: loaded.data })),
    Effect.catchTags({
      NoConfig: (error) => Effect.succeed({ none: error.message }),
      ConfigInvalid: (error) => Effect.succeed({ invalid: error.message }),
      PlatformError: (error) => Effect.succeed({ invalid: error.message }),
    }),
  )
  return {
    pkg,
    locks,
    skills,
    lefthook,
    claude: yield* jsonOf(path.join(root, '.claude/settings.json')),
    installed,
    config,
  } satisfies ProjectFacts
})

// Runs the failing command as its words are given, stderr merged into stdout by sh in the order
// they were written; `exec` makes the command take the shell's place. It is stopped after
// `timeoutMs` (default 10 minutes), or once its output passes OUTPUT_LIMIT: its process group is
// released with the command's scope, and what it printed until then is kept.
export const runFailing = Effect.fnUntraced(function* (argv: string[], cwd: string, timeoutMs = 10 * 60 * 1000) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const chunks: string[] = []
  let bytes = 0
  const decoder = new TextDecoder()
  const ran = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make('sh', ['-c', 'exec "$@" 2>&1', 'sh', ...argv], { cwd, stdin: 'ignore', stderr: 'ignore' }),
      )
      const read = Stream.runForEachWhile(child.stdout, (chunk) =>
        Effect.sync(() => {
          bytes += chunk.length
          chunks.push(decoder.decode(chunk, { stream: true }))
          return bytes <= OUTPUT_LIMIT
        }),
      )
      yield* read
      if (bytes > OUTPUT_LIMIT) return { status: null, stopped: OUTPUT_STOPPED }
      return yield* child.exitCode.pipe(
        Effect.map((code) => ({ status: Number(code) as number | null, stopped: undefined as string | undefined })),
        Effect.catchTag('PlatformError', (error) => {
          // The spawner names the signal in the error it wraps.
          const said = `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`
          const signal = /signal: '(\w+)'/.exec(said)?.[1]
          return signal ? Effect.succeed({ status: null, stopped: `killed by ${signal}` }) : Effect.fail(error)
        }),
      )
    }),
  ).pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.map((done) => (done._tag === 'Some' ? done.value : { status: null, stopped: stoppedAfter(timeoutMs) })),
  )
  return {
    argv,
    status: ran.status,
    output: chunks.join(''),
    ...(ran.stopped === undefined ? {} : { stopped: ran.stopped }),
  } satisfies FailedCommand
})

// What is hidden in everything a report sends from the project at `root`.
export const redactionIn = Effect.fnUntraced(function* (root: string, env: Env, home: string) {
  return redactionOf(home, yield* remotesOf(root), env)
})

// The dump of the project at `root`, redacted.
export const collectDump = Effect.fnUntraced(function* (input: {
  root: string
  env: Env
  machine: Machine
  harness?: string
  model?: string
  command?: FailedCommand
}) {
  const command = harnessCommand(input.env)
  const facts: DumpFacts = {
    root: input.root,
    env: input.env,
    ...(input.harness === undefined ? {} : { harness: input.harness }),
    ...(input.model === undefined ? {} : { model: input.model }),
    harnessVersion: command === null ? null : yield* versionOf(command),
    lntt: yield* lnttPackage,
    node: input.machine.node,
    os: input.machine.os,
    home: input.machine.home,
    remotes: yield* remotesOf(input.root),
    project: yield* projectFacts(input.root),
    ...(input.command === undefined ? {} : { command: input.command }),
  }
  return dumpOf(facts)
})
