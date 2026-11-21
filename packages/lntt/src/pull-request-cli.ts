// `lntt pr`: the pieces of a pull request body the configuration gives. Checking a body
// is `lntt check body` (usage: bin/lntt.ts). This module parses the arguments, exit 2 before
// Effect loads; the command runs on Effect (src/pull-request/command.ts).

import { cwd, stderr } from 'node:process'
import { exit } from './exit.ts'

const USAGE = 'usage: lntt pr block'

function usage(message?: string): never {
  if (message) stderr.write(`lntt pr: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args
  if (command !== 'block') usage(command === undefined ? undefined : `no command ${command}`)
  if (rest.length > 0) usage('block takes no argument')
  const { runBlock } = await import('./pull-request/command.ts')
  return runBlock(cwd())
}
