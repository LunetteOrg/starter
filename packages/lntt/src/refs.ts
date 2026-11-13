// What a number in a text means: each `#N`, `repo#N` or `owner/repo#N` read as an
// issue or pull request of a repository, with its title and URL from `gh`, cached in
// <git dir>/lntt-issue-titles.json for a day. The plugin's issue-titles hook shows what
// this finds; any agent can ask it before writing (`lntt refs`, src/refs-cli.ts).
// Nothing here loads src/index.ts: the hook waits for it.
//
// Plain logic, no node: module and no Effect: the mentions of a text, what is safe to show,
// and the cache as text. The lookups run on Effect over git, gh, the file system and the
// clock (src/refs/resolve.ts); resolveRefs below is its Promise form, for the library.

export const DAY = 24 * 60 * 60 * 1000
// How long each gh call may take: past it, the call counts as failed.
export const GH_TIMEOUT_MS = 3000
// How many issues are asked of gh at once.
export const LOOKUPS_AT_ONCE = 6
export const CACHE_FILE = 'lntt-issue-titles.json'

// A repository and a reference as keys: lower case, each name starting with a letter
// or digit.
const KEY_REPO = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/
const KEY = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*#[1-9]\d*$/

const FENCE = /^\s*(```|~~~)/
// A reference: `#N`, `repo#N` or `owner/repo#N`, N from 1 as GitHub numbers them; not
// part of a word, a path or a URL (`/9#13`), nor an entity (`&#39;`). A name starts with
// a letter or digit, so `.` and `..` are never one.
const NAME = '[\\p{L}\\p{N}][\\p{L}\\p{N}_.-]*'
const REF = new RegExp(`(^|[^\\p{L}\\p{N}_&/#.-])(?:(?:(${NAME})\\/)?(${NAME}))?#([1-9]\\d*)\\b`, 'gu')
// `repo#N` alone is a reference only when `repo` is the session's repository; another
// repository is cited as `owner/repo#N`. Any other `word#N` is no reference (`C#5`,
// `fix#12`, `starter#94` from another repository's session), and a word that could be a
// repository name (three characters or more, a letter first) makes the text foreign.
const mayBeRepo = (r: string) => r.length >= 3 && /^\p{L}/u.test(r)
// A Markdown link: its text is read, its URL is not, and a title goes after it.
const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g

// A reference-looking match in prose. `index`: where it starts; `after`: where a title
// goes (its end, or the end of the link whose text holds it); both UTF-16 indices into
// the whole text, as String.slice counts. `ref`: `owner/repo#N` in lower case, or null
// when the repository cannot be told for certain.
export interface Mention {
  text: string
  ref: string | null
  index: number
  after: number
}

// Why a reference has no title: gh does not know it or gave nothing safe to show
// (unknown), the lookup failed and is asked again next time (failed), nothing could be
// asked (off: no session repository, gh missing or not logged in), or --cached and not
// in the cache (cached).
export type Why = 'unknown' | 'failed' | 'off' | 'cached'
export type Resolved = { ref: string; title: string; url: string } | { ref: string; title: null; url: null; why: Why }

export interface Refs {
  repository: string | null
  mentions: Mention[]
  refs: Resolved[]
}

// A command run to its end with a timeout. Rejects when it cannot start (`code`
// ENOENT when it is missing) or runs past the timeout.
export type RefsRun = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// What a match refers to: its key or null when it cannot be told for certain, and
// whether it names a repository other than the session's (`home`: owner/repo, lower
// case, or null when unknown). GitHub names are not case-sensitive.
function refOf(match: RegExpMatchArray, home: string | null, foreign: boolean): { key: string | null; other: boolean } {
  const [, , o, r, n] = match
  if (!r) return { key: home && !foreign ? `${home}#${n}` : null, other: !home }
  if (!o) {
    if (home && r.toLowerCase() === home.split('/')[1]) return { key: `${home}#${n}`, other: false }
    return { key: null, other: mayBeRepo(r) }
  }
  const full = `${o}/${r}`.toLowerCase()
  return { key: `${full}#${n}`, other: !home || full !== home }
}

// The line with its code spans blanked, then its links' URLs, so a match's index is
// still the line's.
const noCode = (line: string) => line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))
const prose = (line: string) =>
  noCode(line).replace(LINK, (link, text: string) => `[${text}]${' '.repeat(link.length - text.length - 2)}`)

// Every reference-looking match of the text's prose, in order: the fence and whether
// the text turned foreign run through it from its start.
export function mentions(text: string, repository: string | null): Mention[] {
  const found: Mention[] = []
  let fence = false
  let foreign = false
  let offset = 0
  for (const line of text.split(/(?<=\n)/)) {
    const start = offset
    offset += line.length
    if (FENCE.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const links = [...noCode(line).matchAll(LINK)].map((l) => ({ from: l.index, to: l.index + l[0].length }))
    for (const match of prose(line).matchAll(REF)) {
      const { key, other } = refOf(match, repository, foreign)
      if (other) foreign = true
      const from = match.index + (match[1] as string).length
      const end = match.index + match[0].length
      const link = links.find((l) => l.from <= from && end <= l.to)
      found.push({ text: line.slice(from, end), ref: key, index: start + from, after: start + (link ? link.to : end) })
    }
  }
  return found
}

// A title is anyone's text: control characters (a terminal sequence) and format
// characters (bidi controls, zero-width, tags: what reorders or hides text) are
// dropped, with the line separators and variation selectors.
const HIDDEN = '\\p{Cc}\\p{Cf}\\u2028\\u2029\\u034f\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}'
const clean = (title: string) => title.replace(new RegExp(`[${HIDDEN}]`, 'gu'), '').trim()

// What a lookup or the cache gave, made safe to show: the title cleaned and not empty,
// the URL an https address with no spaces or control characters. Null otherwise.
export function entry(title: unknown, url: unknown): { title: string; url: string } | null {
  const t = typeof title === 'string' ? clean(title) : ''
  if (!t || typeof url !== 'string' || !new RegExp(`^https://[^\\s${HIDDEN}]+$`, 'u').test(url)) return null
  return { title: t, url }
}

export interface Cached {
  title: string
  url: string
  at: number
}
// The cache: `{ "owner/repo#n": { title, url, at }, "repository": { name, at, remotes } }`.
// The repository's key holds no `#`, so it never reads as a reference; `remotes` is the
// sha256 of what gh resolved it from (src/refs/resolve.ts): a URL may hold a credential,
// which the cache never copies.
export interface Cache {
  repository: { name: string; at: number; remotes: string } | null
  entries: Map<string, Cached>
}

const fresh = (at: unknown, now: number): at is number => typeof at === 'number' && at <= now && now - at < DAY

// What the file's text holds that is still valid: a corrupt or wrong-shaped file (or none,
// null) reads as empty.
export function parseCache(text: string | null, now: number): Cache {
  const cache: Cache = { repository: null, entries: new Map() }
  let data: unknown
  try {
    data = JSON.parse(text ?? '')
  } catch {
    return cache
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return cache
  for (const [key, value] of Object.entries(data as Record<string, { title?: unknown; url?: unknown; at?: unknown }>)) {
    if (!value || typeof value !== 'object') continue
    if (key === 'repository') {
      const { name, at, remotes } = value as { name?: unknown; at?: unknown; remotes?: unknown }
      if (
        typeof name === 'string' &&
        KEY_REPO.test(name) &&
        fresh(at, now) &&
        typeof remotes === 'string' &&
        /^[0-9a-f]{64}$/.test(remotes)
      ) {
        cache.repository = { name, at, remotes }
      }
      continue
    }
    const e = entry(value.title, value.url)
    if (e && KEY.test(key) && fresh(value.at, now)) cache.entries.set(key, { ...e, at: value.at })
  }
  return cache
}

const newest = <T extends { at: number }>(a: T | null | undefined, b: T | null | undefined) =>
  a && (!b || a.at > b.at) ? a : (b ?? null)

// The text to write: what was found merged with what the file holds just before it is
// replaced, the newest of each key kept.
export function mergedCache(text: string | null, found: Cache, now: number): string {
  const cache = parseCache(text, now)
  for (const [key, value] of found.entries) cache.entries.set(key, newest(value, cache.entries.get(key)) as Cached)
  const repository = newest(found.repository, cache.repository)
  const data = { ...(repository ? { repository } : {}), ...Object.fromEntries(cache.entries) }
  return `${JSON.stringify(data)}\n`
}

// A repository as gh names it, as a key: owner/repo in lower case, null for anything else.
export function repositoryKey(name: string): string | null {
  const key = name.trim().toLowerCase()
  return KEY_REPO.test(key) ? key : null
}

// Why a lookup gh refused gave no title: HTTP 404 or 410 (a missing issue, or a repository the
// token cannot see) is unknown; gh not logged in is off; anything else (the network, a rate
// limit) failed.
export function whyRefused(stderr: string): Why {
  if (/HTTP (404|410)\b/.test(stderr)) return 'unknown'
  if (/gh auth login|HTTP 401/i.test(stderr)) return 'off'
  return 'failed'
}

// The references of a text with their titles, the Promise form of src/refs/resolve.ts for the
// library: git and gh run through `run`, the cache is a file on this machine, `now` the clock.
// It loads Effect when called.
export async function resolveRefs(
  text: string,
  { run, now, cached = false }: { run: RefsRun; now: () => number; cached?: boolean },
): Promise<Refs> {
  const [Effect, { resolveRefs: resolve, overRun }] = await Promise.all([
    import('effect/Effect'),
    import('./refs/resolve.ts'),
  ])
  return Effect.runPromise(resolve(text, { cached, now: Effect.sync(now) }).pipe(Effect.provide(overRun(run))))
}
