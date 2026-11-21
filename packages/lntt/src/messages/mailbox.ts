// The mailbox of the agents of one repository on Effect (docs/adr/effect-in-lntt.md): a question
// is a file, its answer is a file next to it, and nothing else is needed, so it works on any host
// (Orca, Herdr, plain git) and between sessions of any agent. Its rules are plain
// (src/messages/rules.ts); the files go through Effect's FileSystem, the time through the Clock,
// the worktrees through Git. The git common directory, where the mailbox lives, is shared by every
// worktree of the repository and is part of none of them: nothing here is ever committed.

import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import * as Random from 'effect/Random'
import { type BranchRules, fromToolName } from '../branch.ts'
import { Git } from '../git/git.ts'
import {
  type Address,
  addressed,
  answerPath,
  basename,
  branchOfMarker,
  dirname,
  isLimitOf,
  join,
  type Message,
  markerOf,
  messageDirectory,
  messageId,
  messageName,
  messageOf,
  POLL_MS,
  roleOfDirectory,
  START_GRACE_MS,
  type Started,
  stamp,
  startedFile,
  type Target,
  worktreesOf,
  writesTo,
} from './rules.ts'

// What the mailbox refuses or cannot do: reported by its message, exit 1.
export class MailboxFailed extends Data.TaggedError('MailboxFailed')<{ message: string }> {}

// No child reports to an inbox that waits for one: exit 3.
export class NoWriters extends Data.TaggedError('NoWriters')<{ message: string }> {}

// The plain rules, what they throw a MailboxFailed.
const plain = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => new MailboxFailed({ message: error instanceof Error ? error.message : String(error) }),
  })

// Where the mailbox is: <git common dir>/lntt-messages, or the directory LNTT_MESSAGES_DIR names
// (read at the edge, src/messages-cli.ts).
export class Mailbox extends Context.Service<Mailbox, { readonly root: Effect.Effect<string, MailboxFailed> }>()(
  '@lntt/lntt/messages/mailbox/Mailbox',
) {
  // A mailbox at `root`, for a spec; a MailboxFailed for one that cannot be found.
  static at(root: string | MailboxFailed) {
    return Layer.succeed(Mailbox)(
      Mailbox.of({ root: typeof root === 'string' ? Effect.succeed(root) : Effect.fail(root) }),
    )
  }
}

// The mailbox of the repository Git works in, found once; `dir` replaces it when given.
export const mailboxIn = (dir: string | undefined) =>
  Layer.effect(Mailbox)(
    Effect.gen(function* () {
      const git = yield* Git
      const root = yield* Effect.cached(
        dir
          ? Effect.succeed(dir)
          : git.commonDir.pipe(
              Effect.map((common) => `${common}/lntt-messages`),
              Effect.mapError(
                () =>
                  new MailboxFailed({
                    message:
                      'the mailbox lives in the git common directory: run this inside a git repository (git 2.31 or later)',
                  }),
              ),
            ),
      )
      return Mailbox.of({ root })
    }),
  )

export const mailboxRoot = Effect.flatMap(Mailbox, (mailbox) => mailbox.root)

const files = FileSystem.FileSystem

// A name of its own for a temporary file next to `path`.
const temporary = (path: string) =>
  Effect.map(Random.next, (n) => join(dirname(path), `.${basename(path)}.${n.toString(36).slice(2)}.tmp`))

// The text is written whole under a temporary name, then linked to its own: a poller never reads
// half of it, and a name that is taken is never overwritten. False when it is taken.
const publish = Effect.fnUntraced(function* (path: string, text: string) {
  const fs = yield* files
  const scratch = yield* temporary(path)
  return yield* fs.writeFileString(scratch, text).pipe(
    Effect.andThen(fs.link(scratch, path)),
    Effect.as(true),
    Effect.catchTag('PlatformError', (error) =>
      error.reason._tag === 'AlreadyExists' ? Effect.succeed(false) : Effect.fail(error),
    ),
    Effect.ensuring(fs.remove(scratch, { force: true }).pipe(Effect.ignore)),
  )
})

export const send = Effect.fnUntraced(function* (
  root: string,
  to: string,
  question: string,
  options: { topic?: string } & Address = {},
): Effect.fn.Return<Message, MailboxFailed | PlatformError, FileSystem.FileSystem> {
  const where = yield* plain(() => addressed(root, to, question, options))
  yield* (yield* files).makeDirectory(where.directory, { recursive: true })
  const when = stamp(new Date(yield* Clock.currentTimeMillis))
  for (let attempt = 1; ; attempt += 1) {
    const id = messageId(when, where.topic, attempt)
    const path = join(where.directory, `${id}.md`)
    if (yield* publish(path, `${where.text}\n`)) {
      return { id, topic: where.topic, to: where.to, path, question: where.text }
    }
  }
})

// The role directories of the mailbox, as names.
const directories = Effect.fnUntraced(function* (root: string) {
  const fs = yield* files
  if (!(yield* fs.exists(root))) return []
  const names = yield* fs.readDirectory(root)
  return yield* Effect.filter(
    names.filter((name) => name.startsWith('to-')),
    (name) => Effect.map(fs.stat(join(root, name)), (info) => info.type === 'Directory'),
  )
})

// Every message of every directory with this id, answered or not.
export const locate = Effect.fnUntraced(function* (root: string, raw: string) {
  const id = messageName(raw)
  if (id === null) return []
  const fs = yield* files
  return yield* Effect.filter(
    (yield* directories(root)).map((name) => join(root, name, `${id}.md`)),
    (path) => fs.exists(path),
  )
})

// The one message an id names.
const only = Effect.fnUntraced(function* (root: string, raw: string) {
  const found = yield* locate(root, raw)
  if (found.length === 0) return yield* new MailboxFailed({ message: `no message ${raw} in ${root}` })
  if (found.length > 1) {
    return yield* new MailboxFailed({ message: `${raw} names more than one message: ${found.join(', ')}` })
  }
  return found[0] as string
})

export const answer = Effect.fnUntraced(function* (root: string, id: string, text: string) {
  const body = text.trim()
  if (body === '') return yield* new MailboxFailed({ message: 'the answer is empty' })
  const path = answerPath({ path: yield* only(root, id) })
  if (!(yield* publish(path, `${body}\n`))) return yield* new MailboxFailed({ message: `${id} is already answered` })
  return path
})

// A message already sent, by its id: the one `lntt review` sends at its limit, or one whose wait
// was cut short by a timeout.
export const sentMessage = Effect.fnUntraced(function* (root: string, raw: string) {
  const path = yield* only(root, raw)
  const id = raw.replace(/\.md$/, '')
  const to = roleOfDirectory(basename(dirname(path)))
  if (to === undefined) return yield* new MailboxFailed({ message: `${path} is not in a role's directory` })
  const question = (yield* (yield* files).readFileString(path)).trim()
  return { id, topic: id.replace(/^\d{8}-\d{6}-/, ''), to, path, question } satisfies Message
})

// The answer's text, as written. Waits forever without a timeout: the person may be away.
export const waitForAnswer = Effect.fnUntraced(function* (
  message: Message,
  options: { intervalMs?: number; timeoutMs?: number } = {},
) {
  const fs = yield* files
  const interval = options.intervalMs ?? POLL_MS
  const path = answerPath(message)
  for (let waited = 0; ; waited += interval) {
    if (yield* fs.exists(path)) return yield* fs.readFileString(path)
    if (options.timeoutMs !== undefined && waited >= options.timeoutMs) {
      return yield* new MailboxFailed({
        message: `no answer to ${message.id} in ${options.timeoutMs / 1000} s; the message is still at ${message.path}`,
      })
    }
    yield* Effect.sleep(Duration.millis(interval))
  }
})

// Every message of a role, answered or not, oldest first.
export const messages = Effect.fnUntraced(function* (root: string, role: string, address: Address = {}) {
  const fs = yield* files
  const directory = yield* plain(() => messageDirectory(root, role, address))
  if (!(yield* fs.exists(directory))) return []
  const found: Message[] = []
  for (const name of yield* fs.readDirectory(directory)) {
    const read = messageOf(directory, name, role, '')
    if (read === null) continue
    found.push({ ...read, question: (yield* fs.readFileString(read.path)).trim() })
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
})

// The messages of a role with no answer yet, oldest first.
export const pending = Effect.fnUntraced(function* (root: string, role: string, address: Address = {}) {
  const fs = yield* files
  return yield* Effect.filter(yield* messages(root, role, address), (message) =>
    Effect.map(fs.exists(answerPath(message)), (answered) => !answered),
  )
})

// Whole or not at all, replacing the marker of an earlier start of the branch.
export const recordStarted = Effect.fnUntraced(function* (root: string, marker: Started) {
  const fs = yield* files
  const file = startedFile(root, marker.branch)
  yield* fs.makeDirectory(dirname(file), { recursive: true })
  const scratch = yield* temporary(file)
  yield* fs
    .writeFileString(scratch, `${JSON.stringify(marker)}\n`)
    .pipe(
      Effect.andThen(fs.rename(scratch, file)),
      Effect.ensuring(fs.remove(scratch, { force: true }).pipe(Effect.ignore)),
    )
})

// Drops the marker of a start that failed, so nothing reads it as a coordinator.
export const forgetStarted = (root: string, branch: string) =>
  Effect.flatMap(files, (fs) => fs.remove(startedFile(root, branch), { force: true }))

// Null for a branch with no marker, or with one that is not its own or cannot be read.
export const startedBy = Effect.fnUntraced(function* (root: string, branch: string) {
  const text = yield* (yield* files).readFileString(startedFile(root, branch)).pipe(Effect.option)
  return text._tag === 'Some' ? markerOf(text.value, branch) : null
})

// The branches checked out in a worktree that exists on disk: a worktree whose folder was deleted
// is still listed by git until it is pruned, and it is not a live one. `alias` adds the other name
// a branch answers to: a worktree still on the name Orca gave it has the marker of its
// conventional name.
export const checkedOutBranches = Effect.fnUntraced(function* (
  gitDir: string,
  alias: (branch: string) => string | null = () => null,
) {
  const fs = yield* files
  const listing = yield* (yield* Git).worktrees(gitDir).pipe(
    Effect.mapError(
      () =>
        new MailboxFailed({
          message: `cannot list the worktrees of ${gitDir}: the mailbox must be in a git common directory`,
        }),
    ),
  )
  const branches = new Set<string>()
  for (const { path, branch } of worktreesOf(listing)) {
    if (!(yield* fs.exists(path))) continue
    branches.add(branch)
    const other = alias(branch)
    if (other !== null) branches.add(other)
  }
  return branches
})

// The live children that report to a mailbox: the markers of `started/` addressed to it whose
// branch is checked out in a worktree that exists, or that is younger than START_GRACE_MS by the
// Clock. The marker of a worktree that is gone is cleared here, so `started/` lists only live
// children (a read that deletes). The worktrees are looked at only when there is a marker.
// `lntt inbox --wait` and `--follow` end when this is empty.
export const liveChildren = Effect.fnUntraced(function* <E, R>(
  root: string,
  target: Target,
  worktrees: Effect.Effect<Set<string>, E, R>,
) {
  const fs = yield* files
  const directory = join(root, 'started')
  if (!(yield* fs.exists(directory))) return []
  const names = (yield* fs.readDirectory(directory)).filter((name) => name.endsWith('.json'))
  if (names.length === 0) return []
  const checked = yield* worktrees
  const live: Started[] = []
  for (const name of names) {
    const branch = branchOfMarker(name)
    if (branch === null) continue
    const marker = yield* startedBy(root, branch)
    if (marker === null) continue
    if (!checked.has(branch)) {
      const info = yield* fs.stat(join(directory, name)).pipe(Effect.option)
      if (info._tag === 'None' || info.value.mtime._tag === 'None') continue
      if ((yield* Clock.currentTimeMillis) - info.value.mtime.value.getTime() >= START_GRACE_MS) {
        yield* forgetStarted(root, branch)
        continue
      }
    }
    if (writesTo(marker, target)) live.push(marker)
  }
  return live
})

// Who the branch reports to, when `lntt worktree start` started it; null otherwise, and when the
// mailbox cannot be found or read. A branch still on the name Orca gave it
// (`<user>/<type>-<issue>-<slug>`, until `lntt branch rename`) has the marker of its
// conventional name.
export const reportsTo = (branch: string, rules: BranchRules) =>
  Effect.gen(function* () {
    const root = yield* mailboxRoot
    const conventional = fromToolName(branch, rules)
    return (
      (yield* startedBy(root, branch)) ??
      (conventional !== null && conventional !== branch ? yield* startedBy(root, conventional) : null)
    )
  }).pipe(Effect.orElseSucceed(() => null))

export type Asked = { id: string; to: string; path: string }

// What is open goes to the coordinator or the orchestrator as a message the round does not wait
// for: it holds the review lock, and `lntt review allow` must stay possible while the answer is
// awaited. A limit already sent and not yet answered is not sent again: its id is the one to wait
// on. `asked` is null when the message cannot be written, which `line` says.
export const askAtLimit = (marker: Started, branch: string, text: string) => {
  const who = marker.to === 'coordinator' ? `the coordinator ${marker.theme}` : 'the orchestrator'
  const address = {
    ...(marker.to === 'coordinator' ? { theme: marker.theme as string } : {}),
    ...(marker.issue === null ? {} : { issue: marker.issue }),
  }
  return Effect.gen(function* () {
    const root = yield* mailboxRoot
    const inbox = yield* pending(root, marker.to, marker.to === 'coordinator' ? { theme: marker.theme as string } : {})
    const earlier = inbox.find((message) => isLimitOf(message, branch))
    const sent = earlier ?? (yield* send(root, marker.to, text, { topic: 'review-limit', ...address }))
    return {
      asked: { id: sent.id, to: marker.to, path: sent.path } as Asked | null,
      line: `limit: ${earlier ? 'already sent' : 'sent'} ${sent.id} to ${who}; wait with: pnpm exec lntt ask --wait ${sent.id}`,
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ asked: null as Asked | null, line: `limit: could not send to ${who}: ${error.message}` }),
    ),
  )
}
