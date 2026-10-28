// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N`, `repo#N` or `owner/repo#N` and ends with a box of what it cited, with their
// URLs. Display-only: what Claude wrote and reads is unchanged. Which numbers are
// references, their titles, the cache and the gh calls are `lntt refs`'s (the project's
// node_modules/.bin/lntt, else lntt on PATH); what to show is issue-titles.mjs, tested
// on its own. The functions that take `$` are declared at the top of the file, as the
// engine requires; the session's state is passed to them.

import { annotate, cite, entry, footer, isKey, message, settled } from './issue-titles.mjs'
import { notice } from './notices.mjs'

// How long a delta waits, for lntt and the titles together: what is slower goes on, and
// its title shows in a later delta (in the box of this message when it arrives before
// the last delta, beside the number from the next message).
export const WAIT_MS = 800
// Messages kept at once: one interrupted before its last delta is never closed.
export const KEPT = 20
// How long one gh call of lntt refs may run (GH_TIMEOUT_MS in packages/lntt/src/refs.ts).
const GH_TIMEOUT_MS = 3000
// References one lntt refs is asked for at most: as many as it looks up at once
// (LOOKUPS_AT_ONCE in packages/lntt/src/refs.ts). More go to runs of their own, side by side.
export const KEYS_PER_RUN = 6
// How long one lntt refs may run: a call with no repository cached asks gh for it, then
// for its KEYS_PER_RUN titles together, each within GH_TIMEOUT_MS, and two seconds go to
// node's start and git. Past it, the run failed.
export const LNTT_TIMEOUT_MS = 2 * GH_TIMEOUT_MS + 2000
// Failed runs of lntt in a row that turn the titles off for the session. A run that
// finds no session repository counts as failed: each asks git and gh again.
export const FAILURES = 3
// What an lntt with no `refs` answers (an @lntt/lntt older than it): its usage, exit 2.
const NO_REFS = /usage:|unknown command/i

function session() {
  return {
    info: new Map(), // owner/repo#N -> { title, url }
    unknown: new Set(), // references gh answered it does not know (404, 410), for the session
    pending: new Map(), // owner/repo#N -> its lookup, while it runs
    off: false, // lntt asks gh nothing here (gh missing, not logged in)
    failures: 0, // lntt runs in a row that failed
    dead: false, // lntt has no refs, or failed FAILURES times in a row: the titles are off
    home: null, // the session's repository, owner/repo, as lntt names it
    lntt: null, // the look for lntt, started at the first number
    messages: new Map(), // message_id -> what that message has shown so far
    problem: null, // what keeps the titles off, for its notice (notices.mjs)
    told: false, // the notice was shown: once per session
    gh: null, // the look at gh (auth status), once, when the titles cannot be found
  }
}

// The project's lntt, else the one on PATH.
async function findLntt($) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    const bin = `${r.stdout.trim()}/node_modules/.bin/lntt`
    if (r.exitCode === 0 && (await $.fs.exists(bin))) return bin
  } catch {}
  return 'lntt'
}

// The version of the project's @lntt/lntt, null for an lntt on PATH or one that cannot
// be read.
async function versionOf($, bin) {
  if (bin === 'lntt') return null
  try {
    return JSON.parse(await $.fs.read(bin.replace(/\.bin\/lntt$/, '@lntt/lntt/package.json'))).version ?? null
  } catch {
    return null
  }
}

// Why gh finds nothing, asked once: not installed, or not logged in. Logged in, it is no
// problem of the person's (a repository with no GitHub remote): nothing to tell.
function askGh($, s) {
  s.gh ??= (async () => {
    try {
      const r = await $.process.run(['gh', 'auth', 'status'], { timeoutMs: GH_TIMEOUT_MS })
      if (r.exitCode !== 0) s.problem ??= { kind: 'gh-auth' }
    } catch (error) {
      if (/ENOENT/.test(String(error?.message ?? error))) s.problem ??= { kind: 'gh-missing' }
    }
  })()
  return s.gh
}

// One lntt refs: its JSON, or null when lntt cannot start, runs past its timeout, fails
// or answers anything else. A failed run, and one with no session repository, is tried
// again at the next lookup, until FAILURES in a row; an lntt with no refs turns the
// titles off at once. The runs of one lookup (`batch`) count as one failure at most.
async function refs($, s, args, stdin, batch = { failed: false }) {
  let out = null
  try {
    s.lntt ??= findLntt($)
    const r = await $.process.run([await s.lntt, 'refs', ...args], { stdin, timeoutMs: LNTT_TIMEOUT_MS })
    if (r.exitCode === 2 && NO_REFS.test(r.stderr ?? '')) {
      s.dead = true
      s.problem ??= { kind: 'no-refs', found: await versionOf($, await s.lntt) }
      return null
    }
    if (r.exitCode === 127) s.problem ??= { kind: 'lntt-missing' }
    const json = r.exitCode === 0 ? JSON.parse(r.stdout) : null
    if (Array.isArray(json?.mentions) && Array.isArray(json?.refs)) out = json
  } catch (error) {
    if (/ENOENT/.test(String(error?.message ?? error))) s.problem ??= { kind: 'lntt-missing' }
  }
  // lntt answered, gh found nothing: no repository, or lookups off.
  if (out && (!out.repository || out.refs.some((r) => r?.why === 'off'))) await askGh($, s)
  if (out?.repository) s.failures = 0
  else if (!batch.failed) {
    batch.failed = true
    if (++s.failures >= FAILURES) s.dead = true
  }
  return out
}

// What lntt found, into the session: the titles, what gh does not know, lookups off.
function learn(s, out) {
  if (!out?.repository) return
  for (const r of out.refs) {
    if (!isKey(r?.ref)) continue
    const e = entry(r.title, r.url)
    if (e) s.info.set(r.ref, e)
    else if (r?.why === 'unknown') s.unknown.add(r.ref)
    else if (r?.why === 'off') s.off = true
  }
}

// The lookups of these references, one lntt refs for each KEYS_PER_RUN of those not yet
// asked, side by side, waited for within the delta's timer: a run that ends past it gives
// its titles to a later delta or the box. A failed one is asked again at the next lookup.
async function lookUp($, s, keys, wait) {
  if (s.off || !keys.length) return
  const todo = keys.filter((k) => !s.info.has(k) && !s.unknown.has(k) && !s.pending.has(k))
  const batch = { failed: false }
  for (let i = 0; i < todo.length; i += KEYS_PER_RUN) {
    const run = todo.slice(i, i + KEYS_PER_RUN)
    const call = refs($, s, run, undefined, batch)
      .then((out) => learn(s, out))
      .finally(() => {
        for (const k of run) s.pending.delete(k)
      })
    for (const k of run) s.pending.set(k, call)
  }
  const waiting = [...new Set(keys.map((k) => s.pending.get(k)).filter(Boolean))]
  if (waiting.length) await Promise.race([Promise.all(waiting), wait()])
}

async function show($, s, e, base) {
  if (s.dead) return base
  const delta = base?.displayContent ?? e.delta
  let m = s.messages.get(e.message_id)
  if (!m) {
    m = message()
    s.messages.set(e.message_id, m)
    if (s.messages.size > KEPT) s.messages.delete(s.messages.keys().next().value)
  }
  if (e.final) s.messages.delete(e.message_id)
  // One timer for the whole wait of a delta, started only when something is waited for.
  let deadline = null
  const wait = () => (deadline ??= $.clock.sleep(WAIT_MS))
  let found = []
  const text = m.text + delta
  // lntt reads the message when the delta has a number, or goes on one the text so far
  // ends in (`#` | `138`), or ends where a mention was held back.
  if (/#[1-9]/.test(delta) || /#\d*$/.test(m.text) || m.held || (e.final && m.cited.length)) {
    // An answer later than the wait still counts: its titles and what the message cited
    // go to the box.
    const call = refs($, s, ['--cached'], text).then((out) => {
      if (!out?.repository) return out
      s.home = out.repository
      learn(s, out)
      cite(m, out.mentions, text, e.final)
      return out
    })
    const out = await Promise.race([call, wait().then(() => undefined)])
    // Without the session's repository nothing can be told for certain: shown as written.
    if (out === null || (out && !out.repository)) {
      annotate(delta, m, [], s.info, e.final)
      return base
    }
    found = out?.mentions ?? []
    // The last delta waits once, for its own references and the message's still missing.
    const keys = found.filter((x) => settled(x, text, e.final) && (e.final || x.after >= m.text.length))
    await lookUp($, s, [...new Set(keys.map((x) => x.ref))], wait)
  }
  let shown = annotate(delta, m, found, s.info, e.final)
  if (e.final) shown += footer(m, s.info, s.home)
  return shown === delta ? base : { ...base, displayContent: shown }
}

// The last delta of a message ends with the notice of what keeps the titles off, once in
// the session.
function tell(s, e, shown) {
  if (!e.final || !s.problem || s.told) return shown
  const text = notice(s.problem)
  if (!text) return shown
  s.told = true
  return { ...shown, displayContent: `${shown?.displayContent ?? e.delta}\n${text}` }
}

// `ended`: called when a message's last delta is shown.
export function issueTitles(on, { ended } = {}) {
  const s = session()
  on('classic.MessageDisplay', async ($, e, next) => {
    const base = await next(e)
    if (e.final) ended?.()
    try {
      return tell(s, e, await show($, s, e, base))
    } catch {
      return base
    }
  }).catch(($, e, next) => next(e)) // a failing hook shows the message as written
}
