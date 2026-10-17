// The mailbox of the agents of one repository: a question is a file, its answer is a
// file next to it, and nothing else is needed, so it works on any host (Orca, Herdr,
// plain git) and between sessions of any agent.
//
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.md          the question
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.answer.md   the answer
//
// The git common directory is shared by every worktree of the repository and is not
// part of any of them: nothing here is ever committed.

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
// role's own directory.
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
  const temporary = join(dirname(path), `.${basename(path)}.tmp`)
  writeFileSync(temporary, text)
  try {
    linkSync(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(temporary)
  }
}

export function send(box: Mailbox, to: string, question: string, options: { topic?: string } & Address = {}): Message {
  const text = question.trim()
  if (text === '') throw new Error('the question is empty')
  const topic =
    options.topic ??
    slugify(text.split('\n')[0] ?? '')
      .slice(0, 40)
      .replace(/-+$/, '')
  if (!SLUG.test(topic)) throw new Error(`the topic ${topic || '(none)'} is not a slug: a-z, 0-9, -`)
  const directory = messageDirectory(box.dir, to, options)
  mkdirSync(directory, { recursive: true })
  const when = stamp(box.now())
  for (let attempt = 1; ; attempt += 1) {
    const id = `${when}-${topic}${attempt === 1 ? '' : `-${attempt}`}`
    const path = join(directory, `${id}.md`)
    if (publish(path, `${text}\n`)) return { id, topic, to: asRole(to), path, question: text }
  }
}

// Every message of every directory with this id, answered or not.
function locate(root: string, raw: string): string[] {
  const id = raw.replace(/\.md$/, '')
  if (!existsSync(root) || id.endsWith('.answer')) return []
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
    .filter((message) => !existsSync(answerPath(message)))
    .sort((a, b) => a.id.localeCompare(b.id))
}
