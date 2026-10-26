// The retrospective block of a pull request body (delivery.pullRequest.retrospective):
// the empty block the template and the retrospective skill write, and the check of a
// body, which reports a block that is missing, a label that is missing and a label
// left with no value. `none` (or the configured word) is an answer; an empty label
// means the block was not filled in.

export const RETRO_START = '<!-- retro:start -->'
export const RETRO_END = '<!-- retro:end -->'

export interface RetrospectiveRules {
  heading: string
  lines: string[]
  none: string
}

interface Retrospective {
  heading?: string
  lines?: string[]
  none?: string
}

// The defaults are the ones the schema documents.
export function retrospectiveRules(config: {
  delivery?: { pullRequest?: { retrospective?: Retrospective } }
}): RetrospectiveRules {
  const retrospective = config.delivery?.pullRequest?.retrospective ?? {}
  return {
    heading: retrospective.heading ?? '🔁 Retrospective',
    lines: retrospective.lines ?? [
      'Friction',
      'To automate (hook/skill/agent)',
      'Rule rediscovered (→ ADR/AGENTS.md)',
      'Rework cause',
    ],
    none: retrospective.none ?? 'none',
  }
}

export function retrospectiveBlock(rules: RetrospectiveRules): string {
  return [`## ${rules.heading}`, RETRO_START, ...rules.lines.map((line) => `- **${line}:**`), RETRO_END, ''].join('\n')
}

// `- **<label>:** <value>`, with `*` bullets too, at the start of the line: an indented
// bold item is part of the value above it.
const LABEL = /^[-*]\s+\*\*(.+?):\*\*(.*)$/

// The lines between the markers, HTML comments removed (on one line or across several: a
// placeholder is not an answer); null when the text has no block. The markers count only
// on a line of their own: quoted in prose they are not the block.
function blockLines(text: string): string[] | null {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === RETRO_START)
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === RETRO_END)
  if (start === -1 || end === -1) return null
  return lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')
}

// The marker of an item whose friction comes from upstream, from a repository other
// than the project's own: `[upstream:<owner/name>]` at the start of the item, never
// inside a sentence. Lunette itself (lntt, a shared skill, the scaffolder, a template) is
// cycle.retrospective.upstream.repository; a library the project uses is its own
// repository. Only an item starting `[upstream:` is read as a marker, `[src/app] …` is
// plain text; one that starts so and is not `[upstream:<owner/name>]` followed by a space
// or nothing is reported. The harvest groups the marked items by repository (the
// retrospective skill).
const MARKED = '[upstream:'
const MARKER = /^\[upstream:([\w.-]+\/[\w.-]+)\](?=\s|$)/

// Each item of the block with its label: a label's value on its own line, and each bullet
// below it, indented or not; a line that is no bullet continues the item above it.
function blockItems(block: string[]): { label: string; text: string }[] {
  const items: { label: string; text: string }[] = []
  let current: string | null = null
  for (const line of block) {
    const label = LABEL.exec(line)
    if (label) {
      current = (label[1] as string).trim()
      const value = (label[2] as string).trim()
      if (value !== '') items.push({ label: current, text: value })
      continue
    }
    if (current === null || line.trim() === '') continue
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const last = items.at(-1)
    if (bullet) items.push({ label: current, text: (bullet[1] as string).trim() })
    else if (last?.label === current) last.text = `${last.text} ${line.trim()}`
    else items.push({ label: current, text: line.trim() })
  }
  return items
}

// The marked items, the marker taken off, with their repository: what the harvest lists
// and drafts issues from. A marker checkBody reports (no owner/name, no sentence) is no item.
export function upstreamItems(text: string): { label: string; repository: string; item: string }[] {
  return blockItems(blockLines(text) ?? []).flatMap(({ label, text }) => {
    const marker = MARKER.exec(text)
    if (marker === null) return []
    const item = text.slice(marker[0].length).trim()
    return item === '' ? [] : [{ label, repository: marker[1] as string, item }]
  })
}

export function checkBody(body: string, rules: RetrospectiveRules): string[] {
  const block = blockLines(body)
  if (block === null) return [`retrospective: no ${RETRO_START} … ${RETRO_END} block`]

  // Each label with its value: the rest of its line, and the lines below it up to the
  // next label.
  const values = new Map<string, string>()
  const repeated = new Set<string>()
  let current: string | null = null
  for (const line of block) {
    const label = LABEL.exec(line)
    if (label) {
      current = (label[1] as string).trim()
      if (values.has(current)) repeated.add(current)
      values.set(current, (label[2] as string).trim())
    } else if (current !== null) {
      values.set(current, `${values.get(current)} ${line.trim()}`.trim())
    }
  }

  const problems: string[] = []
  for (const line of rules.lines) {
    const value = values.get(line)
    if (value === undefined) problems.push(`retrospective: no "${line}" line in the block`)
    else if (repeated.has(line)) problems.push(`retrospective: "${line}" is in the block more than once: keep one`)
    else if (value === '') problems.push(`retrospective: "${line}" is empty: write ${rules.none} when nothing applies`)
  }
  for (const { label, text } of blockItems(block)) {
    if (!text.startsWith(MARKED)) continue
    const marker = MARKER.exec(text)
    if (marker === null)
      problems.push(
        `retrospective: "${label}" has an item starting ${text.split(/\s/)[0]}: write [upstream:<owner/name>], a space, then the sentence`,
      )
    else if (text.slice(marker[0].length).trim() === '')
      problems.push(`retrospective: "${label}" has a ${marker[0]} item with no sentence after the marker`)
  }
  return problems
}

// The label `wanted` names: the configured label equal to it ignoring case, else the one
// it is the start of, when only one is. Null when none or several match.
export function findLabel(rules: RetrospectiveRules, wanted: string): string | null {
  const key = wanted.trim().toLowerCase()
  if (key === '') return null
  const exact = rules.lines.find((line) => line.toLowerCase() === key)
  if (exact !== undefined) return exact
  const starting = rules.lines.filter((line) => line.toLowerCase().startsWith(key))
  return starting.length === 1 ? (starting[0] as string) : null
}

// Appends `item` under `label` in the block of `text`, keeping the markers, the other
// labels and every line outside the block. An empty label (or one holding only a
// placeholder comment, or `none`) takes the item on its line; a label with a value gets
// its items as sub-bullets, a value on the label's line becoming the first. Throws on a text with
// no block, or a block without the label.
export function appendRetro(text: string, label: string, item: string, rules: RetrospectiveRules): string {
  const crlf = text.includes('\r\n')
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === RETRO_START)
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === RETRO_END)
  if (start === -1 || end === -1) throw new Error(`no ${RETRO_START} … ${RETRO_END} block`)
  const at = lines.findIndex((l, i) => i > start && i < end && LABEL.exec(l)?.[1]?.trim() === label)
  if (at === -1) throw new Error(`no "${label}" line in the block`)

  // The label's lines: its own, and those below it up to the next label or the end.
  let last = at
  for (let i = at + 1; i < end && !LABEL.test(lines[i] as string); i++) {
    if ((lines[i] as string).trim() !== '') last = i
  }
  const head = lines[at] as string
  const bullet = head.slice(0, head.indexOf('**'))
  // The label's value as checkBody reads it: HTML comments, closed or not, are none.
  const value = (text: string) => text.replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim()
  const inline = value(LABEL.exec(head)?.[2] ?? '')
  const all = value([LABEL.exec(head)?.[2] ?? '', ...lines.slice(at + 1, last + 1)].join('\n'))
  let next: string[]
  if (all === '' || all === rules.none) next = [`${bullet}**${label}:** ${item}`]
  else if (last > at && inline === '') next = [...lines.slice(at, last + 1), `  - ${item}`]
  // `none` beside items below it is no item: it goes.
  else if (last > at && inline === rules.none)
    next = [`${bullet}**${label}:**`, ...lines.slice(at + 1, last + 1), `  - ${item}`]
  else if (last > at)
    next = [`${bullet}**${label}:**`, `  - ${inline}`, ...lines.slice(at + 1, last + 1), `  - ${item}`]
  else next = [`${bullet}**${label}:**`, `  - ${inline}`, `  - ${item}`]
  const out = [...lines.slice(0, at), ...next, ...lines.slice(last + 1)].join('\n')
  return crlf ? out.replaceAll('\n', '\r\n') : out
}

// The retrospective comment among a pull request's comments: the first holding the start
// marker on a line of its own, the one the candidate automation wrote. A comment quoting
// the marker in prose is not it.
export function retroComment<T extends { body: string | null }>(comments: T[]): T | null {
  return comments.find((c) => (c.body ?? '').split(/\r?\n/).some((l) => l.trim() === RETRO_START)) ?? null
}
