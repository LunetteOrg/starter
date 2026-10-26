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

export function checkBody(body: string, rules: RetrospectiveRules): string[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  // The markers count only on a line of their own: quoted in prose they are not the block.
  const start = lines.findIndex((l) => l.trim() === RETRO_START)
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === RETRO_END)
  if (start === -1 || end === -1) return [`retrospective: no ${RETRO_START} … ${RETRO_END} block`]

  // HTML comments are no value, on one line or across several: a placeholder is not an
  // answer.
  const block = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split('\n')

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
// labels and every line outside the block. An empty label (or one holding a placeholder
// comment, or `none`) takes the item on its own line; a label with a value gets its
// items as sub-bullets, the value on its line becoming the first. Throws on a text with
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
  const value = (LABEL.exec(head)?.[2] ?? '').replace(/<!--.*?-->/g, '').trim()
  const below = last > at
  const blank = value === '' || value === rules.none
  let next: string[]
  if (blank && !below) next = [`${bullet}**${label}:** ${item}`]
  else if (below) next = [...lines.slice(at, last + 1), `  - ${item}`]
  else next = [`${bullet}**${label}:**`, `  - ${value}`, `  - ${item}`]
  const out = [...lines.slice(0, at), ...next, ...lines.slice(last + 1)].join('\n')
  return crlf ? out.replaceAll('\n', '\r\n') : out
}
