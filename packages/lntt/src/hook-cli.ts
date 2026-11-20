// `lntt hook typecheck`, removed in 0.6.5 (docs/adr/agent-layer.md): it runs on Effect
// (src/hook/command.ts). This module parses its arguments, exit 2 before Effect loads, and reads
// the hook's input. The command goes in the release after.

import { stderr } from 'node:process'
import { exit } from './exit.ts'
import { readStdin } from './stdin.ts'

const USAGE = 'usage: lntt hook typecheck   (removed in 0.6.5)'

export async function main(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== 'typecheck') {
    stderr.write(`${USAGE}\n`)
    exit(2)
  }
  // The hook input on stdin is read to its end, so the writer finds no closed pipe; nothing
  // from a terminal, so a run by hand does not wait.
  if (!process.stdin.isTTY) {
    try {
      await readStdin()
    } catch {}
  }
  const { runHook } = await import('./hook/command.ts')
  return runHook()
}
