// `lntt refs`: the references of a text with their titles, as JSON (src/refs.ts;
// usage: bin/lntt.ts). This module parses the arguments and reads the text, exit 2 before Effect
// loads; the command runs on Effect (src/refs/command.ts).

import { stderr, stdin } from 'node:process'
import { parseArgs } from 'node:util'
import { exit } from './exit.ts'
import { readStdin } from './stdin.ts'

const USAGE = 'usage: lntt refs [--cached] [<text>...]   (no text: read from stdin)'

function usage(message?: string): never {
  if (message) stderr.write(`lntt refs: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export async function main(args: string[]): Promise<void> {
  let values: { cached?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({ args, options: { cached: { type: 'boolean' } }, allowPositionals: true }))
  } catch (error) {
    usage((error as Error).message)
  }
  if (!positionals.length && stdin.isTTY) usage('give the text, or pipe it on stdin')
  let text: string
  try {
    text = positionals.length ? positionals.join('\n') : await readStdin()
  } catch (error) {
    stderr.write(`lntt refs: ${(error as Error).message}\n`)
    exit(1)
  }
  const { runRefs } = await import('./refs/command.ts')
  return runRefs({ text, cached: values.cached ?? false })
}
