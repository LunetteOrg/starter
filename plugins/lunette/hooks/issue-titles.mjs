// What a number means, on screen: the first `#N`, `repo#N` or `owner/repo#N` of a
// message gets its issue's or pull request's title beside it, dimmed, unless the message
// already gives that title, and the message ends with a box of what it cited, each with
// its URL. Pure: which numbers are references, and their titles, are `lntt refs`'s; the
// hook that calls it is issue-titles-hook.js. A message is read delta by delta as it
// streams: `message()` holds what one message has shown.

export const TITLE_MAX = 60

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`

// What one message has shown so far: its text as written, the references it cited, in
// order, and whether a mention at the end of its text is held back for the next delta.
export function message() {
  return { text: '', cited: [], held: false }
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

// A reference as lntt's refs.ts names one: `owner/repo#N` in lower case, each name of
// letters, digits, `_`, `.` and `-`, starting with a letter or digit. A ref of any other
// shape is lntt's text that is no reference (a terminal sequence among it): ignored.
const KEY = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*\/[\p{L}\p{N}][\p{L}\p{N}_.-]*#[1-9]\d*$/u
export const isKey = (ref) => typeof ref === 'string' && KEY.test(ref) && ref === ref.toLowerCase()

// A mention lntt gave that can be placed in a text of `end` UTF-16 units and is settled:
// one that ends at the end of the text may go on in the next delta (`#1` | `38`), so it
// is settled only on the last delta.
export const settled = (x, end, final) =>
  isKey(x?.ref) &&
  Number.isInteger(x.index) &&
  Number.isInteger(x.after) &&
  x.index >= 0 &&
  x.index <= x.after &&
  (x.after < end || (final && x.after === end))

// Records the references these settled mentions cite, in the order given, once each: a
// title that comes after its delta still goes to the box. `end` and `final`: the text
// they were found in, and whether it was the message's last delta.
export function cite(m, found, end, final) {
  for (const x of found) if (settled(x, end, final) && !m.cited.includes(x.ref)) m.cited.push(x.ref)
}

// The delta as shown: the title beside each reference the message cites for the first
// time, when it is known and the message does not already give it. `found` is what
// `lntt refs` returned for the message so far with the delta (its mentions, positions in
// that text). A mention belongs to the delta where it ends: one that ends where the
// delta starts was held back from the delta before, and its title goes at the start of
// this one. Records what the message cited, and whether a mention is held back.
export function annotate(delta, m, found, info, final = false) {
  const from = m.text.length
  const text = m.text + delta
  const seenText = text.toLowerCase()
  const seen = new Set()
  const inserts = []
  for (const x of [...found].filter((x) => settled(x, text.length, final)).sort((a, b) => a.index - b.index)) {
    if (seen.has(x.ref)) continue
    seen.add(x.ref)
    if (!m.cited.includes(x.ref)) m.cited.push(x.ref)
    if (x.after < from) continue
    const title = info.get(x.ref)?.title
    if (!title || seenText.includes(title.toLowerCase().slice(0, 30))) continue
    inserts.push({ at: x.after - from, text: ` ${dim(`· ${cut(title)}`)}` })
  }
  m.held = !final && found.some((x) => isKey(x?.ref) && x.after === text.length)
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
