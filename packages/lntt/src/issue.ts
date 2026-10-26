// `lntt issue`: a report on Lunette itself (lntt, a shared skill, the scaffolder, a
// template), filed on the upstream repository from a draft the agent wrote and the dump
// of lntt dump. The retrospective skill drafts it from the items of a harvest marked with
// that repository (`[upstream:LunetteOrg/starter] …`); the operator reads the whole issue (a dry
// run, the default) and approves it, and only then is it sent (--send). The skill calls
// lntt issue, never gh, so another way to send it is added here without changing the
// skill (#184).

import type { Gh } from './ci/candidate.ts'
import { type Dump, renderDump } from './dump.ts'

// The fields of a report, in their order, each a `### <field>` heading as GitHub writes
// a submitted issue form, so a form added upstream can take them as they are.
export const ISSUE_SECTIONS = [
  'Project',
  'What happened',
  'Pull requests',
  'Proposal',
  'Harness',
  'Model',
  'Versions',
  'lntt dump',
] as const

// A refusal with a reason the person can act on: a draft missing a section, no upstream.
export class IssueError extends Error {}

// Where a report goes: cycle.retrospective.upstream.repository, always written in the
// configuration, never guessed (a fork or a private mirror sets its own).
export function upstreamRepository(config: {
  cycle?: { retrospective?: { upstream?: { repository?: string } } }
}): string {
  const configured = config.cycle?.retrospective?.upstream?.repository
  if (configured === undefined) {
    throw new IssueError(
      'no cycle.retrospective.upstream.repository in the configuration: the repository reports go to',
    )
  }
  return configured
}

// The repository the command runs in (GITHUB_REPOSITORY in Actions, else gh), or null when
// gh cannot tell: a report to it is no report, its items are handled here.
export function currentRepository(gh: Gh, env: Record<string, string | undefined>): string | null {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY
  try {
    return gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim() || null
  } catch {
    return null
  }
}

export const REPOSITORY = /^[\w.-]+\/[\w.-]+$/

export interface Draft {
  title: string
  whatHappened: string
  pullRequests: string
  proposal: string
}

const DRAFT_SECTIONS: [keyof Omit<Draft, 'title'>, string][] = [
  ['whatHappened', 'What happened'],
  ['pullRequests', 'Pull requests'],
  ['proposal', 'Proposal'],
]

// The draft: `# <title>`, then `## What happened`, `## Pull requests`, `## Proposal`.
export function parseDraft(text: string): Draft {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const first = lines.findIndex((l) => l.trim() !== '')
  const title = /^#\s+(.+)$/.exec(lines[first] ?? '')?.[1]?.trim()
  if (!title) throw new IssueError('the draft has no title: a first line "# <title>"')
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of lines.slice(first + 1)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = []
      sections.set((heading[1] as string).toLowerCase(), current)
    } else current?.push(line)
  }
  const draft: Partial<Draft> = { title }
  for (const [key, heading] of DRAFT_SECTIONS) {
    const body = sections.get(heading.toLowerCase())
    if (body === undefined) throw new IssueError(`the draft has no "## ${heading}" section`)
    const value = body.join('\n').trim()
    if (value === '') throw new IssueError(`"## ${heading}" is empty in the draft`)
    draft[key] = value
  }
  return draft as Draft
}

// The facts of a dump section, without their `key: ` prefix.
function facts(dump: Dump, title: string): Record<string, string> {
  const section = dump.sections.find((s) => s.title === title)
  return Object.fromEntries(
    (section?.lines ?? [])
      .map((l) => /^([\w ]+): (.*)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => [m[1] as string, m[2] as string]),
  )
}

export function issueBody(draft: Draft, dump: Dump, project: string): string {
  const template = facts(dump, 'Project').template
  const lntt = facts(dump, 'lntt')
  const runtime = facts(dump, 'Runtime')
  const versions = [
    `lntt ${lntt.version ?? dump.lntt}${lntt.installed ? ` (${lntt.installed})` : ''}`,
    ...(['Node', 'package manager', 'OS'] as const)
      .map((key) => (key === 'Node' && runtime[key] ? `Node ${runtime[key]}` : runtime[key]))
      .filter((v) => v !== undefined),
  ].join(', ')
  const values: Record<(typeof ISSUE_SECTIONS)[number], string> = {
    Project: template === undefined || template === 'none' ? project : `${project}, template ${template}`,
    'What happened': draft.whatHappened,
    'Pull requests': draft.pullRequests,
    Proposal: draft.proposal,
    Harness: dump.harness,
    Model: dump.model,
    Versions: versions,
    'lntt dump': `<details><summary>lntt dump</summary>\n\n${renderDump(dump)}\n</details>`,
  }
  return ISSUE_SECTIONS.map((name) => `### ${name}\n\n${values[name]}\n`).join('\n')
}

// The longest body GitHub takes, in characters: past it, --send would fail after the
// operator approved the report.
export const BODY_LIMIT = 65536
export const TITLE_LIMIT = 256

// Counted in characters, not UTF-16 units: an emoji is one.
export function bodyTooLong(title: string, body: string): string | null {
  const titleLength = [...title].length
  if (titleLength > TITLE_LIMIT)
    return `the title is ${titleLength} characters, GitHub takes ${TITLE_LIMIT}: shorten it`
  const length = [...body].length
  if (length <= BODY_LIMIT) return null
  return `the body is ${length} characters, GitHub takes ${BODY_LIMIT}: shorten the draft, or dump without the failing command`
}

export interface FoundIssue {
  number: number
  title: string
  url: string
}

// The open issues of the repository that match: before a draft, the one it would repeat.
export function searchIssues(gh: Gh, repo: string, words: string): FoundIssue[] {
  const out = gh.read([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--search',
    words,
    '--json',
    'number,title,url',
    '--limit',
    '20',
  ])
  return out === '' ? [] : (JSON.parse(out) as FoundIssue[])
}

export function fileIssue(gh: Gh, repo: string, title: string, body: string): string {
  return gh.write(['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], body)
}

export function commentIssue(gh: Gh, repo: string, number: number, body: string): string {
  return gh.write(['issue', 'comment', String(number), '--repo', repo, '--body-file', '-'], body)
}
