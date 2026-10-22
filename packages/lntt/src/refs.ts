// What a number in a text means: each `#N`, `repo#N` or `owner/repo#N` read as an
// issue or pull request of a repository, with its title and URL from `gh`, cached in
// <git dir>/lntt-issue-titles.json for a day. The plugin's issue-titles hook shows what
// this finds; any agent can ask it before writing (`lntt refs`, src/refs-cli.ts).
// Nothing here loads src/index.ts: the hook waits for it on every delta.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pid } from 'node:process'

export const DAY = 24 * 60 * 60 * 1000
// How long each gh call may take: past it, the call counts as failed.
export const GH_TIMEOUT_MS = 3000
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

interface Cached {
  title: string
  url: string
  at: number
}
// The cache: `{ "owner/repo#n": { title, url, at }, "repository": { name, at } }`. The
// repository's key holds no `#`, so it never reads as a reference.
interface Cache {
  repository: { name: string; at: number } | null
  entries: Map<string, Cached>
}

const fresh = (at: unknown, now: number): at is number => typeof at === 'number' && at <= now && now - at < DAY

// What the file holds that is still valid: a corrupt or wrong-shaped file reads as empty.
function readCache(file: string, now: number): Cache {
  const cache: Cache = { repository: null, entries: new Map() }
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return cache
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return cache
  for (const [key, value] of Object.entries(
    data as Record<string, { title?: unknown; url?: unknown; at?: unknown; name?: unknown }>,
  )) {
    if (!value || typeof value !== 'object') continue
    if (key === 'repository') {
      if (typeof value.name === 'string' && KEY_REPO.test(value.name) && fresh(value.at, now)) {
        cache.repository = { name: value.name, at: value.at }
      }
      continue
    }
    const e = entry(value.title, value.url)
    if (e && KEY.test(key) && fresh(value.at, now)) cache.entries.set(key, { ...e, at: value.at })
  }
  return cache
}

// Read, merge and write once, through a temporary file renamed over the cache, so two
// calls at once never leave a torn file. A write that fails is ignored: the titles
// are asked again next time.
function writeCache(file: string, found: Cache, now: number): void {
  try {
    const cache = readCache(file, now)
    for (const [key, value] of found.entries) cache.entries.set(key, value)
    const repository = found.repository ?? cache.repository
    const data = { ...(repository ? { repository } : {}), ...Object.fromEntries(cache.entries) }
    const temporary = `${file}.${pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(temporary, `${JSON.stringify(data)}\n`)
    renameSync(temporary, file)
  } catch {}
}

// The session's repository as gh resolves `#N`: null when gh is missing, not logged in,
// finds no GitHub remote, does not answer in time or answers anything but owner/repo.
async function repositoryOf(run: RefsRun): Promise<string | null> {
  try {
    const r = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], GH_TIMEOUT_MS)
    const name = r.stdout.trim().toLowerCase()
    return r.exitCode === 0 && KEY_REPO.test(name) ? name : null
  } catch {
    return null
  }
}

// One reference's title and URL. HTTP 404 or 410 (a missing issue, or a repository the
// token cannot see) and an answer not safe to show are unknown; gh missing or not
// logged in is off; anything else (a timeout, the network, a rate limit) failed.
async function lookUp(run: RefsRun, key: string): Promise<{ title: string; url: string } | Why> {
  const [, repo, n] = key.match(/^(.+)#(\d+)$/) as string[]
  try {
    const r = await run('gh', ['api', `repos/${repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], GH_TIMEOUT_MS)
    if (r.exitCode !== 0) {
      if (/HTTP (404|410)\b/.test(r.stderr)) return 'unknown'
      if (/gh auth login|HTTP 401/i.test(r.stderr)) return 'off'
      return 'failed'
    }
    const [title, url] = r.stdout.trim().split('\t')
    return entry(title, url) ?? 'unknown'
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? 'off' : 'failed'
  }
}

const none = (ref: string, why: Why): Resolved => ({ ref, title: null, url: null, why })

// The references of a text with their titles. Without the session's repository (outside
// a git repository, gh failing) nothing is looked up and no cached title is read.
// `cached`: no issue is asked of gh, only the cache is read.
export async function resolveRefs(
  text: string,
  { run, now, cached = false }: { run: RefsRun; now: () => number; cached?: boolean },
): Promise<Refs> {
  let gitDir: string | null = null
  try {
    const r = await run('git', ['rev-parse', '--absolute-git-dir'], GH_TIMEOUT_MS)
    if (r.exitCode === 0 && r.stdout.trim()) gitDir = r.stdout.trim()
  } catch {}
  const file = gitDir && `${gitDir}/${CACHE_FILE}`
  const cache = file ? readCache(file, now()) : null
  const found: Cache = { repository: null, entries: new Map() }
  let repository = cache?.repository?.name ?? null
  if (cache && !repository) {
    repository = await repositoryOf(run)
    if (repository) found.repository = { name: repository, at: now() }
  }
  const all = mentions(text, repository)
  const keys = [...new Set(all.flatMap((m) => (m.ref ? [m.ref] : [])))]
  let refs: Resolved[]
  if (!cache || !repository) refs = keys.map((k) => none(k, 'off'))
  else {
    refs = await Promise.all(
      keys.map(async (k): Promise<Resolved> => {
        const hit = cache.entries.get(k)
        if (hit) return { ref: k, title: hit.title, url: hit.url }
        if (cached) return none(k, 'cached')
        const answer = await lookUp(run, k)
        if (typeof answer === 'string') return none(k, answer)
        found.entries.set(k, { ...answer, at: now() })
        return { ref: k, ...answer }
      }),
    )
  }
  if (file && (found.repository || found.entries.size)) writeCache(file, found, now())
  return { repository, mentions: all, refs }
}
