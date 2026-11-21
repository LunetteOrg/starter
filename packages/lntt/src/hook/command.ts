// `lntt hook typecheck` on Effect (docs/adr/effect-in-lntt.md), removed in 0.6.5: the Stop line a
// sync of 0.6.4 wrote runs it until the project syncs again, so for one release the command answers
// that line with what to do (exit 0, a systemMessage, which Claude Code gives the agent at its next
// turn). src/hook-cli.ts parses the arguments (any other call is a usage error, exit 2) and reads the
// hook's input to its end before this module loads.

import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import { exit } from '../exit.ts'
import { runCommand } from '../run-command.ts'

export const REMOVED =
  "lntt hook typecheck was removed in 0.6.5: run pnpm exec lntt sync, the typecheck is the pre-commit's"

// The command: the systemMessage, exit 0.
export const command = Effect.as(Console.log(JSON.stringify({ systemMessage: REMOVED })), 0)

// Runs the command as the process's main program (src/run-command.ts).
export function runHook(): Promise<never> {
  return runCommand(command.pipe(Effect.map(exit)))
}
