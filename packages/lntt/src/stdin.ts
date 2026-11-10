// Stdin to its end. A synchronous read of the descriptor is a blocking call: on a pipe whose
// writer has not written yet, with the descriptor non-blocking, it throws EAGAIN instead of
// waiting. The stream waits for the writer and ends when it closes the pipe.

import { fstatSync } from 'node:fs'
import { stdin } from 'node:process'

export async function readStdin(): Promise<string> {
  // Node gives a directory on stdin an empty stream, which ends with no error: say what a
  // read of it says.
  if (fstatSync(stdin.fd).isDirectory()) throw new Error('EISDIR: illegal operation on a directory, read')
  stdin.setEncoding('utf8')
  let text = ''
  for await (const chunk of stdin) text += chunk
  return text
}
