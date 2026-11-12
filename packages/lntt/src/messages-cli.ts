// `lntt ask`, `lntt inbox` and `lntt answer`: the mailbox of src/messages/mailbox.ts from the
// command line (usage: bin/lntt.ts). This module parses the arguments, reads the environment and
// stdin, and exits 2 on a usage error before Effect loads; the command runs on Effect
// (src/messages/command.ts).

import { env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import { exit } from './exit.ts'
import type { MessagesCommand } from './messages/command.ts'
import { type Address, POLL_MS } from './messages/rules.ts'
import { readStdin } from './stdin.ts'

const USAGE = [
  'usage: lntt ask --to <orchestrator|coordinator|child> [--issue <n>] [--theme <slug>] [--topic <slug>] [--timeout <s>] [--interval <s>] <question | ->',
  '       lntt ask --wait <id> [--timeout <s>] [--interval <s>]',
  '       lntt inbox [--as <orchestrator|coordinator|child>] [--issue <n>] [--theme <slug>] [--wait | --follow] [--timeout <s>] [--interval <s>]',
  '       lntt answer <id> <text | ->',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// 20 seconds, or LNTT_POLL_SECONDS: how often an answer or an inbox is looked at.
export function pollInterval(): number {
  const seconds = Number(env.LNTT_POLL_SECONDS)
  return seconds > 0 ? seconds * 1000 : POLL_MS
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

async function text(argument: string | undefined): Promise<string> {
  if (argument === undefined) usage('give the text, or - to read it from stdin')
  return argument === '-' ? await readStdin() : argument
}

const timeout = (value: string | undefined) => {
  const ms = seconds(value, '--timeout')
  return ms === undefined ? {} : { timeoutMs: ms }
}

async function ask(args: string[]): Promise<MessagesCommand> {
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
      wait: { type: 'string' },
    },
  })
  const intervalMs = seconds(values.interval, '--interval') ?? pollInterval()
  if (values.wait !== undefined) {
    if (positionals.length > 0) usage('--wait takes the id of a message already sent, and no question')
    for (const flag of ['to', 'issue', 'theme', 'topic'] as const) {
      if (values[flag] !== undefined) usage(`--wait takes no --${flag}: the message is already addressed`)
    }
    return { kind: 'wait', id: values.wait, intervalMs, ...timeout(values.timeout) }
  }
  if (!values.to) usage('give --to')
  if (positionals.length !== 1) usage('give the question as one argument')
  const issue = issueNumber(values.issue)
  return {
    kind: 'ask',
    to: values.to,
    question: await text(positionals[0]),
    ...(values.topic ? { topic: values.topic } : {}),
    ...(issue === undefined ? {} : { issue }),
    ...(values.theme ? { theme: values.theme } : {}),
    intervalMs,
    ...timeout(values.timeout),
  }
}

function inbox(args: string[]): MessagesCommand {
  const { values } = parseArgs({
    args,
    options: {
      as: { type: 'string' },
      issue: { type: 'string' },
      theme: { type: 'string' },
      wait: { type: 'boolean', default: false },
      follow: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      interval: { type: 'string' },
    },
  })
  const role = values.as ?? env.LNTT_ROLE
  if (!role) usage('give --as, or set LNTT_ROLE')
  if (values.wait && values.follow) usage('--wait and --follow are exclusive')
  // The environment's address applies to the role it fits: a session that exports both can read
  // as a child and as a coordinator.
  const issue = issueNumber(values.issue ?? (role === 'child' ? env.LNTT_ISSUE : undefined))
  const theme = values.theme ?? (role === 'coordinator' ? env.LNTT_THEME : undefined)
  const address: Address = { ...(issue === undefined ? {} : { issue }), ...(theme === undefined ? {} : { theme }) }
  return {
    kind: 'inbox',
    role,
    address,
    wait: values.wait,
    follow: values.follow,
    intervalMs: seconds(values.interval, '--interval') ?? pollInterval(),
    ...timeout(values.timeout),
  }
}

async function parse(command: 'ask' | 'inbox' | 'answer', args: string[]): Promise<MessagesCommand> {
  try {
    if (command === 'ask') return await ask(args)
    if (command === 'inbox') return inbox(args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    throw error
  }
  const [id, reply, ...rest] = args
  if (!id || rest.length > 0) usage()
  return { kind: 'answer', id, text: await text(reply) }
}

export async function main(command: 'ask' | 'inbox' | 'answer', args: string[]): Promise<void> {
  const parsed = await parse(command, args)
  const { runMessages } = await import('./messages/command.ts')
  await runMessages(parsed, env.LNTT_MESSAGES_DIR || undefined)
}
