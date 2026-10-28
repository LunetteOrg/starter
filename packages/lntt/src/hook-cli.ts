// `lntt hook <name>`: what the lines lntt sync writes into .claude/settings.json run
// (./hook.ts). The exit codes are the lines' to translate: 0 nothing to say, 3 a new
// typecheck failure (the line exits 2, which wakes the agent), 2 the usage.

import { readFileSync } from 'node:fs'
import { cwd, exit, stderr } from 'node:process'
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
    runFormat(cwd(), input)
    return
  }
  if (name === 'typecheck') {
    const failure = runTypecheck(cwd())
    if (failure === null) return
    stderr.write(failure.endsWith('\n') ? failure : `${failure}\n`)
    exit(3)
  }
  stderr.write(`${USAGE}\n`)
  exit(2)
}
