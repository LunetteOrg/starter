// What a number means, on screen: the first `#N`, `repo#N` or `owner/repo#N` of a
// message gets its issue's or pull request's title beside it, dimmed, unless the message
// already gives that title, and the message ends with a box of what it cited, each with
// its URL. Pure: which numbers are references, and their titles, are `lntt refs`'s; the
// hook that calls it is issue-titles-hook.js. A message is read delta by delta as it
// streams: `message()` holds what one message has shown.

export const TITLE_MAX = 60

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`

// What one message has shown so far: its text as written, and the references it cited,
// in order.
export function message() {
  return { text: '', cited: [] }
}

// `home` is the session's repository as `owner/repo`, lower case, or null while unknown.
// GitHub names are not case-sensitive: keys are lower case.
const parts = (home) => (home ? home.split('/') : [null, null])

// The label a key shows in the box: as short as stays unambiguous in this session.
export function label(key, home) {
  const [owner, repo] = parts(home)
  const [, o, r, n] = key.match(/^([^/]+)\/([^#]+)#(\d+)$/)
  if (o === owner && r === repo) return `#${n}`
  return o === owner ? `${r}#${n}` : key
}
// A title is anyone's text: control characters (a terminal sequence) and format
// characters (bidi controls, zero-width, tags: what reorders or hides text) are
// dropped, with the line separators and variation selectors.
const HIDDEN = '\\p{Cc}\\p{Cf}\\u2028\\u2029\\u034f\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}'
const clean = (title) => title.replace(new RegExp(`[${HIDDEN}]`, 'gu'), '').trim()
// Cut by what a reader sees as one character (a grapheme: an emoji with its modifiers,
// a letter with its accents), never inside one.
const graphemes = (text) =>
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (g) => g.segment)
    : Array.from(text)
const cut = (title) => {
  const chars = graphemes(title)
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : title
}

// What lntt gave, made safe to show (lntt checks it too, but its answer is a process's
// text): the title cleaned and not empty, the URL an https address with no spaces or
// control characters. Null otherwise.
export function entry(title, url) {
  const t = typeof title === 'string' ? clean(title) : ''
  if (!t || typeof url !== 'string' || !new RegExp(`^https://[^\\s${HIDDEN}]+$`, 'u').test(url)) return null
  return { title: t, url }
}

// A mention lntt gave that can be placed in the text: a key, and positions inside it.
const KEY = /^[^\s/#]+\/[^\s#]+#[1-9]\d*$/
const placed = (x, end) =>
  typeof x?.ref === 'string' &&
  KEY.test(x.ref) &&
  Number.isInteger(x.index) &&
  Number.isInteger(x.after) &&
  x.index >= 0 &&
  x.index <= x.after &&
  x.after <= end

// Records the references these mentions cite, in the order given, once each: a title
// that comes after its delta still goes to the box.
export function cite(m, found) {
  for (const x of found) if (typeof x?.ref === 'string' && KEY.test(x.ref) && !m.cited.includes(x.ref)) m.cited.push(x.ref)
}

// The delta as shown: the title beside each reference the message cites for the first
// time, when it is known and the message does not already give it. `found` is what
// `lntt refs` returned for the message so far with the delta (its mentions, positions in
// that text): those before the delta were the earlier deltas'. Records what the message
// cited.
export function annotate(delta, m, found, info) {
  const from = m.text.length
  const text = m.text + delta
  const seenText = text.toLowerCase()
  const seen = new Set()
  const inserts = []
  for (const x of [...found].filter((x) => placed(x, text.length)).sort((a, b) => a.index - b.index)) {
    if (seen.has(x.ref)) continue
    seen.add(x.ref)
    if (!m.cited.includes(x.ref)) m.cited.push(x.ref)
    if (x.index < from) continue
    const title = info.get(x.ref)?.title
    if (!title || seenText.includes(title.toLowerCase().slice(0, 30))) continue
    inserts.push({ at: x.after - from, text: ` ${dim(`· ${cut(title)}`)}` })
  }
  m.text = text
  return inserts.sort((a, b) => a.at - b.at).reduceRight((l, { at, text }) => l.slice(0, at) + text + l.slice(at), delta)
}

// The box closing the message: each reference it cited that has a title, its URL plain
// so the terminal can open it. Empty when there is none.
export function footer(m, info, home) {
  const rows = m.cited.filter((k) => info.get(k)?.title)
  if (!rows.length) return ''
  const width = Math.max(...rows.map((k) => label(k, home).length))
  return [
    '',
    dim('╭─ cited'),
    ...rows.flatMap((k) => [
      `${dim('│')} ${label(k, home).padEnd(width)} ${dim(cut(info.get(k).title))}`,
      `${dim('│')} ${' '.repeat(width)} ${info.get(k).url}`,
    ]),
    dim('╰─'),
  ].join('\n')
}
