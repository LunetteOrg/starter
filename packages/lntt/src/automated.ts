// The pull requests a bot opens (`delivery.automated`): which ones, and how the CI treats
// them. One entry per bot: its login as the pull request event names it
// (`dependabot[bot]`), the prefix of its branches, when its CI runs (`after-approval` of
// the head by someone with write access, or `always`) and which CI (`full`, or
// the `minimal` one a pull request into a candidate runs). They stay on the base: the
// candidate automation leaves them there and the candidate guard lets them through.
//
// A workflow reads the entries before any checkout, where lntt cannot run: `lntt sync`
// writes them, minified, into every workflow line that ends with AUTOMATED_MARKER, and
// `lntt check workflows` fails when a line differs from the configuration.
//
// Plain logic, on the workflows' texts: src/sync/project.ts reads and writes them.

import type { Result } from './check/results.ts'

export interface Automated {
  author: string
  branch: string
  runs: 'after-approval' | 'always'
  ci: 'full' | 'minimal'
}

export const AUTOMATED_MARKER = '# lntt sync: delivery.automated'
export const WORKFLOWS = '.github/workflows'
// `  KEY: '<json>' # lntt sync: delivery.automated`: the indent and the key are the file's.
const LINE = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*): .* # lntt sync: delivery\.automated\s*$/

export function automatedEntries(data: Record<string, unknown>): Automated[] {
  return ((data.delivery as { automated?: Automated[] } | undefined)?.automated ?? []).map((entry) => ({ ...entry }))
}

// A bot's name with what gh or the GraphQL API add or drop: `app/<slug>` (gh pr view),
// `<slug>` (GraphQL), `<slug>[bot]` (the event).
function botName(login: string): string {
  return login.replace(/^app\//, '').replace(/\[bot\]$/, '')
}

// The entry of a pull request: its author and its branch prefix, both.
export function matchAutomated(
  entries: Automated[],
  { author, headRef }: { author?: string | undefined; headRef: string },
): Automated | null {
  if (!author) return null
  return entries.find((e) => botName(e.author) === botName(author) && headRef.startsWith(e.branch)) ?? null
}

// One line of YAML: the entries minified in single quotes, a quote doubled.
export function automatedLine(key: string, entries: Automated[]): string {
  const json = JSON.stringify(entries.map(({ author, branch, runs, ci }) => ({ author, branch, runs, ci })))
  return `${key}: '${json.replace(/'/g, "''")}' ${AUTOMATED_MARKER}`
}

// A workflow file of the project: its path from the root, and its text.
export interface Workflow {
  path: string
  text: string
}

interface Marked {
  path: string
  line: number
  text: string
  synced: string
}

// The workflow files lntt reads, `.yml` and `.yaml`, from the names in the directory, sorted.
export function workflowFiles(names: string[]): string[] {
  return names
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `${WORKFLOWS}/${f}`)
}

function marked(workflows: Workflow[], entries: Automated[]): Marked[] {
  return workflows.flatMap(({ path, text: file }) =>
    file.split('\n').flatMap((text, i) => {
      const m = LINE.exec(text)
      return m ? [{ path, line: i + 1, text, synced: `${m[1]}${automatedLine(m[2] as string, entries)}` }] : []
    }),
  )
}

// The workflows whose marked lines differ from the configuration, with those lines rewritten.
export function syncedWorkflows(workflows: Workflow[], data: Record<string, unknown>): Workflow[] {
  const stale = marked(workflows, automatedEntries(data)).filter((m) => m.text !== m.synced)
  return workflows.flatMap(({ path, text }) => {
    const lines = stale.filter((s) => s.path === path)
    if (lines.length === 0) return []
    const next = text.split('\n')
    for (const m of lines) next[m.line - 1] = m.synced
    return [{ path, text: next.join('\n') }]
  })
}

export function automatedResults(workflows: Workflow[], data: Record<string, unknown>): Result[] {
  const lines = marked(workflows, automatedEntries(data))
  const result = (status: Result['status'], path: string | null, line: number | null, message: string): Result => ({
    area: 'workflows',
    check: 'automated',
    status,
    path,
    line,
    message,
  })
  if (lines.length === 0) {
    return [result('NOT RUN', null, null, `no line of ${WORKFLOWS} ends with ${AUTOMATED_MARKER}`)]
  }
  return lines.map((m) =>
    m.text === m.synced
      ? result('PASS', m.path, m.line, 'the line holds delivery.automated as lntt sync writes it')
      : result('FAIL', m.path, m.line, 'the line differs from delivery.automated; run pnpm exec lntt sync'),
  )
}
