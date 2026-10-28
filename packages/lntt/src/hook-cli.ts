// `lntt hook <name>`: what the lines lntt sync writes into .claude/settings.json run
// (./hook.ts), with lntt's exit codes, which the lines translate: 1 a typecheck failure
// not reported yet, on stderr (the line exits 2, which wakes the agent); 2 the usage, which
// is also what an lntt older than `hook` answers. `format` exits 0, a notice on stdout as
// the systemMessage Claude Code shows the person.

import { readFileSync } from 'node:fs'
import { cwd, exit, stderr, stdout } from 'node:process'
import { runFormat, runTypecheck } from './hook.ts'

const USAGE = 'usage: lntt hook format | typecheck   (the hook input on stdin)'

export function main(args: string[]): void {
  const [name, ...rest] = args
  if (rest.length > 0) {
    stderr.write(`${USAGE}\n`)
    exit(2)
  }
  if (name === 'format') {
    let input = ''
    try {
      input = readFileSync(0, 'utf8')
    } catch {}
    const notice = runFormat(cwd(), input)
    if (notice !== null) stdout.write(`${JSON.stringify({ systemMessage: notice })}\n`)
    return
  }
  if (name === 'typecheck') {
    const failure = runTypecheck(cwd())
    if (failure === null) return
    stderr.write(failure.endsWith('\n') ? failure : `${failure}\n`)
    exit(1)
  }
  stderr.write(`${USAGE}\n`)
  exit(2)
}
