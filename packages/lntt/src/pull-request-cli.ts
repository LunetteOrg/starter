// `lntt pr`: the pieces of a pull request body the configuration gives. Checking a body
// is `lntt check body` (usage: bin/lntt.ts).

import { cwd, exit, stderr, stdout } from 'node:process'
import { loadConfig } from './index.ts'
import { retrospectiveBlock, retrospectiveRules } from './pull-request.ts'

const USAGE = 'usage: lntt pr block'

function usage(message?: string): never {
  if (message) stderr.write(`lntt pr: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export function main(args: string[]): void {
  const [command, ...rest] = args
  if (command !== 'block') usage(command === undefined ? undefined : `no command ${command}`)
  if (rest.length > 0) usage('block takes no argument')
  stdout.write(retrospectiveBlock(retrospectiveRules(loadConfig(cwd()).data)))
}
