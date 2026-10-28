// `lntt hook <name>`: what the lines lntt sync writes into .claude/settings.json run
// (./hook.ts), with lntt's exit codes, which the lines translate: 1 a typecheck failure
// not reported yet, on stderr (the line exits 2, which wakes the agent); 2 the usage, which
// is also what an lntt older than `hook` answers. Otherwise 0, with any notice on stdout as
// the systemMessage Claude Code shows the person: a configuration the format hook cannot
// read, or a defect of the typecheck hook itself (its own error, a state it cannot keep),
// which never wakes the agent and is said once per session.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process, { cwd, exit, stderr, stdout } from 'node:process'
import { runFormat, runTypecheck } from './hook.ts'

const USAGE = 'usage: lntt hook format | typecheck   (the hook input on stdin)'

const notice = (text: string) => stdout.write(`${JSON.stringify({ systemMessage: text })}\n`)

function readInput(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function sessionOf(input: string): string | null {
  try {
    const id = JSON.parse(input)?.session_id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

// True the first time for a session, in the temporary directory; with no session id, or
// no marker that can be kept, every time.
function firstInSession(session: string | null): boolean {
  if (session === null) return true
  const marker = join(tmpdir(), `lntt-hook-defect-${createHash('sha256').update(session).digest('hex').slice(0, 16)}`)
  try {
    if (existsSync(marker)) return false
    writeFileSync(marker, '')
  } catch {}
  return true
}

export async function main(args: string[]): Promise<void> {
  const [name, ...rest] = args
  if (rest.length > 0 || (name !== 'format' && name !== 'typecheck')) {
    stderr.write(`${USAGE}\n`)
    exit(2)
  }
  const input = readInput()
  if (name === 'format') {
    try {
      const text = await runFormat(cwd(), input)
      if (text !== null) notice(text)
    } catch {
      // A defect of the format hook: the commit's own check is the gate.
    }
    return
  }
  let failure: string | null
  try {
    failure = await runTypecheck(cwd())
  } catch (e) {
    if (firstInSession(sessionOf(input))) {
      notice(`lntt hook typecheck could not run: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }
  if (failure === null) return
  // exitCode, not exit(): a long output to a pipe is written whole before Node exits.
  stderr.write(failure.endsWith('\n') ? failure : `${failure}\n`)
  process.exitCode = 1
}
