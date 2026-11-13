// What `lntt check` says, with no Effect and no node: module: every check says PASS, FAIL or NOT
// RUN with its reason; INFO is what a check prints without passing or failing (the diff
// inventory, the figures of a record). The areas, the options a check reads, the anchors of
// `cite`, and the text and JSON reports. Plain, so lntt review and the modules not yet on Effect
// read them without loading Effect.

export type Status = 'PASS' | 'FAIL' | 'NOT RUN' | 'INFO'

export interface Result {
  area: string
  check: string
  status: Status
  path: string | null
  line: number | null
  message: string
}

export const AREAS = ['agents-md', 'skills', 'plugin', 'workflows', 'decisions', 'tests', 'body'] as const
export type Area = (typeof AREAS)[number]

export function isArea(name: string): name is Area {
  return (AREAS as readonly string[]).includes(name)
}

// The checks of each area that can be named alone.
export const CHECKS: Record<Area, string[]> = {
  'agents-md': [],
  skills: [],
  plugin: [],
  workflows: ['automated'],
  decisions: ['structure', 'board-refs', 'numbers'],
  tests: ['levels', 'focus', 'rules', 'touched', 'mutate'],
  body: ['-', 'template'],
}

export interface CheckOptions {
  root: string
  // Where lntt runs, which the paths a command line gives are read from; the root when absent.
  cwd?: string
  data: Record<string, unknown>
  // Limits a check to what the diff from this ref touches, where that makes sense.
  base?: string
  // `tests touched`: false places the lines from the imports alone and runs no test, as
  // lntt review does; by default a level with `coverage` runs it.
  coverage?: boolean
  // `tests mutate`: what is on the line, what it becomes, and the test files the author runs.
  mutation?: { text: string; to: string; tests: string[] }
  // `body`: the pull request body read, and where from; the area does not run without it.
  body?: { text: string; from: string }
}

export type Cited = { text: string | null } | { missing: string; what: 'file' | 'line' }

// An anchor's line, written as models write it: `:12`, a range `:12-15` or `:12–15`, a
// column `:12:5`, a list `:12,14`; each names its first line.
export const ANCHOR_LINE = /^(.+?):(\d+)(?:[-–,:]\d+)*$/

// Where an anchor points: the file, null when it is outside the root, and the line. The path
// functions are given: Effect's Path service.
export function citeTarget(
  paths: {
    isAbsolute(path: string): boolean
    join(...paths: string[]): string
    relative(from: string, to: string): string
  },
  root: string,
  anchor: string,
  line: number | null,
): { file: string | null; at: number | null } {
  const m = ANCHOR_LINE.exec(anchor)
  const path = (m ? (m[1] as string) : anchor).replace(/#.*$/, '')
  const at = line ?? (m ? Number(m[2]) : null)
  const rel = paths.isAbsolute(path) ? paths.relative(root, path) : path
  return { file: rel.startsWith('..') ? null : paths.join(root, rel), at }
}

// What the line reads, from the file's text, or null when it is not a file.
export function citeText(text: string | null, at: number | null): Cited {
  if (text === null) return { missing: 'no such file', what: 'file' }
  if (at === null) return { text: null }
  const lines = text.replace(/\n$/, '').split('\n')
  if (at < 1 || at > lines.length)
    return {
      missing: `no line ${at}: the file has ${lines.length} line${lines.length === 1 ? '' : 's'}`,
      what: 'line',
    }
  return { text: (lines[at - 1] as string).trim() }
}

// `lntt check cite`: the result of one anchor `path:line`, from what is on the line.
export function citeResult(path: string, line: number, found: Cited): Result {
  return {
    area: 'cite',
    check: 'line',
    status: 'missing' in found ? 'FAIL' : 'PASS',
    path,
    line,
    message: 'missing' in found ? found.missing : (found.text ?? ''),
  }
}

const ORDER: Status[] = ['FAIL', 'NOT RUN', 'INFO', 'PASS']

// One line per result, the ones that need someone first, then the counts.
export function formatText(results: Result[]): string {
  const sorted = [...results].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const lines = sorted.map((r) => {
    const where = r.path === null ? '' : `  ${r.path}${r.line === null ? '' : `:${r.line}`}`
    return `${r.status.padEnd(9)}${r.area}/${r.check}${where} — ${r.message}`
  })
  const count = (s: Status) => results.filter((r) => r.status === s).length
  lines.push(`lntt check: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('NOT RUN')} NOT RUN`)
  return `${lines.join('\n')}\n`
}

export function formatJson(results: Result[]): string {
  return results.map((r) => `${JSON.stringify(r)}\n`).join('')
}

export function failed(results: Result[]): boolean {
  return results.some((r) => r.status === 'FAIL')
}
