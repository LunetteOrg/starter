// `lntt pr block` on Effect (docs/adr/effect-in-lntt.md): the empty retrospective block of the
// project's configuration. src/pull-request-cli.ts parses the arguments and loads this module when
// the command runs. The configuration is read through the FileSystem (src/config/load.ts): with no
// file, or one that does not validate, the command says so; the block goes to the terminal
// (Console).

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { loadConfig } from '../config/load.ts'
import { exit } from '../exit.ts'
import { retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import { runCommand } from '../run-command.ts'

// The configuration cannot be read: reported by its message, exit 1.
export class PullRequestFailed extends Data.TaggedError('PullRequestFailed')<{ message: string }> {}

// The configuration found from `cwd`; none, or one that does not validate, is a PullRequestFailed.
const configured = (cwd: string) =>
  loadConfig(cwd).pipe(
    Effect.map((loaded) => loaded.data),
    Effect.mapError((error) => new PullRequestFailed({ message: error.message })),
  )

// The block, its exit code: 0, or 1 when the configuration cannot be read.
export const block = (cwd: string) =>
  Effect.gen(function* () {
    const text = retrospectiveBlock(retrospectiveRules(yield* configured(cwd)))
    yield* Console.log(text.replace(/\n$/, ''))
    return 0
  }).pipe(Effect.catchTag('PullRequestFailed', (error) => Effect.as(Console.error(`lntt pr: ${error.message}`), 1)))

// Runs the command as the process's main program (src/run-command.ts).
export function runBlock(cwd: string): Promise<never> {
  return runCommand(
    block(cwd).pipe(Effect.map(exit), Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  )
}
