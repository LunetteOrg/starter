// `lntt refs`: the references of a text with their titles, as JSON (src/refs.ts;
// usage: bin/lntt.ts).

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { exit, stderr, stdin, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { type RefsRun, resolveRefs } from './refs.ts'

const USAGE = 'usage: lntt refs [--cached] [<text>...]   (no text: read from stdin)'

function usage(message?: string): never {
  if (message) stderr.write(`lntt refs: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// Each command in a child of its own, killed past its timeout; an exit code other than
// 0 is an answer, not a rejection.
const run: RefsRun = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, out, err) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error)
      else resolve({ exitCode: error ? (error.code as number) : 0, stdout: out, stderr: err })
    })
  })

export async function main(args: string[]): Promise<void> {
  let values: { cached?: boolean }
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({ args, options: { cached: { type: 'boolean' } }, allowPositionals: true }))
  } catch (error) {
    usage((error as Error).message)
  }
  try {
    if (!positionals.length && stdin.isTTY) usage('give the text, or pipe it on stdin')
    const text = positionals.length ? positionals.join('\n') : readFileSync(stdin.fd, 'utf8')
    const refs = await resolveRefs(text, { run, now: Date.now, cached: values.cached ?? false })
    stdout.write(`${JSON.stringify(refs)}\n`)
  } catch (error) {
    stderr.write(`lntt refs: ${(error as Error).message}\n`)
    exit(1)
  }
}
