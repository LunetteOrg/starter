// What a number means, on screen: the message ends with a box of the issues and pull
// requests it cited, each with its title and URL. Pure: which numbers are references,
// and their titles, are `lntt refs`'s; the hook that calls it is issue-titles-hook.js.
// A message streams in deltas: `message()` holds the text Claude wrote so far, and the
// last delta reads it whole. Nothing is put inside the text: the box alone shows the titles.

export const TITLE_MAX = 60

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`

// What one message holds so far: its text as Claude wrote it, and the references it
// cited, in order.
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

// A reference as lntt's refs.ts names one: `owner/repo#N` in lower case, each name of
// letters, digits, `_`, `.` and `-`, starting with a letter or digit. A ref of any other
// shape is lntt's text that is no reference (a terminal sequence among it): ignored.
const KEY = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*\/[\p{L}\p{N}][\p{L}\p{N}_.-]*#[1-9]\d*$/u
export const isKey = (ref) => typeof ref === 'string' && KEY.test(ref) && ref === ref.toLowerCase()

// A mention lntt gave that can be placed in the message's text: a well-formed ref, and
// positions inside the text.
export const settled = (x, text) =>
  isKey(x?.ref) &&
  Number.isInteger(x.index) &&
  Number.isInteger(x.after) &&
  x.index >= 0 &&
  x.index <= x.after &&
  x.after <= text.length

// Records the references these mentions cite, in the order given, once each. `text`:
// the whole message they were found in.
export function cite(m, found, text) {
  for (const x of found) if (settled(x, text) && !m.cited.includes(x.ref)) m.cited.push(x.ref)
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
