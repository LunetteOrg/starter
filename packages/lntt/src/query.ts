// `--query <jq>` beside every `--json`: a jq expression on the document --json prints, run by
// jq-wasm, loaded here so that no other call pays for it. Strings raw unless --json, each value
// compact on its line. `--` ends jq's flags: an expression that starts with a dash stays an
// expression. A success keeps the command's exit code; any failure of jq exits 2 with nothing
// on stdout, what it printed before failing included, and so does the wasm giving up (out of
// memory, too deep a recursion). A document of several values (one JSON line per result, as
// lntt check prints) is queried value by value, as `| jq` does.

import { stderr, stdout } from 'node:process'

export type Query = {
  // The document as --json prints it.
  input: string
  expression: string
  json: boolean
  // The command's exit code, kept on success.
  code: number
  // `lntt <command>`, before the message when the wasm gives up.
  command: string
  // A failure while running, given jq's exit code and message: an exit code of the command's
  // own and the line before the message (lntt review status: 4, no round to read), else null.
  onFailure?: (exitCode: number) => { code: number; line: string } | null
}

export async function runQuery({ input, expression, json, code, command, onFailure }: Query): Promise<number> {
  const { raw } = await import('jq-wasm')
  let jq: Awaited<ReturnType<typeof raw>>
  try {
    jq = await raw(input, expression, [...(json ? [] : ['-r']), '-c', '--'])
  } catch (error) {
    stderr.write(`${command}: jq gave up: ${(error as Error).message}\n`)
    return 2
  }
  if (jq.exitCode !== 0) {
    const own = onFailure?.(jq.exitCode) ?? null
    if (own !== null) {
      stderr.write(`${own.line}\n${jq.stderr}\n`)
      return own.code
    }
    stderr.write(`${jq.stderr || `jq exited ${jq.exitCode}`}\n`)
    return 2
  }
  if (jq.stderr) stderr.write(`${jq.stderr}\n`)
  if (jq.stdout) stdout.write(`${jq.stdout}\n`)
  return code
}
