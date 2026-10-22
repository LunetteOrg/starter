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

// `- **<label>:** <value>`, with `*` bullets too.
const LABEL = /^\s*[-*]\s+\*\*(.+?):\*\*(.*)$/

// What a line holds once its HTML comments are gone: a placeholder is no value.
function text(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, '').trim()
}

export function checkBody(body: string, rules: RetrospectiveRules): string[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  // The markers count only on a line of their own: quoted in prose they are not the block.
  const start = lines.findIndex((l) => l.trim() === RETRO_START)
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === RETRO_END)
  if (start === -1 || end === -1) return [`retrospective: no ${RETRO_START} … ${RETRO_END} block in the body`]

  // Each label with its value: the rest of its line, and the lines below it up to the
  // next label.
  const values = new Map<string, string>()
  let current: string | null = null
  for (const line of lines.slice(start + 1, end)) {
    const label = LABEL.exec(line)
    if (label) {
      current = (label[1] as string).trim()
      values.set(current, text(label[2] as string))
    } else if (current !== null) {
      values.set(current, `${values.get(current)} ${text(line)}`.trim())
    }
  }

  const problems: string[] = []
  for (const line of rules.lines) {
    const value = values.get(line)
    if (value === undefined) problems.push(`retrospective: no "${line}" line in the block`)
    else if (value === '') problems.push(`retrospective: "${line}" is empty: write ${rules.none} when nothing applies`)
  }
  return problems
}
