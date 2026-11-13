// `lntt pr block` on Effect (docs/adr/effect-in-lntt.md): the empty retrospective block of the
// project's configuration. src/pull-request-cli.ts parses the arguments and loads this module when
// the command runs. The configuration is read at one place, `configured`, with the loader that is
// not yet on Effect (ProjectConfig, which a spec replaces); the block goes to the terminal (Console).

import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { exit } from '../exit.ts'
import { retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import { projectConfig } from '../pull-request-cli.ts'
import { runCommand } from '../run-command.ts'

// The configuration cannot be read: reported by its message, exit 1.
export class PullRequestFailed extends Data.TaggedError('PullRequestFailed')<{ message: string }> {}

// The loader of the project's configuration, sync until it moves to Effect.
export const ProjectConfig = Context.Reference<() => Record<string, unknown>>(
  '@lntt/lntt/pull-request/command/ProjectConfig',
  { defaultValue: () => projectConfig },
)

// The project's configuration; one the loader refuses is a PullRequestFailed.
const configured = Effect.flatMap(ProjectConfig, (load) =>
  Effect.try({
    try: load,
    catch: (cause) => new PullRequestFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
  }),
)

// The block, its exit code: 0, or 1 when the configuration cannot be read.
export const block = Effect.gen(function* () {
  const text = retrospectiveBlock(retrospectiveRules(yield* configured))
  yield* Console.log(text.replace(/\n$/, ''))
  return 0
}).pipe(Effect.catchTag('PullRequestFailed', (error) => Effect.as(Console.error(`lntt pr: ${error.message}`), 1)))

// Runs the command as the process's main program (src/run-command.ts).
export function runBlock(): Promise<never> {
  return runCommand(block.pipe(Effect.map(exit)))
}
