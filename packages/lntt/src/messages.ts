// The mailbox of the agents of one repository: a question is a file, its answer is a
// file next to it, and nothing else is needed, so it works on any host (Orca, Herdr,
// plain git) and between sessions of any agent.
//
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.md          the question
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.answer.md   the answer
//   <git common dir>/lntt-messages/started/<branch, URL-encoded>.json               who a branch reports to
//
// The git common directory is shared by every worktree of the repository and is not
// part of any of them: nothing here is ever committed.

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { slugify } from './branch.ts'

export const ROLES = ['orchestrator', 'coordinator', 'child'] as const
export type Role = (typeof ROLES)[number]

// The poll of the files in use when the mailbox was written by hand.
export const POLL_MS = 20_000

// The clock and the sleep are the caller's, so a test waits on a fake one.
export interface Mailbox {
  dir: string
  now(): Date
  sleep(ms: number): void
}

export interface Message {
  id: string
  topic: string
  to: string
  path: string
  question: string
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MESSAGE = /^(\d{8}-\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

function asRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new Error(`a message goes to the ${ROLES.slice(0, -1).join(', ')} or ${ROLES.at(-1)}, not ${role}`)
  }
  return role as Role
}

// Who exactly: a child by its issue (to-child-<issue>), a coordinator by its theme
// (to-coordinator-<theme>), since several of each run in one repository. Without it, the
// role's own directory. In a message sent to the orchestrator or a coordinator, the issue
// says which child it is about: send() puts it in the topic (issue-<n>-<topic>), and the
// directory stays the role's.
export interface Address {
  issue?: number
  theme?: string
}

export function messageDirectory(root: string, role: string, address: Address = {}): string {
  asRole(role)
  if (address.issue !== undefined && role !== 'child') throw new Error('--issue narrows only a child')
  if (address.theme !== undefined && role !== 'coordinator') throw new Error('--theme narrows only a coordinator')
  if (address.theme !== undefined && !SLUG.test(address.theme))
    throw new Error(`the theme ${address.theme} is not a slug`)
  const who = address.issue ?? address.theme
  return join(root, who === undefined ? `to-${role}` : `to-${role}-${who}`)
}

function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
  return `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

// The text is written whole under a temporary name, then linked to its own: a poller
// never reads half of it, and a name that is taken is never overwritten.
function publish(path: string, text: string): boolean {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text)
    linkSync(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function send(box: Mailbox, to: string, question: string, options: { topic?: string } & Address = {}): Message {
  const text = question.trim()
  if (text === '') throw new Error('the question is empty')
  const topic =
    options.topic ??
    (slugify(text.split('\n')[0] ?? '')
      .slice(0, 40)
      .replace(/-+$/, '') ||
      'message')
  if (!SLUG.test(topic)) throw new Error(`the topic ${topic || '(none)'} is not a slug: a-z, 0-9, -`)
  const { issue, theme } = options
  const child = asRole(to) === 'child'
  const tag = `issue-${issue}-`
  const tagged = issue === undefined || child || topic.startsWith(tag) ? topic : `${tag}${topic}`
  const directory = messageDirectory(box.dir, to, {
    ...(issue !== undefined && child ? { issue } : {}),
    ...(theme === undefined ? {} : { theme }),
  })
  mkdirSync(directory, { recursive: true })
  const when = stamp(box.now())
  for (let attempt = 1; ; attempt += 1) {
    const id = `${when}-${tagged}${attempt === 1 ? '' : `-${attempt}`}`
    const path = join(directory, `${id}.md`)
    if (publish(path, `${text}\n`)) return { id, topic: tagged, to: asRole(to), path, question: text }
  }
}

// Every message of every directory with this id, answered or not.
export function locate(root: string, raw: string): string[] {
  const id = raw.replace(/\.md$/, '')
  if (!existsSync(root) || !MESSAGE.test(`${id}.md`)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('to-'))
    .map((entry) => join(root, entry.name, `${id}.md`))
    .filter((path) => existsSync(path))
}

export function answer(root: string, id: string, text: string): string {
  const body = text.trim()
  if (body === '') throw new Error('the answer is empty')
  const found = locate(root, id)
  if (found.length === 0) throw new Error(`no message ${id} in ${root}`)
  if (found.length > 1) throw new Error(`${id} names more than one message: ${found.join(', ')}`)
  const path = (found[0] as string).replace(/\.md$/, '.answer.md')
  if (!publish(path, `${body}\n`)) throw new Error(`${id} is already answered`)
  return path
}

export function answerPath(message: Message): string {
  return message.path.replace(/\.md$/, '.answer.md')
}

// The answer's text, as written. Waits forever without a timeout: the person may be away.
export function waitForAnswer(
  box: Mailbox,
  message: Message,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): string {
  const interval = options.intervalMs ?? POLL_MS
  let waited = 0
  for (;;) {
    const path = answerPath(message)
    if (existsSync(path)) return readFileSync(path, 'utf8')
    if (options.timeoutMs !== undefined && waited >= options.timeoutMs) {
      throw new Error(
        `no answer to ${message.id} in ${options.timeoutMs / 1000} s; the message is still at ${message.path}`,
      )
    }
    box.sleep(interval)
    waited += interval
  }
}

// The messages of a role with no answer yet, oldest first. Files that are not messages
// (notes, answers, temporary files) are not listed.
export function pending(root: string, role: string, address: Address = {}): Message[] {
  return messages(root, role, address).filter((message) => !existsSync(answerPath(message)))
}

// Every message of a role, answered or not, oldest first.
export function messages(root: string, role: string, address: Address = {}): Message[] {
  const directory = messageDirectory(root, role, address)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .map((name) => ({ name, match: MESSAGE.exec(name) }))
    .filter((entry) => entry.match !== null)
    .map(({ name, match }) => {
      const path = join(directory, name)
      const id = name.replace(/\.md$/, '')
      return {
        id,
        topic: (match as RegExpExecArray)[2] as string,
        to: role,
        path,
        question: readFileSync(path, 'utf8').trim(),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Who a branch started by `lntt worktree start` reports to: its coordinator (by theme) or
// the orchestrator (with its issue). `lntt review` reads it at the limit to send what is
// open there. A coordinator's own branch reports to the orchestrator, on no issue.
export interface Started {
  branch: string
  issue: number | null
  to: 'coordinator' | 'orchestrator'
  theme?: string
}

// URL-encoded, so two branches never share a file (feat/84-x and feat-84/x included).
const startedFile = (root: string, branch: string) => join(root, 'started', `${encodeURIComponent(branch)}.json`)

// Whole or not at all, replacing the marker of an earlier start of the branch.
export function recordStarted(root: string, marker: Started): void {
  const file = startedFile(root, marker.branch)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(marker)}\n`)
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

// Drops the marker of a start that failed, so nothing reads it as a coordinator.
export function forgetStarted(root: string, branch: string): void {
  rmSync(startedFile(root, branch), { force: true })
}

// Null for a branch with no marker, or with one that is not its own or cannot be read.
export function startedBy(root: string, branch: string): Started | null {
  const file = startedFile(root, branch)
  if (!existsSync(file)) return null
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8')) as Started
    if (marker.branch !== branch || !['coordinator', 'orchestrator'].includes(marker.to)) return null
    if (marker.to === 'coordinator' && (typeof marker.theme !== 'string' || !SLUG.test(marker.theme))) return null
    if (marker.issue !== null && !Number.isInteger(marker.issue)) return null
    return marker
  } catch {
    return null
  }
}

// The mailbox a marker writes to: the orchestrator's, or a coordinator's (of one theme, or
// of any with no theme).
export interface Target {
  to: 'coordinator' | 'orchestrator'
  theme?: string
}

// The branches checked out in a worktree that exists on disk: a worktree whose folder was
// deleted is still listed by git until it is pruned, and it is not a live one.
// `alias` adds the other name a branch answers to: a worktree still on the name Orca gave it
// has the marker of its conventional name.
export function checkedOutBranches(gitDir: string, alias: (branch: string) => string | null = () => null): Set<string> {
  let listing: string
  try {
    listing = execFileSync('git', ['--git-dir', gitDir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error(`cannot list the worktrees of ${gitDir}: the mailbox must be in a git common directory`)
  }
  const branches = new Set<string>()
  for (const block of listing.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (path === undefined || branch === undefined || !existsSync(path)) continue
    branches.add(branch)
    const other = alias(branch)
    if (other !== null) branches.add(other)
  }
  return branches
}

// A marker is written just before its worktree is created: one younger than this is a start
// in progress, live and never cleared, whatever git lists.
export const START_GRACE_MS = 60_000

// The live children that report to a mailbox: the markers of `started/` addressed to it
// whose branch is checked out in a worktree that exists, or that is younger than
// START_GRACE_MS. The marker of a worktree that is gone is cleared here, so `started/` lists
// only live children (a read that deletes). `now` is the clock, in milliseconds.
// `lntt inbox --wait` and `--follow` end when this is empty.
export function liveChildren(
  root: string,
  target: Target,
  worktrees: Set<string> | (() => Set<string>) = () => checkedOutBranches(dirname(root)),
  now: number = Date.now(),
): Started[] {
  const directory = join(root, 'started')
  if (!existsSync(directory)) return []
  const names = readdirSync(directory).filter((name) => name.endsWith('.json'))
  if (names.length === 0) return []
  const checked = typeof worktrees === 'function' ? worktrees() : worktrees
  const live: Started[] = []
  for (const name of names) {
    let branch: string
    try {
      branch = decodeURIComponent(name.slice(0, -'.json'.length))
    } catch {
      continue
    }
    const marker = startedBy(root, branch)
    if (marker === null) continue
    if (!checked.has(branch)) {
      const modified = statSync(join(directory, name), { throwIfNoEntry: false })?.mtimeMs ?? 0
      if (now - modified >= START_GRACE_MS) {
        forgetStarted(root, branch)
        continue
      }
    }
    if (marker.to !== target.to) continue
    if (target.theme !== undefined && marker.theme !== target.theme) continue
    live.push(marker)
  }
  return live
}
