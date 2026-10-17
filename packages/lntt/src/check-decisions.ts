// `lntt check decisions`: the structural checks of the decision logs `recording`
// configures, generic over them (adr, product, process, …). Adapted from
// DiscenTech/pelion's adr-lint.mjs. The rules checked are the decisions skill's
// recording rules: one file per subject, named after it, corrected in place, cited by
// file.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, matchesGlob, posix } from 'node:path'
import { type CheckOptions, projectFiles, type Result } from './check.ts'

interface Log {
  name: string
  path: string
  index?: string
  template?: string
}

type Draft = Omit<Result, 'area'>

const TEXT = /\.(md|mdx|txt|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|ya?ml|toml|sql|css|scss|html|sh|grit|example)$/

function externalOf(data: Record<string, unknown>): Record<string, string> {
  return (data.recording as { externalReferences?: Record<string, string> } | undefined)?.externalReferences ?? {}
}

function logsOf(data: Record<string, unknown>): Log[] | null {
  const recording = data.recording as { logs?: Record<string, Omit<Log, 'name'>> } | undefined
  if (!recording) return null
  return Object.entries(recording.logs ?? {}).map(([name, log]) => ({ name, ...log, path: trimSlash(log.path) }))
}

function trimSlash(path: string): string {
  return posix.normalize(path).replace(/\/+$/, '')
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

// The records of a log: the Markdown files right in its folder, less its index, its
// template and any README.
function recordsOf(log: Log, files: string[]): string[] {
  return files.filter(
    (f) =>
      posix.dirname(f) === log.path &&
      f.endsWith('.md') &&
      f !== log.index &&
      f !== log.template &&
      posix.basename(f) !== 'README.md',
  )
}

// Code is not prose: a code span or a fenced block shows a link or a marker without
// making one. Blanked out, so offsets and line numbers stay where they were.
function prose(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, blank).replace(/`[^`\n]*`/g, blank)
}

interface Link {
  target: string
  text: string | null
  index: number
}

// Inline links and reference definitions, their text wrapped or not.
function links(text: string): Link[] {
  const out: Link[] = []
  for (const m of text.matchAll(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    out.push({ target: m[2] as string, text: (m[1] as string).trim(), index: m.index })
  }
  for (const m of text.matchAll(/^[ \t]*\[[^\]]+\]:[ \t]*<?(\S+?)>?(?:[ \t]|$)/gm)) {
    out.push({ target: m[1] as string, text: null, index: m.index })
  }
  return out
}

// A link's file, relative to the root: null for a URL, an anchor in the same file, or a
// place outside the repository.
function resolveLink(from: string, target: string): string | null {
  if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return null
  let path = target.split('#')[0] as string
  if (!path) return null
  try {
    path = decodeURIComponent(path)
  } catch {}
  const joined = path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(from), path)
  const normal = posix.normalize(joined)
  return normal.startsWith('..') ? null : trimSlash(normal)
}

function inLog(path: string, logs: Log[]): boolean {
  return logs.some((log) => path === log.path || path.startsWith(`${log.path}/`))
}

function indexCheck(root: string, logs: Log[], files: string[]): Draft[] {
  const out: Draft[] = []
  const counts: string[] = []
  for (const log of logs) {
    if (!log.index) {
      out.push({
        check: 'index',
        status: 'NOT RUN',
        path: null,
        line: null,
        message: `recording.logs.${log.name} has no index: its records are not checked against one`,
      })
      continue
    }
    if (!existsSync(join(root, log.index))) {
      out.push({
        check: 'index',
        status: 'FAIL',
        path: log.index,
        line: null,
        message: `the index of recording.logs.${log.name} does not exist`,
      })
      continue
    }
    const records = recordsOf(log, files)
    const text = prose(read(root, log.index))
    const listed = new Set<string>()
    let rows = 0
    for (const link of links(text)) {
      const target = resolveLink(log.index, link.target)
      if (target === null || posix.dirname(target) !== log.path || !target.endsWith('.md')) continue
      if (target === log.template || target === log.index) continue
      listed.add(target)
      const line = lineOf(text, link.index)
      const row = (text.split('\n')[line - 1] as string).trimStart().startsWith('|')
      if (row) rows++
      if (!existsSync(join(root, target))) {
        out.push({
          check: 'index',
          status: 'FAIL',
          path: log.index,
          line,
          message: `a row for ${target}, which does not exist: remove the row or restore the file`,
        })
        continue
      }
      // A row labelled with a file's subject names that file; a label in words is a title.
      const subject = posix.basename(target, '.md')
      if (row && link.text !== null && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.md)?$/.test(link.text)) {
        const label = link.text.replace(/\.md$/, '')
        if (label !== subject) {
          out.push({
            check: 'index',
            status: 'FAIL',
            path: log.index,
            line,
            message: `the row "${label}" points at ${posix.basename(target)}: the label is the file's subject, ${subject}`,
          })
        }
      }
    }
    for (const record of records) {
      if (listed.has(record)) continue
      out.push({
        check: 'index',
        status: 'FAIL',
        path: record,
        line: 1,
        message: `a record never indexed in ${log.index}: add its row`,
      })
    }
    counts.push(`${log.name}: ${records.length} records, ${rows} rows`)
  }
  if (!out.some((r) => r.status === 'FAIL') && counts.length > 0) {
    out.push({ check: 'index', status: 'PASS', path: null, line: null, message: counts.join('; ') })
  }
  return out
}

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A line break inside a reference, with the comment marker the next line starts with.
const WRAP = String.raw`(?:[ \t]*\n[ \t]*(?:#|\/\/|\*|--|<!--)?[ \t]*)`

// `ADR-NNNN`, `PDR NN`, `ADR #N`, also wrapped; not a numbered list item on the next line.
const NUMBERED = new RegExp(String.raw`\b([AP]DR)[ \t]?[-#]?${WRAP}?(\d+)\b(?![.)][ \t])`, 'g')

function referencesCheck(root: string, logs: Log[], files: string[], external: Record<string, string>): Draft[] {
  const out: Draft[] = []
  const fail = (path: string, line: number, message: string) =>
    out.push({ check: 'references', status: 'FAIL', path, line, message })
  const exists = (path: string) => existsSync(join(root, path))
  const templates = new Set(logs.map((l) => l.template).filter(Boolean))
  // A path to a record from the root, in a document or in code: split after its folder
  // or at a hyphen when a line was rewrapped.
  const mentions = logs.map(
    (log) =>
      new RegExp(
        String.raw`(?<![\w./-])(${literal(log.path)})\/${WRAP}?([A-Za-z0-9][\w-]*)(?:(?<=-)${WRAP}([\w-]+))?(\.[A-Za-z0-9]+)?`,
        'g',
      ),
  )
  // A glob that matches no file is an exception nothing needs any longer.
  const globs = Object.keys(external)
  for (const glob of globs) {
    if (!files.some((f) => matchesGlob(f, glob))) {
      out.push({
        check: 'references',
        status: 'FAIL',
        path: null,
        line: null,
        message: `recording.externalReferences["${glob}"] matches no file: remove it`,
      })
    }
  }
  let scanned = 0
  let elsewhere = 0
  for (const file of files) {
    if (!TEXT.test(file) || templates.has(file) || statSync(join(root, file)).size > 1024 * 1024) continue
    scanned++
    const text = read(root, file)
    const markdown = /\.mdx?$/.test(file)
    const body = markdown ? prose(text) : text
    // Its paths name another project's records; a number is wrong in any project.
    const foreign = globs.some((glob) => matchesGlob(file, glob))
    if (foreign) elsewhere++
    if (markdown && !foreign) {
      const ownIndex = logs.find((l) => l.index === file)
      for (const link of links(body)) {
        const target = resolveLink(file, link.target)
        if (target === null || !inLog(target, logs) || exists(target)) continue
        // An index's rows are the index check's.
        if (ownIndex && posix.dirname(target) === ownIndex.path) continue
        fail(file, lineOf(body, link.index), `a link to ${target}, which does not exist`)
      }
    }
    // A path is checked in code spans too: that is where a document writes one.
    for (const re of foreign ? [] : mentions) {
      for (const m of text.matchAll(re)) {
        // A break right after the folder is a wrapped path only when what follows is a
        // file name: a sentence that ends on the folder goes on with a word.
        if (!m[4] && /^[^/]*\/\s*\n/.test(m[0].slice(m[1].length))) continue
        const base = `${m[1]}/${m[2]}${m[3] ?? ''}`
        const ok = m[4] ? exists(`${base}${m[4]}`) : exists(base) || exists(`${base}.md`)
        if (!ok) fail(file, lineOf(text, m.index), `cites ${base}${m[4] ?? ''}, which does not exist`)
      }
    }
    for (const m of body.matchAll(NUMBERED)) {
      fail(
        file,
        lineOf(body, m.index),
        `cites ${m[1]} ${m[2]} by number: cite the record by its file (a relative link in a document, the path in code)`,
      )
    }
  }
  if (out.length === 0) {
    out.push({
      check: 'references',
      status: 'PASS',
      path: null,
      line: null,
      message: `every reference to a record resolves (${scanned} files read${elsewhere > 0 ? `, ${elsewhere} citing another project's records by recording.externalReferences` : ''})`,
    })
  }
  return out
}

// What an append-only log leaves: a record that points at its successor or carries its
// amendments, instead of being rewritten.
const RESIDUES: [string, RegExp][] = [
  ['Superseded by', /\bsuperseded by\b/i],
  ['Supersedes', /\bSupersedes\b/],
  ['Amended by', /\bamended by\b/i],
  ['## Update', /^#{2,}\s*(?:post-merge\s+)?update\b/i],
  ['## Addendum', /^#{2,}\s*addendum\b/i],
  ['## Amendment', /^#{2,}\s*amendment\b/i],
  ['struck-through text', /~~[^~\n]+~~/],
  ['superata da', /\bsuperat[ao] (?:da|in parte)\b/i],
  ['sostituita da', /\bsostituit[ao] da\b/i],
  ['## Aggiornamento', /^#{2,}\s*(?:aggiornamento|emendamento)\b/i],
]

function residuesCheck(root: string, records: string[], only: Set<string> | null): Draft[] {
  const out: Draft[] = []
  for (const record of records) {
    prose(read(root, record))
      .split('\n')
      .forEach((line, i) => {
        for (const [name, re] of RESIDUES) {
          if (!re.test(line)) continue
          out.push({
            check: 'residues',
            status: 'FAIL',
            path: record,
            line: i + 1,
            message: `an append-only residue (${name}): rewrite the record in place, git keeps the history`,
          })
        }
      })
  }
  if (out.length === 0) {
    out.push({
      check: 'residues',
      status: 'PASS',
      path: null,
      line: null,
      message: `no append-only residue in ${records.length} records${only ? ' the diff touches' : ''}`,
    })
  }
  return out
}

interface Frontmatter {
  status: string | null
  // The statuses the comment beside it lists (`status: proposed # proposed | accepted`).
  allowed: string[]
  line: number
}

function frontmatter(text: string): Frontmatter | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!m) return null
  const lines = (m[1] as string).split('\n')
  const at = lines.findIndex((l) => /^status:/.test(l))
  if (at === -1) return { status: null, allowed: [], line: 1 }
  const [, value, comment] = /^status:\s*([^#]*?)\s*(?:#\s*(.*))?$/.exec(lines[at] as string) as unknown as [
    string,
    string,
    string | undefined,
  ]
  const listed = comment?.includes('|') ? comment.split('|').map((s) => s.trim().split(/\s+/)[0] as string) : []
  return { status: value.replace(/^["']|["']$/g, ''), allowed: [...new Set([value, ...listed])], line: at + 2 }
}

function namesCheck(root: string, logs: Log[], files: string[], only: Set<string> | null): Draft[] {
  const out: Draft[] = []
  const fail = (path: string, line: number, message: string) =>
    out.push({ check: 'names', status: 'FAIL', path, line, message })
  const summary: string[] = []
  for (const log of logs) {
    const allowed =
      log.template && existsSync(join(root, log.template)) ? frontmatter(read(root, log.template))?.allowed : undefined
    // Only a template that lists them (`status: proposed # proposed | accepted`) says
    // which statuses the log allows.
    const statuses = allowed && allowed.length > 1 ? allowed : null
    const records = recordsOf(log, files).filter((r) => !only || only.has(r))
    for (const record of records) {
      const name = posix.basename(record)
      if (/^\d/.test(name)) fail(record, 1, 'the file name starts with a number: a record is named after its subject')
      else if (/\d{4}-\d{2}(-\d{2})?/.test(name))
        fail(record, 1, 'the file name carries a date: name it after its subject')
      else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*\.md$/.test(name)) fail(record, 1, 'the file name is not kebab-case')
      const text = read(root, record)
      const lines = text.split('\n')
      const title = prose(text)
        .split('\n')
        .findIndex((l) => /^# /.test(l))
      if (title === -1) fail(record, 1, 'no title: a record starts with `# <subject>`')
      // Numbered: `ADR`/`PDR` and a number anywhere, or a number followed by a mark: a dash
      // (`# 0003 — …`, `# 0003—…`), or `.`, `:`, `)` with a space, the end or a capital after it
      // (`# 1. …`, `# 1.Record`). Anything else is words: a count (`# 12 retries`), a
      // version or a time (`# 2.0`, `# 1.2 Plan`, `# 7:30`), a number glued to a lowercase
      // word (`# 3.js`), and a bare `# 0003 Old`, which cannot be told from a count and is
      // left to the reviewer. The decisions skill's recording rules state it.
      else if (/^#\s+(?:\d+[.:)](?:\s|$|[A-Z])|\d+\s*(?:[-–]\s|—))|\b[AP]DR[ \-#]?\d/.test(lines[title] as string)) {
        fail(record, title + 1, `the title carries a number: ${(lines[title] as string).trim()}`)
      }
      if (!statuses) continue
      const front = frontmatter(text)
      if (!front || front.status === null) {
        fail(record, 1, `no status in the frontmatter: one of ${statuses.join(', ')}`)
      } else if (!statuses.includes(front.status)) {
        fail(record, front.line, `the status ${front.status} is not one ${log.name} allows: ${statuses.join(', ')}`)
      }
    }
    summary.push(
      `${log.name}: ${records.length} records${only ? ' the diff touches' : ''}, file name, title${statuses ? `, status (${statuses.join('|')})` : ' (no template listing two statuses or more: no status)'}`,
    )
  }
  if (out.length === 0) {
    out.push({ check: 'names', status: 'PASS', path: null, line: null, message: summary.join('; ') })
  }
  return out
}

interface Touched {
  status: string
  path: string
  from: string | null
}

function diffOf(root: string, base: string): Touched[] | null {
  try {
    return execFileSync(
      'git',
      ['-C', root, '-c', 'core.quotepath=off', 'diff', '--name-status', '-M', `${base}...HEAD`],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 256 * 1024 * 1024,
      },
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, a, b] = line.split('\t') as [string, string, string | undefined]
        return { status: status.charAt(0), path: b ?? a, from: b ? a : null }
      })
  } catch {
    return null
  }
}

const VERBS: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' }

function inventory(logs: Log[], diff: Touched[]): Draft[] {
  const recordLog = (path: string) => logs.find((log) => recordsOf(log, [path]).length > 0)
  const out: Draft[] = []
  const code: string[] = []
  for (const t of [...diff].sort((a, b) => a.path.localeCompare(b.path))) {
    const log = recordLog(t.path) ?? (t.from ? recordLog(t.from) : undefined)
    if (!log) {
      code.push(t.path)
      continue
    }
    const gone = t.status === 'D' || t.status === 'R' ? ': no longer at this path' : ''
    const what = t.status === 'R' ? `renamed from ${t.from}` : (VERBS[t.status] ?? t.status)
    out.push({
      check: 'inventory',
      status: 'INFO',
      path: t.status === 'R' ? (t.from as string) : t.path,
      line: null,
      message: `${log.name} record, ${what}${gone}${t.status === 'R' ? ` (now ${t.path})` : ''}`,
    })
  }
  if (code.length > 0) {
    out.push({
      check: 'inventory',
      status: 'INFO',
      path: null,
      line: null,
      message: `${code.length} other files: ${code.join(', ')}`,
    })
  }
  if (out.length === 0) {
    out.push({ check: 'inventory', status: 'INFO', path: null, line: null, message: 'the diff touches no file' })
  }
  return out
}

// Every line carrying a figure: a percentage, an "N of M", a number of two digits or
// more; the frontmatter, issue numbers and dates are identifiers, not figures.
function figures(root: string, paths: string[]): Draft[] {
  const out: Draft[] = []
  for (const path of paths) {
    if (!existsSync(join(root, path)) || !statSync(join(root, path)).isFile()) {
      out.push({ check: 'figures', status: 'FAIL', path, line: null, message: 'no such file' })
      continue
    }
    const text = read(root, path)
    const front = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text)?.[0].split('\n').length ?? 0
    text.split('\n').forEach((line, i) => {
      if (i < front - 1) return
      const bare = line.replace(/#\d+/g, '').replace(/\d{4}-\d{2}-\d{2}/g, '')
      if (/\d+(?:[.,]\d+)?\s*%|\b\d+\s+(?:of|out of|su)\s+\d+\b|\b\d{2,}\b/.test(bare)) {
        out.push({ check: 'figures', status: 'INFO', path, line: i + 1, message: line.trim() })
      }
    })
  }
  return out
}

function withArea(drafts: Draft[]): Result[] {
  return drafts.map((d) => ({ area: 'decisions', ...d }))
}

const NO_RECORDING: Result = {
  area: 'decisions',
  check: 'structure',
  status: 'NOT RUN',
  path: null,
  line: null,
  message: 'no recording section in the configuration',
}

function touchedRecords(logs: Log[], diff: Touched[]): Set<string> {
  return new Set(
    diff.filter((t) => t.status !== 'D' && logs.some((log) => recordsOf(log, [t.path]).length > 0)).map((t) => t.path),
  )
}

// The structure of every log: index and files, references, residues, names. With a
// base, the inventory of the diff, residues and names on the records it touches only,
// and (with `figures`) the figures of those records.
export function checkDecisions(options: CheckOptions, { figures: withFigures }: { figures: boolean }): Result[] {
  const logs = logsOf(options.data)
  if (logs === null) return [NO_RECORDING]
  const { root } = options
  const files = projectFiles(root)
  let only: Set<string> | null = null
  const extra: Draft[] = []
  if (options.base !== undefined) {
    const diff = diffOf(root, options.base)
    if (diff === null) {
      extra.push({
        check: 'inventory',
        status: 'NOT RUN',
        path: null,
        line: null,
        message: `git diff ${options.base}...HEAD does not run: the ref does not resolve, or has no merge base with HEAD`,
      })
    } else {
      only = touchedRecords(logs, diff)
      extra.push(...inventory(logs, diff))
      if (withFigures) extra.push(...figures(root, [...only].sort()))
    }
  }
  const records = logs.flatMap((log) => recordsOf(log, files)).filter((r) => !only || only.has(r))
  return withArea([
    ...indexCheck(root, logs, files),
    ...referencesCheck(root, logs, files, externalOf(options.data)),
    ...residuesCheck(root, records, only),
    ...namesCheck(root, logs, files, only),
    ...extra,
  ])
}

// `lntt check decisions numbers [<file>...]`: the figures of the files given, else of
// the records the diff from the base touches.
export function decisionFigures(options: CheckOptions, paths: string[]): Result[] {
  if (paths.length > 0) return withArea(figures(options.root, paths))
  const logs = logsOf(options.data)
  if (logs === null) return [NO_RECORDING]
  const diff = diffOf(options.root, options.base as string)
  if (diff === null) {
    return withArea([
      {
        check: 'figures',
        status: 'NOT RUN',
        path: null,
        line: null,
        message: `git diff ${options.base}...HEAD does not run: the ref does not resolve, or has no merge base with HEAD`,
      },
    ])
  }
  return withArea(figures(options.root, [...touchedRecords(logs, diff)].sort()))
}
