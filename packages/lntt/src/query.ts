// `--query <jq>` beside every `--json`: a jq expression on the document --json prints, run by
// jq-wasm, loaded here so that no other call pays for it. Strings raw unless --json, each value
// compact on its line. `--` ends jq's flags: an expression that starts with a dash stays an
// expression. A success keeps the command's exit code; any failure of jq exits 2 with nothing
// on stdout, what it printed before failing included, and so does the wasm giving up (out of
// memory, too deep a recursion). A document of several values (one JSON line per result, as
// lntt check prints) is queried value by value, as `| jq` does.
//
// A query can hold the event loop, so it runs outside Effect's runner, under the default handling
// of signals (docs/adr/lntt-command.md): this module computes what the query prints and its code,
// with no Effect and no node: module, and the command prints it with exit.ts's printed().

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

// What a query prints on stdout and stderr, each '' or ending with a newline, and the exit code.
export interface QueryOutcome {
  code: number
  out: string
  err: string
}

export async function runQuery({ input, expression, json, code, command, onFailure }: Query): Promise<QueryOutcome> {
  const { raw } = await import('jq-wasm')
  let jq: Awaited<ReturnType<typeof raw>>
  try {
    jq = await raw(input, expression, [...(json ? [] : ['-r']), '-c', '--'])
  } catch (error) {
    return { code: 2, out: '', err: `${command}: jq gave up: ${(error as Error).message}\n` }
  }
  if (jq.exitCode !== 0) {
    const own = onFailure?.(jq.exitCode) ?? null
    if (own !== null) return { code: own.code, out: '', err: `${own.line}\n${jq.stderr}\n` }
    return { code: 2, out: '', err: `${jq.stderr || `jq exited ${jq.exitCode}`}\n` }
  }
  return { code, out: jq.stdout ? `${jq.stdout}\n` : '', err: jq.stderr ? `${jq.stderr}\n` : '' }
}
