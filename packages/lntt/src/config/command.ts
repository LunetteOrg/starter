// The configuration commands of `lntt` on Effect (docs/adr/effect-in-lntt.md): path, validate,
// get, set and operator. src/cli.ts parses their arguments (a usage error exits 2 before Effect
// loads) and loads this module only for them.
//
// The logic reaches the machine only through services: the file system (FileSystem, Path), git
// for the operator's project profile (Git) and the terminal (Console); the operator's home is
// given, read at the edge. src/config/command.spec.ts runs it on their in-memory layers.

import * as NodeChildProcessSpawner from '@effect/platform-node-shared/NodeChildProcessSpawner'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { exit } from '../exit.ts'
import { GitLive } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { ConfigInvalid, findConfig, loadConfig, loadOperator, plain, setConfig } from './load.ts'
import { getConfigValue, getValue } from './project.ts'
import { validation } from './validate.ts'

// A command as src/cli.ts parsed it.
export type ConfigCommand =
  | { kind: 'path' }
  | { kind: 'validate' }
  | { kind: 'get'; key: string }
  | { kind: 'set'; key: string; value: unknown }
  // The whole profile, its sources, or one key of it.
  | { kind: 'operator'; show: 'profile' | 'sources' | { key: string } }

const json = (value: unknown) => Console.log(JSON.stringify(value))

// The schema on load, then what it cannot express (src/config/validate.ts): a failure exits 1, a
// warning is said and the file stays valid.
const validate = Effect.fnUntraced(function* (cwd: string) {
  const { path, data } = yield* loadConfig(cwd)
  const { failure, warnings } = validation(path, data)
  if (failure !== null) return yield* new ConfigInvalid({ message: failure })
  for (const warning of warnings) yield* Console.error(`lntt validate: warning: ${warning}`)
})

const operator = Effect.fnUntraced(function* (
  show: Extract<ConfigCommand, { kind: 'operator' }>['show'],
  home: string,
) {
  const { profile, sources } = yield* loadOperator(home)
  if (show === 'profile') return yield* json(profile)
  if (show === 'sources') {
    for (const source of sources) yield* Console.log(source)
    return
  }
  yield* json(yield* plain(() => getValue(profile, show.key)))
})

// A command in the directory `cwd`, the operator's home `home`: its exit code. A configuration that cannot be found, read or
// validated, or a key it lacks, is said on stderr and exits 1.
export const command = (parsed: ConfigCommand, cwd: string, home: string) =>
  Effect.gen(function* () {
    switch (parsed.kind) {
      case 'path':
        yield* Console.log((yield* findConfig(cwd)).path)
        break
      case 'validate':
        yield* validate(cwd)
        break
      case 'get': {
        const { data } = yield* loadConfig(cwd)
        yield* json(yield* plain(() => getConfigValue(data, parsed.key)))
        break
      }
      case 'set':
        yield* setConfig(cwd, parsed.key, parsed.value)
        break
      case 'operator':
        yield* operator(parsed.show, home)
        break
    }
    return 0
  }).pipe(
    Effect.catchTags({
      ConfigInvalid: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
      NoConfig: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
      PlatformError: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
    }),
  )

// The services on the machine.
const Live = GitLive.pipe(
  Layer.provide(NodeChildProcessSpawner.layer),
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

// Runs a configuration command as the process's main program (src/run-command.ts).
export function runConfig(parsed: ConfigCommand, cwd: string, home: string): Promise<never> {
  return runCommand(command(parsed, cwd, home).pipe(Effect.map(exit), Effect.provide(Live)))
}
