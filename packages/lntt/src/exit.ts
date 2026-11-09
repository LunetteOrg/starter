// The one way lntt ends. On macOS a pipe takes writes asynchronously, so process.exit right
// after a long write drops what the reader has not taken yet: a JSON document arrives cut,
// with no sign of it. Each command ends through here, which lets stdout and stderr drain first.
//
//   finish(main)  bin/lntt.ts runs every command through it: the code the command exited
//                 with, else process.exitCode, else 0; a defect prints its stack, exit 1
//   exit(code)    inside a command, synchronous: the command stops there, never returns
//   leave(code)   from a signal handler or a timer, which cannot throw back to finish

import process, { stderr, stdout } from 'node:process'
import { inspect } from 'node:util'

// What exit() throws, for finish() to catch: a catch-all of a command lets it through.
export class Exit extends Error {
  readonly code: number
  constructor(code: number) {
    super(`lntt exits ${code}`)
    this.code = code
  }
}

export function exit(code: number): never {
  throw new Exit(code)
}

// The callback of a write comes after every write before it: then the stream has taken all.
// A stream already closed, or a reader that left, calls it with an error: nothing to wait for.
const drained = (stream: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) resolve()
    else stream.write('', () => resolve())
  })

export async function leave(code: number): Promise<never> {
  await Promise.all([drained(stdout), drained(stderr)])
  process.exit(code)
}

export async function finish(main: () => unknown): Promise<never> {
  // A reader that left (`| head`) is its own business: the exit code still says the outcome.
  stdout.on('error', () => {})
  let code: number
  try {
    await main()
    code = Number(process.exitCode ?? 0)
  } catch (error) {
    if (error instanceof Exit) code = error.code
    else {
      // A defect of lntt itself: its stack, as Node prints an uncaught error.
      stderr.write(`${inspect(error)}\n`)
      code = 1
    }
  }
  return leave(code)
}
