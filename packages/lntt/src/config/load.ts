// The project's configuration and the operator profile on Effect (docs/adr/effect-in-lntt.md):
// found, read and written through Effect's FileSystem and Path, the repository through Git; the
// operator's home is an input, read at the edge (effect/Config alone takes some 70 ms to load). The logic is plain (src/config/project.ts,
// src/config/operator.ts); what it throws is an expected failure here, a ConfigInvalid, and no
// file at all is a NoConfig, the one case a command may answer with its defaults.
//
// ProjectConfig is the configuration as a service: read once per command, the defaults with no
// file. A spec gives its data with ProjectConfig.memory.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import { ancestors, candidates, type Located, pick } from '../files.ts'
import { Git } from '../git/git.ts'
import { mainCheckout, OPERATOR_NAME, type Profile, profileOf, readProfile, slugOf } from './operator.ts'
import { CONFIG_DIR, CONFIG_NAME, editConfig, type Loaded, noConfig, readConfig } from './project.ts'

// A configuration or a profile that does not parse or validate, two files where one is allowed,
// a missing key: reported by its message.
export class ConfigInvalid extends Data.TaggedError('ConfigInvalid')<{ message: string }> {}

// No .agents/config.* in the directory or above.
export class NoConfig extends Data.TaggedError('NoConfig')<{ message: string }> {}

// The plain logic, what it throws an expected failure.
export const plain = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => new ConfigInvalid({ message: error instanceof Error ? error.message : String(error) }),
  })

// The one of `<dir>/<name>.jsonc` and `<dir>/<name>.yml` that exists.
const locate = Effect.fnUntraced(function* (dir: string, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found = yield* Effect.filter(candidates(dir, name, path.join), (file) => fs.exists(file.path))
  return yield* plain(() => pick(found))
})

// Walks up from `cwd` to the nearest directory holding `.agents/config.*`.
export const findConfig = Effect.fnUntraced(function* (
  cwd: string,
): Effect.fn.Return<Located, NoConfig | ConfigInvalid | PlatformError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path
  for (const dir of ancestors(cwd, path.dirname)) {
    const found = yield* locate(path.join(dir, CONFIG_DIR), CONFIG_NAME)
    if (found) return found
  }
  return yield* new NoConfig({ message: noConfig(cwd).message })
})

export const loadConfig = Effect.fnUntraced(function* (cwd: string) {
  const located = yield* findConfig(cwd)
  const text = yield* (yield* FileSystem.FileSystem).readFileString(located.path)
  const data = yield* plain(() => readConfig(text, located))
  return { ...located, data } satisfies Loaded
})

// Sets a dotted key, keeping every comment in the file; a rejected value leaves the file as it was.
export const setConfig = Effect.fnUntraced(function* (cwd: string, key: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const located = yield* findConfig(cwd)
  const text = yield* fs.readFileString(located.path)
  const next = yield* plain(() => editConfig(text, located, key, value))
  yield* fs.writeFileString(located.path, next)
})

// The project's profile: in the main checkout's .agents/local, else in the home under the origin's
// <org>/<repo>; none outside a repository.
const projectProfile = Effect.fnUntraced(function* (homeDir: string) {
  const git = yield* Git
  const path = yield* Path.Path
  const common = yield* git.commonDir.pipe(Effect.orElseSucceed(() => undefined))
  if (common === undefined) return undefined
  const main = mainCheckout(common)
  const local = main === undefined ? undefined : yield* locate(path.join(main, '.agents', 'local'), OPERATOR_NAME)
  if (local) return local
  const repo = slugOf(yield* git.originUrl)
  return repo ? yield* locate(path.join(homeDir, '.agents', 'projects', repo), OPERATOR_NAME) : undefined
})

// Who is talking to the agent (src/config/operator.ts): the profiles found under `homeDir` and in
// the repository, merged.
export const loadOperator = Effect.fnUntraced(function* (homeDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const global = yield* locate(path.join(homeDir, '.agents'), OPERATOR_NAME)
  const project = yield* projectProfile(homeDir)
  const read: { path: string; profile: Record<string, unknown> }[] = []
  for (const located of [global, project]) {
    if (located === undefined) continue
    const text = yield* fs.readFileString(located.path)
    read.push({ path: located.path, profile: yield* plain(() => readProfile(text, located)) })
  }
  return profileOf(read) satisfies Profile
})

export interface ProjectData {
  // The project's configuration: the defaults ({}) with no file, a ConfigInvalid when it does not
  // validate.
  readonly data: Effect.Effect<Record<string, unknown>, ConfigInvalid | PlatformError>
}

export class ProjectConfig extends Context.Service<ProjectConfig, ProjectData>()('@lntt/lntt/config/ProjectConfig') {
  static memory(data: Record<string, unknown>) {
    return Layer.succeed(ProjectConfig)(ProjectConfig.of({ data: Effect.succeed(data) }))
  }
}

// The configuration of `cwd`, the working directory when none is given, read once, on first use.
export const projectConfigIn = (cwd?: string) =>
  Layer.effect(ProjectConfig)(
    Effect.gen(function* () {
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const dir = cwd ?? (yield* Path.Path).resolve('.')
      const data = yield* Effect.cached(
        loadConfig(dir).pipe(
          Effect.map((loaded) => loaded.data),
          Effect.catchTag('NoConfig', () => Effect.succeed({})),
          Effect.provideContext(services),
        ),
      )
      return ProjectConfig.of({ data })
    }),
  )

export const ProjectConfigLive = projectConfigIn()
