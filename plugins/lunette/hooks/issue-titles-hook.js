// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N`, `repo#N` or `owner/repo#N` and ends with a box of what it cited, with their
// URLs. Display-only: what Claude wrote and reads is unchanged. Which numbers are
// references, their titles, the cache and the gh calls are `lntt refs`'s (the project's
// node_modules/.bin/lntt, else lntt on PATH); what to show is issue-titles.mjs, tested
// on its own. The functions that take `$` are declared at the top of the file, as the
// engine requires; the session's state is passed to them.

import { annotate, cite, entry, footer, message } from './issue-titles.mjs'

// How long a delta waits, for lntt and the titles together: what is slower goes on, and
// its title shows in a later delta (in the box of this message when it arrives before
// the last delta, beside the number from the next message).
export const WAIT_MS = 800
// Messages kept at once: one interrupted before its last delta is never closed.
export const KEPT = 20
// How long one lntt refs may run: its start, then gh calls of at most three seconds
// each, run together. Past it, lntt counts as unable to answer.
export const LNTT_TIMEOUT_MS = 5000

function session() {
  return {
    info: new Map(), // owner/repo#N -> { title, url }
    unknown: new Set(), // references gh answered it does not know (404, 410), for the session
    pending: new Map(), // owner/repo#N -> its lookup, while it runs
    off: false, // lntt asks gh nothing here (gh missing, not logged in)
    dead: false, // lntt cannot run here, or does not answer: the titles are off
    home: null, // the session's repository, owner/repo, as lntt names it
    lntt: null, // the look for lntt, started at the first number
    messages: new Map(), // message_id -> what that message has shown so far
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

// One lntt refs: its JSON, or null when lntt cannot start, fails or answers anything
// else, which turns the titles off for the session.
async function refs($, s, args, stdin) {
  try {
    s.lntt ??= findLntt($)
    const r = await $.process.run([await s.lntt, 'refs', ...args], { stdin, timeoutMs: LNTT_TIMEOUT_MS })
    const out = r.exitCode === 0 ? JSON.parse(r.stdout) : null
    if (Array.isArray(out?.mentions) && Array.isArray(out?.refs)) return out
  } catch {}
  s.dead = true
  return null
}

// What lntt found, into the session: the titles, what gh does not know, lookups off.
function learn(s, out) {
  if (!out?.repository) return
  for (const r of out.refs) {
    const e = entry(r?.title, r?.url)
    if (e && typeof r.ref === 'string') s.info.set(r.ref, e)
    else if (r?.why === 'unknown') s.unknown.add(r.ref)
    else if (r?.why === 'off') s.off = true
  }
}

// The lookups of these references, one lntt refs for those not yet asked, waited for
// within the delta's timer. A failed one is asked again at the next lookup.
async function lookUp($, s, keys, wait) {
  if (s.off || !keys.length) return
  const todo = keys.filter((k) => !s.info.has(k) && !s.unknown.has(k) && !s.pending.has(k))
  if (todo.length) {
    const call = refs($, s, todo)
      .then((out) => learn(s, out))
      .finally(() => {
        for (const k of todo) s.pending.delete(k)
      })
    for (const k of todo) s.pending.set(k, call)
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
  if (/#[1-9]/.test(delta) || (e.final && m.cited.length)) {
    // An answer later than the wait still counts: its titles and what the message cited
    // go to the box.
    const call = refs($, s, ['--cached'], m.text + delta).then((out) => {
      if (!out?.repository) return out
      s.home = out.repository
      learn(s, out)
      cite(m, out.mentions)
      return out
    })
    const out = await Promise.race([call, wait().then(() => undefined)])
    // Without the session's repository nothing can be told for certain: shown as written.
    if (out === null || (out && !out.repository)) {
      annotate(delta, m, [], s.info)
      return base
    }
    found = out?.mentions ?? []
    // The last delta waits once, for its own references and the message's still missing.
    const keys = found.filter((x) => (e.final || x.index >= m.text.length) && typeof x?.ref === 'string')
    await lookUp($, s, [...new Set(keys.map((x) => x.ref))], wait)
  }
  let shown = annotate(delta, m, found, s.info)
  if (e.final) shown += footer(m, s.info, s.home)
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
