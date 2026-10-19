// What a number means, on screen: the first `#N` of a message gets its issue's or pull
// request's title beside it, dimmed, unless the message already gives that title, and
// the message ends with a box of what it cited, each with its URL. Pure: the lookup and
// the hook are register.js's. A message is read on its own, delta by delta as it
// streams: `message()` holds what one message has shown so far.

export const TITLE_MAX = 60

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`
const FENCE = /^\s*(```|~~~)/
// `#N` as a reference: not part of a word, a URL fragment (`/9#13`) or an entity (`&#39;`).
const REF = /(^|[^\w&/#])#(\d+)\b/g

export function message() {
  return { text: '', fence: false, cited: [] }
}

// A title is anyone's text: control characters (a terminal sequence) are dropped.
const clean = (title) => title.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
const cut = (title) => {
  const t = clean(title)
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

// The line with its code spans blanked, so a match's index is still the line's.
const prose = (line) => line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))

// Each line of a delta with whether it is prose (outside a fence), the fence state
// carried from the message so far.
function lines(delta, fence) {
  const out = []
  for (const line of delta.split(/(?<=\n)/)) {
    if (FENCE.test(line)) {
      fence = !fence
      out.push({ line, prose: false })
    } else out.push({ line, prose: !fence })
  }
  return { out, fence }
}

// The numbers this delta cites for the first time in the message, in order.
export function refsIn(delta, m) {
  const found = []
  for (const { line, prose: isProse } of lines(delta, m.fence).out) {
    if (!isProse) continue
    for (const match of prose(line).matchAll(REF)) {
      const n = Number(match[2])
      if (!m.cited.includes(n) && !found.includes(n)) found.push(n)
    }
  }
  return found
}

// The delta as shown: the title beside each number cited for the first time, when it is
// known and the message does not already give it. Records what the message cited.
export function annotate(delta, m, info) {
  const seenText = (m.text + delta).toLowerCase()
  const { out, fence } = lines(delta, m.fence)
  const shown = out.map(({ line, prose: isProse }) => {
    if (!isProse) return line
    const inserts = []
    for (const match of prose(line).matchAll(REF)) {
      const n = Number(match[2])
      if (m.cited.includes(n)) continue
      m.cited.push(n)
      const title = info.get(n)?.title
      if (!title || seenText.includes(clean(title).toLowerCase().slice(0, 30))) continue
      inserts.push({ at: match.index + match[0].length, text: ` ${dim(`· ${cut(title)}`)}` })
    }
    return inserts.reduceRight((l, { at, text }) => l.slice(0, at) + text + l.slice(at), line)
  })
  m.text += delta
  m.fence = fence
  return shown.join('')
}

// The box closing the message: each number it cited that has a title, its URL plain so
// the terminal can open it. Empty when there is none.
export function footer(m, info) {
  const rows = m.cited.filter((n) => info.get(n)?.title)
  if (!rows.length) return ''
  const pad = ' '.repeat(`#${Math.max(...rows)}`.length)
  return [
    '',
    dim('╭─ cited'),
    ...rows.flatMap((n) => [`${dim('│')} #${n} ${dim(cut(info.get(n).title))}`, `${dim('│')}  ${pad}${info.get(n).url}`]),
    dim('╰─'),
  ].join('\n')
}
