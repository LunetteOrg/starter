// What a number means, on screen: the first `#N`, `repo#N` or `owner/repo#N` of a message
// gets its issue's or pull request's title beside it, dimmed, unless the message already
// gives that title, and the message ends with a box of what it cited, each with its URL. Pure: the lookup and
// the hook are issue-titles-hook.js's. A message is read on its own, delta by delta as it
// streams: `message()` holds what one message has shown so far.

export const TITLE_MAX = 60

const ESC = '\u001b'
const dim = (text) => `${ESC}[2m${text}${ESC}[22m`
const FENCE = /^\s*(```|~~~)/
// A reference: `#N`, `repo#N` or `owner/repo#N`, N from 1 as GitHub numbers them; not
// part of a word, a path or a URL (`/9#13`), nor an entity (`&#39;`).
const REF = /(^|[^\w&/#.-])(?:(?:([\w.-]+)\/)?([\w.-]+))?#([1-9]\d*)\b/g
// A Markdown link: its text is read, its URL is not, and a title goes after it.
const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g

// What one message has shown so far. `foreign`: it cited another repository, so a bare
// `#N` after that may mean either, and is left as it is.
export function message() {
  return { text: '', fence: false, cited: [], foreign: false }
}

// `home` is the session's repository as `owner/repo`, or null while unknown.
const parts = (home) => (home ? home.split('/') : [null, null])

// The key of a match (`owner/repo#N`), or null when it cannot be told for certain.
function keyOf(match, home, foreign) {
  const [owner, repo] = parts(home)
  const [, , o, r, n] = match
  if (o) return `${o}/${r}#${n}`
  if (r) return owner ? `${owner}/${r}#${n}` : null
  return home && !foreign ? `${owner}/${repo}#${n}` : null
}

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

// What a lookup or the cache gave, made safe to show: the title cleaned and not empty,
// the URL an https address with no spaces or control characters. Null otherwise.
export function entry(title, url) {
  const t = typeof title === 'string' ? clean(title) : ''
  if (!t || typeof url !== 'string' || !new RegExp(`^https://[^\\s${HIDDEN}]+$`, 'u').test(url)) return null
  return { title: t, url }
}

// The line with its code spans and its links' URLs blanked, so a match's index is
// still the line's.
const prose = (line) =>
  line
    .replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))
    .replace(LINK, (link, text) => `[${text}]${' '.repeat(link.length - text.length - 2)}`)

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

// Whether a delta has anything that looks like a reference, before the session's
// repository is known.
export const hasRefs = (delta) => /#[1-9]/.test(delta)

// The references this delta cites for the first time in the message, as keys, in order.
export function refsIn(delta, m, home) {
  const found = []
  let foreign = m.foreign
  const [owner, repo] = parts(home)
  for (const { line, prose: isProse } of lines(delta, m.fence).out) {
    if (!isProse) continue
    for (const match of prose(line).matchAll(REF)) {
      const key = keyOf(match, home, foreign)
      if (match[3] && home && key && key !== `${owner}/${repo}#${match[4]}`) foreign = true
      if (key && !m.cited.includes(key) && !found.includes(key)) found.push(key)
    }
  }
  return found
}

// The delta as shown: the title beside each reference cited for the first time, when it
// is known and the message does not already give it; after the link when the reference
// is a link's text. Records what the message cited.
export function annotate(delta, m, info, home) {
  const seenText = (m.text + delta).toLowerCase()
  const [owner, repo] = parts(home)
  const { out, fence } = lines(delta, m.fence)
  const shown = out.map(({ line, prose: isProse }) => {
    if (!isProse) return line
    const links = [...line.matchAll(LINK)].map((l) => ({ from: l.index, to: l.index + l[0].length }))
    const inserts = []
    for (const match of prose(line).matchAll(REF)) {
      const key = keyOf(match, home, m.foreign)
      if (match[3] && home && key && key !== `${owner}/${repo}#${match[4]}`) m.foreign = true
      if (!key || m.cited.includes(key)) continue
      m.cited.push(key)
      const title = info.get(key)?.title
      if (!title || seenText.includes(title.toLowerCase().slice(0, 30))) continue
      const end = match.index + match[0].length
      const link = links.find((l) => l.from <= end && end <= l.to)
      inserts.push({ at: link ? link.to : end, text: ` ${dim(`· ${cut(title)}`)}` })
    }
    return inserts.sort((a, b) => a.at - b.at).reduceRight((l, { at, text }) => l.slice(0, at) + text + l.slice(at), line)
  })
  m.text += delta
  m.fence = fence
  return shown.join('')
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
