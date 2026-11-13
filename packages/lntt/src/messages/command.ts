// `lntt ask`, `lntt inbox` and `lntt answer` on Effect (docs/adr/effect-in-lntt.md): the mailbox of
// src/messages/mailbox.ts from the command line. src/messages-cli.ts parses the arguments and reads
// the environment, then loads this module. A wait sleeps on the Clock, so an interrupt (SIGINT,
// SIGTERM) ends it at once, exit 130. src/messages/command.spec.ts runs it on in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Clock from 'effect/Clock'
import * as Console from 'effect/Console'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { branchRules, fromToolName } from '../branch.ts'
import { ProjectConfig, ProjectConfigLive } from '../config/load.ts'
import { exit } from '../exit.ts'
import { GitLive } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import {
  answer,
  checkedOutBranches,
  liveChildren,
  MailboxFailed,
  mailboxIn,
  mailboxRoot,
  messages,
  NoWriters,
  pending,
  send,
  sentMessage,
  waitForAnswer,
} from './mailbox.ts'
import { type Address, dirname, type Message, type Target } from './rules.ts'

// Exit code of an inbox that has no child left to wait for: not 1 (an error or a timeout), not 2
// (usage).
export const NO_WRITER_EXIT = 3

// A command as src/messages-cli.ts parsed it; the times in milliseconds.
export type MessagesCommand =
  | {
      kind: 'ask'
      to: string
      question: string
      topic?: string
      issue?: number
      theme?: string
      intervalMs: number
      timeoutMs?: number
    }
  | { kind: 'wait'; id: string; intervalMs: number; timeoutMs?: number }
  | {
      kind: 'inbox'
      role: string
      address: Address
      wait: boolean
      follow: boolean
      intervalMs: number
      timeoutMs?: number
    }
  | { kind: 'answer'; id: string; text: string }

const name = (parsed: MessagesCommand) => (parsed.kind === 'wait' ? 'ask' : parsed.kind)

function line(message: Message): string {
  return JSON.stringify({
    id: message.id,
    to: message.to,
    topic: message.topic,
    path: message.path,
    question: message.question,
  })
}

// The answer, ending with one newline: Console.log adds it, so one the file ends with is taken off.
const printAnswer = (text: string) => Console.log(text.endsWith('\n') ? text.slice(0, -1) : text)

// Writes the question, then polls for its answer; stdout is the answer. The wait is the point of
// the command: a caller that must not block runs it in the background. `wait`: only the wait, for
// a message already sent.
const ask = Effect.fnUntraced(function* (parsed: Extract<MessagesCommand, { kind: 'ask' | 'wait' }>) {
  const root = yield* mailboxRoot
  const every = `polling every ${parsed.intervalMs / 1000} s`
  let sent: Message
  if (parsed.kind === 'wait') {
    sent = yield* sentMessage(root, parsed.id)
    yield* Console.error(`lntt ask: waiting for the answer to ${sent.id}, ${every}`)
  } else {
    sent = yield* send(root, parsed.to, parsed.question, {
      ...(parsed.topic ? { topic: parsed.topic } : {}),
      ...(parsed.issue === undefined ? {} : { issue: parsed.issue }),
      ...(parsed.theme ? { theme: parsed.theme } : {}),
    })
    yield* Console.error(`lntt ask: ${sent.id} sent to ${sent.to}; waiting for the answer, ${every}`)
  }
  const timeout = parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }
  yield* printAnswer(yield* waitForAnswer(sent, { intervalMs: parsed.intervalMs, ...timeout }))
  return 0
})

// The children that can write to this inbox: the markers addressed to it. A child's inbox is
// written by whoever started it, and nothing says who is alive, so it has no target.
function writers(role: string, theme: string | undefined): Target | null {
  if (role === 'orchestrator') return { to: 'orchestrator' }
  if (role === 'coordinator') return { to: 'coordinator', ...(theme === undefined ? {} : { theme }) }
  return null
}

// The unanswered messages to a role, one JSON line each. With `wait`, nothing is printed until
// there is at least one, and the wait ends (exit 3) when no child reports to the role any more.
// With `follow`, those lines first, then one for each message that arrives, until no child
// reports to the role.
const inbox = Effect.fnUntraced(function* (parsed: Extract<MessagesCommand, { kind: 'inbox' }>) {
  const { role, address, intervalMs: interval, timeoutMs } = parsed
  const root = yield* mailboxRoot
  const target = writers(role, address.theme)
  // The branches in a worktree that exists, each also under its conventional name: a branch still
  // on the name Orca gave it (until `lntt branch rename`) has the marker of that one. An invalid
  // configuration is an error here as everywhere; a missing one gives the defaults.
  const worktrees = Effect.gen(function* () {
    const rules = branchRules(yield* (yield* ProjectConfig).data)
    return yield* checkedOutBranches(dirname(root), (branch) => fromToolName(branch, rules))
  })
  // Whether a child that reports to this role is alive, read before the messages: one that wrote
  // and went away in between is read on the next look, never lost.
  const alive =
    target === null
      ? Effect.succeed(true)
      : Effect.map(liveChildren(root, target, worktrees), (live) => live.length > 0)
  const print = (list: Message[]) => Effect.forEach(list, (message) => Console.log(line(message)), { discard: true })
  const began = yield* Clock.currentTimeMillis
  // The sleep never runs past the deadline: a timeout shorter than the interval ends on time.
  const nap = Effect.gen(function* () {
    const left = timeoutMs === undefined ? interval : timeoutMs - ((yield* Clock.currentTimeMillis) - began)
    if (left <= 0) return false
    yield* Effect.sleep(Duration.millis(Math.min(interval, left)))
    return true
  })
  const noWriters = new NoWriters({ message: `no child reports to the ${role}` })
  const every = `polling every ${interval / 1000} s`
  if (!parsed.follow) {
    let said = false
    for (;;) {
      // Listing reads and changes nothing else: only a wait looks at who is alive.
      const writing = parsed.wait ? yield* alive : true
      const found = yield* pending(root, role, address)
      if (found.length > 0 || !parsed.wait) {
        yield* print(found)
        return 0
      }
      if (!writing) return yield* noWriters
      if (!said) yield* Console.error(`lntt inbox: waiting for a message to the ${role}, ${every}`)
      said = true
      if (!(yield* nap))
        return yield* new MailboxFailed({ message: `no message to the ${role} in ${(timeoutMs as number) / 1000} s` })
    }
  }
  // What is in the directory when the follow starts is not new, answered or not; the unanswered
  // ones are printed as `inbox` prints them.
  const first = yield* messages(root, role, address)
  const seen = new Set(first.map((message) => message.id))
  yield* print(yield* pending(root, role, address))
  yield* Console.error(`lntt inbox: following the ${role}'s mailbox, ${every}`)
  for (;;) {
    const writing = yield* alive
    const fresh = (yield* messages(root, role, address)).filter((message) => !seen.has(message.id))
    for (const message of fresh) seen.add(message.id)
    yield* print(fresh)
    if (!writing) return yield* noWriters
    if (!(yield* nap))
      return yield* new MailboxFailed({
        message: `followed the ${role}'s mailbox for ${(timeoutMs as number) / 1000} s`,
      })
  }
})

// A command's exit code: 0, 3 for an inbox with no writer, 1 for any other expected failure,
// said by its message.
export const command = (parsed: MessagesCommand) => {
  const say = (code: number) => (error: { message: string }) =>
    Effect.as(Console.error(`lntt ${name(parsed)}: ${error.message}`), code)
  return Effect.gen(function* () {
    if (parsed.kind === 'ask' || parsed.kind === 'wait') return yield* ask(parsed)
    if (parsed.kind === 'inbox') return yield* inbox(parsed)
    yield* Console.log(yield* answer(yield* mailboxRoot, parsed.id, parsed.text))
    return 0
  }).pipe(
    Effect.catchTags({
      NoWriters: say(NO_WRITER_EXIT),
      MailboxFailed: say(1),
      PlatformError: say(1),
      ConfigInvalid: say(1),
    }),
  )
}

// The services on the machine; `dir` is LNTT_MESSAGES_DIR.
const live = (dir: string | undefined) =>
  mailboxIn(dir).pipe(
    Layer.provideMerge(Layer.mergeAll(GitLive, ProjectConfigLive)),
    Layer.provideMerge(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, Path.layer)),
  )

// Runs a command as the process's main program (src/run-command.ts): its exit code.
export function runMessages(parsed: MessagesCommand, dir: string | undefined): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(live(dir))))
}
