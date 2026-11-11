// How a command on Effect runs, is interrupted and exits (docs/adr/effect-in-lntt.md). Only
// those commands import this module, so the others do not load Effect.
//
// NodeRuntime.runMain runs the command and interrupts it on SIGINT or SIGTERM: every finalizer
// of its scope runs (the agents are released), then the teardown leaves through exit.ts's
// leave, so stdout and stderr drain first. runMain on its own exits at once on any code but 0,
// and prints failures in Effect's log format: lntt reports its failures itself, as finish() does.

import { stderr } from 'node:process'
import { inspect } from 'node:util'
import * as NodeRuntime from '@effect/platform-node-shared/NodeRuntime'
import * as Cause from 'effect/Cause'
import type * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Runtime from 'effect/Runtime'
import { Exit as LnttExit, leave } from './exit.ts'

// The code of an ending: 0, the code an exit(code) threw, 130 for an interrupt, 1 for any other
// failure or a defect (Effect's teardown gives 0, 130 and 1), printed with its stack.
export const teardownWith =
  (
    leaveWith: (code: number) => Promise<unknown>,
    report = (text: string) => void stderr.write(text),
  ): Runtime.Teardown =>
  (ending) => {
    if (Exit.isFailure(ending) && !Cause.hasInterruptsOnly(ending.cause)) {
      const error = Cause.squash(ending.cause)
      if (error instanceof LnttExit) return void leaveWith(error.code)
      report(`${inspect(error)}\n`)
    }
    Runtime.defaultTeardown(ending, (code) => void leaveWith(code))
  }

// Runs a command as the process's main program. It never returns: the teardown ends the process.
export function runCommand<E, A>(command: Effect.Effect<A, E>): Promise<never> {
  return new Promise<never>(() =>
    NodeRuntime.runMain(command, { disableErrorReporting: true, teardown: teardownWith(leave) }),
  )
}
