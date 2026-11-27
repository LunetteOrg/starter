// `lntt sync` and `lntt guide` on Effect (docs/adr/effect-in-lntt.md). src/cli.ts parses their
// arguments (a usage error exits 2 before Effect loads) and loads this module only for them.
//
// The logic reaches the machine only through services: the file system (FileSystem, Path) and
// the terminal (Console). src/sync/command.spec.ts runs it on their in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { loadConfig } from '../config/load.ts'
import { exit } from '../exit.ts'
import { runCommand } from '../run-command.ts'
import { guide, sharedSkills, syncProject } from './project.ts'

// A command as src/cli.ts parsed it: `lntt sync` from the directory `cwd`, or `lntt guide`, of
// one skill or, without `name`, the list.
export type SyncCommand = { kind: 'sync'; cwd: string } | { kind: 'guide'; name?: string }

// `lntt guide`: the shared skills, one per line; with a name, the guide of that skill.
const guideCommand = Effect.fnUntraced(function* (name: string | undefined) {
  const skills = yield* sharedSkills
  if (name === undefined) {
    for (const skill of skills) yield* Console.log(skill)
    return 0
  }
  const text = yield* guide(name)
  if (text === null) {
    yield* Console.error(`lntt guide: no skill ${name}; the skills are ${skills.join(', ')}`)
    return 1
  }
  // The guide as it is written, its last newline included.
  yield* Console.log(text.replace(/\n$/, ''))
  return 0
})

// The project of `cwd` brought to what lntt writes: its root is where its configuration is.
const sync = Effect.fnUntraced(function* (cwd: string) {
  const path = yield* Path.Path
  const loaded = yield* loadConfig(cwd)
  yield* syncProject(path.dirname(path.dirname(loaded.path)), loaded.data)
  return 0
})

// A command's exit code: 1 for an expected failure, said in one line.
export const command = (parsed: SyncCommand) =>
  (parsed.kind === 'sync' ? sync(parsed.cwd) : guideCommand(parsed.name)).pipe(
    Effect.catchTags({
      SyncFailed: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
      ConfigInvalid: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
      NoConfig: (error) => Effect.as(Console.error(`lntt: ${error.message}`), 1),
      PlatformError: (error) => Effect.as(Console.error(`lntt: error: ${error.message}`), 1),
    }),
  )

const Live = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

// Runs a command as the process's main program (src/run-command.ts).
export function runSync(parsed: SyncCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
