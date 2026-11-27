// The rules of the agents' mailbox (src/messages/mailbox.ts), as plain functions: where a message
// lives, its name, the marker of who a branch reports to, the worktrees git lists. No Effect and no
// node: here, so `lntt ask`'s parser (src/messages-cli.ts) loads none of it before it runs.
//
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.md          the question
//   <git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.answer.md   the answer
//   <git common dir>/lntt-messages/started/<branch, URL-encoded>.json               who a branch reports to

import { slugify } from '../branch.ts'

export const ROLES = ['orchestrator', 'coordinator', 'child'] as const
export type Role = (typeof ROLES)[number]

// The poll of the files in use when the mailbox was written by hand.
export const POLL_MS = 20_000

// A marker is written just before its worktree is created: one younger than this is a start in
// progress, live and never cleared, whatever git lists.
export const START_GRACE_MS = 60_000

export interface Message {
  id: string
  topic: string
  to: string
  path: string
  question: string
}

// Who exactly: a child by its issue (to-child-<issue>), a coordinator by its theme
// (to-coordinator-<theme>), since several of each run in one repository. Without it, the role's own
// directory. In a message sent to the orchestrator or a coordinator, the issue says which child it
// is about: the topic carries it (issue-<n>-<topic>), and the directory stays the role's.
export interface Address {
  issue?: number
  theme?: string
}

// Who a branch started by `lntt worktree start` reports to: its coordinator (by theme) or the
// orchestrator (with its issue). `lntt review` reads it at the limit to send what is open there.
// A coordinator's own branch reports to the orchestrator, on no issue.
export interface Started {
  branch: string
  issue: number | null
  to: 'coordinator' | 'orchestrator'
  theme?: string
}

// The mailbox a marker writes to: the orchestrator's, or a coordinator's (of one theme, or of any
// with no theme).
export interface Target {
  to: 'coordinator' | 'orchestrator'
  theme?: string
}

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MESSAGE = /^(\d{8}-\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/

export const join = (...parts: string[]) => parts.join('/')
export const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/'
export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function asRole(role: string): Role {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new Error(`a message goes to the ${ROLES.slice(0, -1).join(', ')} or ${ROLES.at(-1)}, not ${role}`)
  }
  return role as Role
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

// Local time, as `date +%Y%m%d-%H%M%S` writes it in the files already in use.
export function stamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
  return `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
}

// Where a question goes and the topic it carries: the question trimmed, its topic (given, else the
// first words of the question, cut to 40 characters), tagged with the issue when it goes to the
// orchestrator or a coordinator; the directory of the role, narrowed to a child by its issue.
export function addressed(
  root: string,
  to: string,
  question: string,
  options: { topic?: string } & Address = {},
): { text: string; topic: string; to: Role; directory: string } {
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
  const role = asRole(to)
  const child = role === 'child'
  const tag = `issue-${issue}-`
  const tagged = issue === undefined || child || topic.startsWith(tag) ? topic : `${tag}${topic}`
  const directory = messageDirectory(root, to, {
    ...(issue !== undefined && child ? { issue } : {}),
    ...(theme === undefined ? {} : { theme }),
  })
  return { text, topic: tagged, to: role, directory }
}

// The id of the attempt-th message of a topic in one second: the second gets `-2`, and so on.
export const messageId = (when: string, topic: string, attempt: number) =>
  `${when}-${topic}${attempt === 1 ? '' : `-${attempt}`}`

// An id as given, with or without the .md of its file; null when it is not a message's name (an
// answer, a path that climbs out of the mailbox).
export function messageName(raw: string): string | null {
  const id = raw.replace(/\.md$/, '')
  return MESSAGE.test(`${id}.md`) ? id : null
}

// The message a file of a role's directory holds, null for a file that is not one (notes, answers,
// temporary files).
export function messageOf(directory: string, name: string, role: string, text: string): Message | null {
  const match = MESSAGE.exec(name)
  if (match === null) return null
  return {
    id: name.replace(/\.md$/, ''),
    topic: match[2] as string,
    to: role,
    path: join(directory, name),
    question: text.trim(),
  }
}

export const isMessageName = (name: string) => MESSAGE.test(name)

export const answerPath = (message: { path: string }) => message.path.replace(/\.md$/, '.answer.md')

// The role of to-<role> or to-<role>-<who>: the directory says who, the role is the word.
export const roleOfDirectory = (directory: string): Role | undefined =>
  ROLES.find((role) => directory === `to-${role}` || directory.startsWith(`to-${role}-`))

// URL-encoded, so two branches never share a file (feat/84-x and feat-84/x included).
export const startedFile = (root: string, branch: string) => join(root, 'started', `${encodeURIComponent(branch)}.json`)

// The branch a file of started/ names, null when its name is not one.
export function branchOfMarker(name: string): string | null {
  if (!name.endsWith('.json')) return null
  try {
    return decodeURIComponent(name.slice(0, -'.json'.length))
  } catch {
    return null
  }
}

// The marker a file holds, when it is the branch's own and says who, exactly; null otherwise.
export function markerOf(text: string, branch: string): Started | null {
  try {
    const marker = JSON.parse(text) as Started
    if (marker.branch !== branch || !['coordinator', 'orchestrator'].includes(marker.to)) return null
    if (marker.to === 'coordinator' && (typeof marker.theme !== 'string' || !SLUG.test(marker.theme))) return null
    if (marker.issue !== null && !Number.isInteger(marker.issue)) return null
    return marker
  } catch {
    return null
  }
}

// Whether a live marker writes to a mailbox.
export const writesTo = (marker: Started, target: Target) =>
  marker.to === target.to && (target.theme === undefined || marker.theme === target.theme)

// The worktrees `git worktree list --porcelain` lists, with the branch each has checked out.
export function worktreesOf(listing: string): { path: string; branch: string }[] {
  const found: { path: string; branch: string }[] = []
  for (const block of listing.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (path !== undefined && branch !== undefined) found.push({ path, branch })
  }
  return found
}

// The message the limit of `lntt review` sent for a branch: its topic, and its first line names
// the branch.
export const isLimitOf = (message: Message, branch: string) =>
  /(^|-)review-limit(-\d+)?$/.test(message.topic) &&
  (message.question.split('\n')[0] ?? '').split(' ').slice(0, 2).includes(`${branch}:`)
