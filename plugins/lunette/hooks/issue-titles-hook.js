// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N` and ends with a box of what it cited, with their URLs. Display-only: what Claude
// wrote and reads is unchanged. The titles come from `gh`, for the repository of the
// session, cached in <git dir>/lntt-issue-titles.json for a day; what to show is
// issue-titles.mjs, tested on its own. The functions that take `$` are declared at the
// top of the file, as the engine requires; the session's state is passed to them.

import { annotate, entry, footer, message, refsIn } from './issue-titles.mjs'

export const DAY = 24 * 60 * 60 * 1000
// How long a delta waits, for the cache and the titles together: what is slower goes
// on, and its title shows in a later delta (in the box of this message when it arrives
// before the last delta, beside the number from the next message). A cache write still
// running when the session ends is lost, and that title is asked again next time.
export const WAIT_MS = 800
// Messages kept at once: one interrupted before its last delta is never closed.
export const KEPT = 20

function session() {
  return {
    info: new Map(), // number -> { title, url, at }
    unknown: new Set(), // numbers gh answered are missing, for the session
    pending: new Map(), // number -> its lookup, while it runs
    off: false, // gh cannot answer here (missing, not logged in, no GitHub remote)
    writing: Promise.resolve(), // cache writes, one after the other
    messages: new Map(), // message_id -> what that message has shown so far
    cache: null, // the look for the cache file, started at the first number
    file: undefined, // its path once found (null outside a repository)
  }
}

async function readCache($, s) {
  const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
  if (r.exitCode !== 0) return null
  try {
    s.off = (await $.process.run(['gh', '--version'], { timeoutMs: 3000 })).exitCode !== 0
  } catch {
    s.off = true
  }
  const file = `${r.stdout.trim()}/lntt-issue-titles.json`
  try {
    if (await $.fs.exists(file)) {
      const now = await $.clock.now()
      for (const [n, v] of Object.entries(JSON.parse(await $.fs.read(file)) ?? {})) {
        const e = entry(v?.title, v?.url)
        const fresh = typeof v?.at === 'number' && v.at <= now && now - v.at < DAY
        if (e && fresh && /^\d+$/.test(n)) s.info.set(Number(n), { ...e, at: v.at })
      }
    }
  } catch {}
  return file
}

// One number's title and URL. A number gh answers is not there (not found, gone)
// stays unknown for the session; gh not logged in, or a repository with no GitHub
// remote, stops the lookups for the session; any other failure (a timeout, the
// network, a rate limit) is tried again at the next lookup.
async function lookUpOne($, s, n) {
  try {
    const r = await $.process.run(['gh', 'api', `repos/{owner}/{repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], {
      timeoutMs: 3000,
    })
    if (r.exitCode !== 0) {
      if (/HTTP (404|410)\b/.test(r.stderr)) s.unknown.add(n)
      else if (/gh auth login|HTTP 401|unable to expand placeholder/i.test(r.stderr)) s.off = true
      return
    }
    const [title, url] = r.stdout.trim().split('\t')
    const e = entry(title, url)
    if (!e) {
      s.unknown.add(n)
      return
    }
    s.info.set(n, { ...e, at: await $.clock.now() })
    const file = s.file
    s.writing = s.writing.then(() => $.fs.write(file, JSON.stringify(Object.fromEntries(s.info)))).catch(() => {})
  } catch {}
}

// The lookups of these numbers, waited for at most WAIT_MS in all. The cache and gh
// are looked for at the first number of the session, not before.
async function lookUp($, s, numbers) {
  if (!numbers.length) return
  // One timer for the whole wait, started only when something is waited for.
  let deadline = null
  const wait = () => (deadline ??= $.clock.sleep(WAIT_MS))
  if (s.file === undefined) {
    s.cache ??= readCache($, s)
      .catch(() => null)
      .then((f) => (s.file = f))
    // gh --version may take its whole timeout (3 s): the lookups wait for it in a
    // later delta, this one goes on.
    await Promise.race([s.cache, wait()])
  }
  if (!s.file || s.off) return
  for (const n of numbers) {
    if (s.info.has(n) || s.unknown.has(n) || s.pending.has(n)) continue
    s.pending.set(
      n,
      lookUpOne($, s, n).finally(() => s.pending.delete(n)),
    )
  }
  const waiting = numbers.map((n) => s.pending.get(n)).filter(Boolean)
  if (waiting.length) await Promise.race([Promise.all(waiting), wait()])
}

async function show($, s, e, base) {
  const delta = base?.displayContent ?? e.delta
  let m = s.messages.get(e.message_id)
  if (!m) {
    m = message()
    s.messages.set(e.message_id, m)
    if (s.messages.size > KEPT) s.messages.delete(s.messages.keys().next().value)
  }
  // The last delta waits once, for its own numbers and the message's still missing.
  await lookUp($, s, e.final ? [...m.cited, ...refsIn(delta, m)] : refsIn(delta, m))
  let shown = annotate(delta, m, s.info)
  if (e.final) {
    shown += footer(m, s.info)
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
