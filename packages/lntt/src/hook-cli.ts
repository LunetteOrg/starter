// `lntt hook typecheck`, removed in 0.6.5: the typecheck is the pre-commit's alone
// (docs/adr/agent-layer.md). The Stop line a sync of 0.6.4 wrote runs it until the project
// syncs again, so for one release the command answers that line with what to do (exit 0, a
// systemMessage, which Claude Code gives the agent at its next turn) instead of the usage
// error the line reads as an lntt older than `hook`. Any other call is a usage error, exit 2.
// The command goes in the release after.

import { stderr, stdout } from 'node:process'
import { exit } from './exit.ts'
import { readStdin } from './stdin.ts'

const USAGE = 'usage: lntt hook typecheck   (removed in 0.6.5)'
const REMOVED = "lntt hook typecheck was removed in 0.6.5: run pnpm exec lntt sync, the typecheck is the pre-commit's"

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
  stdout.write(`${JSON.stringify({ systemMessage: REMOVED })}\n`)
}
