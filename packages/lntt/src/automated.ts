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

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Result } from './check.ts'
import { loadConfig } from './index.ts'

export interface Automated {
  author: string
  branch: string
  runs: 'after-approval' | 'always'
  ci: 'full' | 'minimal'
}

export const AUTOMATED_MARKER = '# lntt sync: delivery.automated'
const WORKFLOWS = '.github/workflows'
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

interface Marked {
  path: string
  line: number
  text: string
  synced: string
}

function marked(root: string, entries: Automated[]): Marked[] {
  let files: string[]
  try {
    files = readdirSync(join(root, WORKFLOWS))
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
  } catch {
    return []
  }
  return files.flatMap((file) => {
    const path = `${WORKFLOWS}/${file}`
    return readFileSync(join(root, path), 'utf8')
      .split('\n')
      .flatMap((text, i) => {
        const m = LINE.exec(text)
        return m ? [{ path, line: i + 1, text, synced: `${m[1]}${automatedLine(m[2] as string, entries)}` }] : []
      })
  })
}

// Rewrites the marked lines that differ; returns the files it wrote.
export function syncAutomated(root: string, data: Record<string, unknown> = loadConfig(root).data): string[] {
  const stale = marked(root, automatedEntries(data)).filter((m) => m.text !== m.synced)
  const files = [...new Set(stale.map((m) => m.path))]
  for (const path of files) {
    const lines = readFileSync(join(root, path), 'utf8').split('\n')
    for (const m of stale.filter((s) => s.path === path)) lines[m.line - 1] = m.synced
    writeFileSync(join(root, path), lines.join('\n'))
  }
  return files
}

export function checkAutomated(root: string, data: Record<string, unknown> = loadConfig(root).data): Result[] {
  const lines = marked(root, automatedEntries(data))
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
