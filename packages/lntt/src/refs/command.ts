// `lntt refs` on Effect (docs/adr/effect-in-lntt.md): the references of a text with their titles,
// as JSON on stdout. src/refs-cli.ts parses the arguments and reads the text before Effect loads.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { exit } from '../exit.ts'
import { GhLive } from '../gh/gh.ts'
import { GitLive } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import { resolveRefs } from './resolve.ts'

// A command as refs-cli.ts parsed it: the text, and whether only the cache is read.
export interface RefsCommand {
  text: string
  cached: boolean
}

// What lntt refs prints, one JSON line; it always exits 0: a reference with no title says why.
export const command = (parsed: RefsCommand) =>
  Effect.flatMap(resolveRefs(parsed.text, { cached: parsed.cached }), (refs) =>
    Effect.as(Console.log(JSON.stringify(refs)), 0),
  )

// The services on the machine.
const Live = Layer.mergeAll(GitLive, GhLive, NodeFileSystem.layer).pipe(Layer.provide(SpawnerLive))

// Runs the command as the process's main program (src/run-command.ts).
export function runRefs(parsed: RefsCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
