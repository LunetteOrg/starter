// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N`, `repo#N` or `owner/repo#N` and ends with a box of what it cited, with their
// URLs. Display-only: what Claude wrote and reads is unchanged. The titles come from
// `gh`, a bare `#N` from the session's repository, cached in
// <git dir>/lntt-issue-titles.json for a day; what to show is issue-titles.mjs, tested
// on its own. The functions that take `$` are declared at the
// top of the file, as the engine requires; the session's state is passed to them.

import { annotate, entry, footer, hasRefs, message, refsIn } from './issue-titles.mjs'

export const DAY = 24 * 60 * 60 * 1000
// How long a delta waits, for the cache and the titles together: what is slower goes
// on, and its title shows in a later delta (in the box of this message when it arrives
// before the last delta, beside the number from the next message). A cache write still
// running when the session ends is lost, and that title is asked again next time.
export const WAIT_MS = 800
// Messages kept at once: one interrupted before its last delta is never closed.
export const KEPT = 20
// How long each gh call may take: past it, the call counts as failed.
export const GH_TIMEOUT_MS = 3000

// A repository and a reference as the hook keys them: lower case, each name starting
// with a letter or digit.
const KEY_REPO = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/
const KEY = /^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*#[1-9]\d*$/

function session() {
  return {
    info: new Map(), // owner/repo#N -> { title, url, at }
    unknown: new Set(), // references gh answered it does not know (404, 410), for the session
    pending: new Map(), // owner/repo#N -> its lookup, while it runs
    off: false, // gh cannot answer here (missing, not logged in, no GitHub remote)
    home: null, // the session's repository, owner/repo
    writing: Promise.resolve(), // cache writes, one after the other
    messages: new Map(), // message_id -> what that message has shown so far
    cache: null, // the look for the cache file, started at the first number
    file: undefined, // its path once found (null outside a repository)
  }
}

async function readCache($, s) {
  const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
  if (r.exitCode !== 0) return null
  // The session's repository, as gh resolves `#N`: a gh that is missing, not logged in
  // or finds no GitHub remote (or does not answer within GH_TIMEOUT_MS) turns the
  // lookups off, and no cached title is read.
  try {
    const v = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      timeoutMs: GH_TIMEOUT_MS,
    })
    const home = v.stdout.trim().toLowerCase()
    if (v.exitCode === 0 && KEY_REPO.test(home)) s.home = home
    else s.off = true
  } catch {
    s.off = true
  }
  const file = `${r.stdout.trim()}/lntt-issue-titles.json`
  if (!s.home) return file
  try {
    if (await $.fs.exists(file)) {
      const now = await $.clock.now()
      for (const [n, v] of Object.entries(JSON.parse(await $.fs.read(file)) ?? {})) {
        const e = entry(v?.title, v?.url)
        const fresh = typeof v?.at === 'number' && v.at <= now && now - v.at < DAY
        if (e && fresh && KEY.test(n)) s.info.set(n, { ...e, at: v.at })
      }
    }
  } catch {}
  return file
}

// One reference's title and URL. A reference gh answers is not there (not found, gone)
// stays unknown for the session; gh not logged in stops the lookups for the session;
// any other failure (a timeout, the network, a rate limit) is tried again at the next
// lookup.
async function lookUpOne($, s, key) {
  try {
    const [, repo, n] = key.match(/^(.+)#(\d+)$/)
    const r = await $.process.run(['gh', 'api', `repos/${repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], {
      timeoutMs: GH_TIMEOUT_MS,
    })
    if (r.exitCode !== 0) {
      if (/HTTP (404|410)\b/.test(r.stderr)) s.unknown.add(key)
      else if (/gh auth login|HTTP 401/i.test(r.stderr)) s.off = true
      return
    }
    const [title, url] = r.stdout.trim().split('\t')
    const e = entry(title, url)
    if (!e) {
      s.unknown.add(key)
      return
    }
    s.info.set(key, { ...e, at: await $.clock.now() })
    const file = s.file // set before any lookup starts (lookUp), and never unset
    s.writing = s.writing.then(() => $.fs.write(file, JSON.stringify(Object.fromEntries(s.info)))).catch(() => {})
  } catch {}
}

// The session's cache and repository, looked for at the first reference of the session
// and waited for within the delta's timer.
async function ready($, s, wait) {
  if (s.file !== undefined) return
  s.cache ??= readCache($, s)
    .catch(() => null)
    .then((f) => (s.file = f))
  // gh repo view may take all of GH_TIMEOUT_MS: the lookups wait for it in a later
  // delta, this one goes on.
  await Promise.race([s.cache, wait()])
}

// The lookups of these references, waited for within the delta's timer.
async function lookUp($, s, keys, wait) {
  if (!s.file || s.off || !keys.length) return
  for (const k of keys) {
    if (s.info.has(k) || s.unknown.has(k) || s.pending.has(k)) continue
    s.pending.set(
      k,
      lookUpOne($, s, k).finally(() => s.pending.delete(k)),
    )
  }
  const waiting = keys.map((k) => s.pending.get(k)).filter(Boolean)
  if (waiting.length) await Promise.race([Promise.all(waiting), wait()])
}

async function show($, s, e, base) {
  // Without the session's repository nothing can be told for certain: shown as written.
  if (s.file === null || (s.file && !s.home)) return base
  const delta = base?.displayContent ?? e.delta
  let m = s.messages.get(e.message_id)
  if (!m) {
    m = message()
    s.messages.set(e.message_id, m)
    if (s.messages.size > KEPT) s.messages.delete(s.messages.keys().next().value)
  }
  // One timer for the whole wait of a delta, started only when something is waited for.
  let deadline = null
  const wait = () => (deadline ??= $.clock.sleep(WAIT_MS))
  if (hasRefs(delta) || (e.final && m.cited.length)) await ready($, s, wait)
  // The last delta waits once, for its own references and the message's still missing.
  const keys = refsIn(delta, m, s.home)
  await lookUp($, s, e.final ? [...m.cited, ...keys] : keys, wait)
  let shown = annotate(delta, m, s.info, s.home)
  if (e.final) {
    shown += footer(m, s.info, s.home)
    s.messages.delete(e.message_id)
  }
  return shown === delta ? base : { ...base, displayContent: shown }
}

export function issueTitles(on) {
  const s = session()
  on('classic.MessageDisplay', async ($, e, next) => {
    const base = await next(e)
    try {
      return await show($, s, e, base)
    } catch {
      return base
    }
  }).catch(($, e, next) => next(e)) // a failing hook shows the message as written
}
