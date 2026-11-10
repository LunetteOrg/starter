// `lntt ask`, `lntt inbox` and `lntt answer`: the mailbox of src/messages.ts from the
// command line (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { cwd, env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { fromToolName } from './branch.ts'
import { rules } from './branch-cli.ts'
import { Exit, exit } from './exit.ts'
import {
  type Address,
  answer,
  answerPath,
  checkedOutBranches,
  liveChildren,
  locate,
  type Mailbox,
  type Message,
  messages,
  POLL_MS,
  pending,
  ROLES,
  send,
  type Target,
  waitForAnswer,
} from './messages.ts'
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

async function text(argument: string | undefined): Promise<string> {
  if (argument === undefined) usage('give the text, or - to read it from stdin')
  return argument === '-' ? await readStdin() : argument
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

// A message already sent, by its id: the one `lntt review` sends at its limit, or one
// whose wait was cut short by a timeout.
function sentMessage(root: string, raw: string): Message {
  const found = locate(root, raw)
  if (found.length === 0) throw new Error(`no message ${raw} in ${root}`)
  if (found.length > 1) throw new Error(`${raw} names more than one message: ${found.join(', ')}`)
  const path = found[0] as string
  const id = raw.replace(/\.md$/, '')
  // The role of to-<role> or to-<role>-<who>: the directory says who, the role is the word.
  const directory = basename(dirname(path))
  const to = ROLES.find((role) => directory === `to-${role}` || directory.startsWith(`to-${role}-`))
  if (to === undefined) throw new Error(`${path} is not in a role's directory`)
  return { id, topic: id.replace(/^\d{8}-\d{6}-/, ''), to, path, question: readFileSync(path, 'utf8').trim() }
}

// Writes the question, then polls for its answer; stdout is the answer. The wait is the
// point of the command: a caller that must not block runs it in the background. With
// --wait <id>, only the wait, for a message already sent.
async function ask(args: string[]): Promise<void> {
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
  const interval = seconds(values.interval, '--interval') ?? pollInterval()
  const box = systemMailbox()
  let sent: Message
  if (values.wait !== undefined) {
    if (positionals.length > 0) usage('--wait takes the id of a message already sent, and no question')
    for (const flag of ['to', 'issue', 'theme', 'topic'] as const) {
      if (values[flag] !== undefined) usage(`--wait takes no --${flag}: the message is already addressed`)
    }
    sent = sentMessage(box.dir, values.wait)
    stderr.write(`lntt ask: waiting for the answer to ${sent.id}, polling every ${interval / 1000} s\n`)
  } else {
    if (!values.to) usage('give --to')
    if (positionals.length !== 1) usage('give the question as one argument')
    sent = send(box, values.to, await text(positionals[0]), {
      ...(values.topic ? { topic: values.topic } : {}),
      ...(values.issue ? { issue: issueNumber(values.issue) as number } : {}),
      ...(values.theme ? { theme: values.theme } : {}),
    })
    stderr.write(
      `lntt ask: ${sent.id} sent to ${sent.to}; waiting for the answer, polling every ${interval / 1000} s\n`,
    )
  }
  const timeoutMs = seconds(values.timeout, '--timeout')
  stdout.write(waitForAnswer(box, sent, { intervalMs: interval, ...(timeoutMs === undefined ? {} : { timeoutMs }) }))
}

// Exit code of an inbox that has no child left to wait for: not 1 (an error or a timeout),
// not 2 (usage).
export const NO_WRITER_EXIT = 3

class NoWriters extends Error {}

// The children that can write to this inbox: the markers addressed to it. A child's inbox
// is written by whoever started it, and nothing says who is alive, so it has no target.
function writers(role: string, theme: string | undefined): Target | null {
  if (role === 'orchestrator') return { to: 'orchestrator' }
  if (role === 'coordinator') return { to: 'coordinator', ...(theme === undefined ? {} : { theme }) }
  return null
}

// The branches in a worktree that exists, each also under its conventional name: a branch
// still on the name Orca gave it (until `lntt branch rename`) has the marker of that one.
function liveBranches(root: string): () => Set<string> {
  return () => {
    // An invalid configuration is an error here as everywhere; a missing one gives the defaults.
    const ruleset = rules()
    return checkedOutBranches(dirname(root), (branch) => fromToolName(branch, ruleset))
  }
}

// The unanswered messages to a role, one JSON line each. With --wait, nothing is printed
// until there is at least one, and the wait ends (exit 3) when no child reports to the
// role any more. With --follow, those lines first, then one for each message that arrives,
// until no child reports to the role.
function inbox(args: string[]): void {
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
  // The environment's address applies to the role it fits: a session that exports both
  // can read as a child and as a coordinator.
  const issue = issueNumber(values.issue ?? (role === 'child' ? env.LNTT_ISSUE : undefined))
  const theme = values.theme ?? (role === 'coordinator' ? env.LNTT_THEME : undefined)
  const address: Address = { ...(issue === undefined ? {} : { issue }), ...(theme === undefined ? {} : { theme }) }
  const box = systemMailbox()
  const interval = seconds(values.interval, '--interval') ?? pollInterval()
  const timeoutMs = seconds(values.timeout, '--timeout')
  const target = writers(role, theme)
  // Whether a child that reports to this role is alive, read before the messages: one that
  // wrote and went away in between is read on the next look, never lost.
  const alive = () => target === null || liveChildren(box.dir, target, liveBranches(box.dir)).length > 0
  const print = (list: Message[]) => {
    for (const message of list) stdout.write(`${line(message)}\n`)
  }
  const began = Date.now()
  // The sleep never runs past the deadline: a --timeout shorter than the interval ends on time.
  const nap = () => {
    const left = timeoutMs === undefined ? interval : timeoutMs - (Date.now() - began)
    if (left <= 0) return false
    box.sleep(Math.min(interval, left))
    return true
  }
  if (!values.follow) {
    let said = false
    for (;;) {
      // Listing reads and changes nothing else: only a wait looks at who is alive.
      const writing = values.wait ? alive() : true
      const found = pending(box.dir, role, address)
      if (found.length > 0 || !values.wait) {
        print(found)
        return
      }
      if (!writing) throw new NoWriters(`no child reports to the ${role}`)
      if (!said) stderr.write(`lntt inbox: waiting for a message to the ${role}, polling every ${interval / 1000} s\n`)
      said = true
      if (!nap()) throw new Error(`no message to the ${role} in ${(timeoutMs as number) / 1000} s`)
    }
  }
  // What is in the directory when the follow starts is not new, answered or not; the
  // unanswered ones are printed as `inbox` prints them.
  const first = messages(box.dir, role, address)
  const seen = new Set(first.map((message) => message.id))
  print(first.filter((message) => !existsSync(answerPath(message))))
  stderr.write(`lntt inbox: following the ${role}'s mailbox, polling every ${interval / 1000} s\n`)
  for (;;) {
    const writing = alive()
    const fresh = messages(box.dir, role, address).filter((message) => !seen.has(message.id))
    for (const message of fresh) seen.add(message.id)
    print(fresh)
    if (!writing) throw new NoWriters(`no child reports to the ${role}`)
    if (!nap()) throw new Error(`followed the ${role}'s mailbox for ${(timeoutMs as number) / 1000} s`)
  }
}

export async function main(command: 'ask' | 'inbox' | 'answer', args: string[]): Promise<void> {
  try {
    if (command === 'ask') await ask(args)
    else if (command === 'inbox') inbox(args)
    else {
      const [id, reply, ...rest] = args
      if (!id || rest.length > 0) usage()
      stdout.write(`${answer(systemMailbox().dir, id, await text(reply))}\n`)
    }
  } catch (error) {
    if (error instanceof Exit) throw error
    if (error instanceof NoWriters) {
      stderr.write(`lntt ${command}: ${error.message}\n`)
      exit(NO_WRITER_EXIT)
    }
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    stderr.write(`lntt ${command}: ${(error as Error).message}\n`)
    exit(1)
  }
}
