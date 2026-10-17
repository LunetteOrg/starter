// `lntt ask`, `lntt inbox` and `lntt answer`: the mailbox of src/messages.ts from the
// command line (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cwd, env, exit, stderr, stdin, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { answer, type Mailbox, type Message, POLL_MS, pending, send, waitForAnswer } from './messages.ts'

const USAGE = [
  'usage: lntt ask --to <orchestrator|coordinator|child> [--issue <n>] [--theme <slug>] [--topic <slug>] [--timeout <s>] [--interval <s>] <question | ->',
  '       lntt inbox [--as <orchestrator|coordinator|child>] [--issue <n>] [--theme <slug>] [--wait] [--timeout <s>] [--interval <s>]',
  '       lntt answer <id> <text | ->',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// <git common dir>/lntt-messages: shared by every worktree of the repository.
export function messagesRoot(directory = cwd()): string {
  if (env.LNTT_MESSAGES_DIR) return env.LNTT_MESSAGES_DIR
  let common: string
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(
      'the mailbox lives in the git common directory: run this inside a git repository (git 2.31 or later)',
    )
  }
  return `${common}/lntt-messages`
}

// 20 seconds, or LNTT_POLL_SECONDS: how often an answer or an inbox is looked at.
export function pollInterval(): number {
  const seconds = Number(env.LNTT_POLL_SECONDS)
  return seconds > 0 ? seconds * 1000 : POLL_MS
}

export function systemMailbox(directory = cwd()): Mailbox {
  return {
    dir: messagesRoot(directory),
    now: () => new Date(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  }
}

// Seconds on the command line, milliseconds inside.
function seconds(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) usage(`${flag} takes a number of seconds, not ${value}`)
  return Number(value) * 1000
}

function issueNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value)) usage(`--issue takes a number, not ${value}`)
  return Number(value)
}

function text(argument: string | undefined): string {
  if (argument === undefined) usage('give the text, or - to read it from stdin')
  return argument === '-' ? readFileSync(stdin.fd, 'utf8') : argument
}

function line(message: Message): string {
  return JSON.stringify({
    id: message.id,
    to: message.to,
    topic: message.topic,
    path: message.path,
    question: message.question,
  })
}

// Writes the question, then polls for its answer; stdout is the answer. The wait is the
// point of the command: a caller that must not block runs it in the background.
function ask(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      issue: { type: 'string' },
      theme: { type: 'string' },
      topic: { type: 'string' },
      timeout: { type: 'string' },
      interval: { type: 'string' },
    },
  })
  if (!values.to) usage('give --to')
  if (positionals.length !== 1) usage('give the question as one argument')
  const box = systemMailbox()
  const sent = send(box, values.to, text(positionals[0]), {
    ...(values.topic ? { topic: values.topic } : {}),
    ...(values.issue ? { issue: issueNumber(values.issue) as number } : {}),
    ...(values.theme ? { theme: values.theme } : {}),
  })
  const interval = seconds(values.interval, '--interval') ?? pollInterval()
  stderr.write(`lntt ask: ${sent.id} sent to ${sent.to}; waiting for the answer, polling every ${interval / 1000} s\n`)
  const timeoutMs = seconds(values.timeout, '--timeout')
  stdout.write(waitForAnswer(box, sent, { intervalMs: interval, ...(timeoutMs === undefined ? {} : { timeoutMs }) }))
}

// The unanswered messages to a role, one JSON line each. With --wait, nothing is printed
// until there is at least one.
function inbox(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: 'string' },
      issue: { type: 'string' },
      theme: { type: 'string' },
      wait: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      interval: { type: 'string' },
    },
  })
  const role = values.as ?? env.LNTT_ROLE
  if (!role) usage('give --as, or set LNTT_ROLE')
  // The environment's address applies to the role it fits: a session that exports both
  // can read as a child and as a coordinator.
  const issue = issueNumber(values.issue ?? (role === 'child' ? env.LNTT_ISSUE : undefined))
  const theme = values.theme ?? (role === 'coordinator' ? env.LNTT_THEME : undefined)
  const address = { ...(issue === undefined ? {} : { issue }), ...(theme === undefined ? {} : { theme }) }
  const box = systemMailbox()
  const interval = seconds(values.interval, '--interval') ?? pollInterval()
  const timeoutMs = seconds(values.timeout, '--timeout')
  let waited = 0
  for (;;) {
    const messages = pending(box.dir, role, address)
    if (messages.length > 0 || !values.wait) {
      for (const message of messages) stdout.write(`${line(message)}\n`)
      return
    }
    if (timeoutMs !== undefined && waited >= timeoutMs) {
      throw new Error(`no message to the ${role} in ${timeoutMs / 1000} s`)
    }
    box.sleep(interval)
    waited += interval
  }
}

export function main(command: 'ask' | 'inbox' | 'answer', args: string[]): void {
  try {
    if (command === 'ask') ask(args)
    else if (command === 'inbox') inbox(args)
    else {
      const [id, reply, ...rest] = args
      if (!id || rest.length > 0) usage()
      stdout.write(`${answer(systemMailbox().dir, id, text(reply))}\n`)
    }
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    stderr.write(`lntt ${command}: ${(error as Error).message}\n`)
    exit(1)
  }
}
