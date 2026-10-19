// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N` and ends with a box of what it cited, with their URLs. Display-only: what Claude
// wrote and reads is unchanged. The titles come from `gh`, for the repository of the
// session, cached in <git dir>/lntt-issue-titles.json for a day; what to show is
// issue-titles.mjs, tested on its own.

import { annotate, entry, footer, message, refsIn } from './issue-titles.mjs'

export const DAY = 24 * 60 * 60 * 1000
// How long a delta waits for titles: a slower lookup goes on, and its title shows in
// the message's box, and beside the number from the next message.
export const WAIT_MS = 800
// Messages kept at once: one interrupted before its last delta is never closed.
export const KEPT = 20

export function issueTitles(on) {
  const info = new Map() // number -> { title, url, at }
  const unknown = new Set() // numbers gh answered it does not know, for the session
  const pending = new Map() // number -> its lookup, while it runs
  const messages = new Map() // message_id -> what that message has shown so far
  let cache = null // the cache file's path, once looked for (null outside a repository)

  async function readCache($) {
    const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
    if (r.exitCode !== 0) return null
    const file = `${r.stdout.trim()}/lntt-issue-titles.json`
    try {
      if (await $.fs.exists(file)) {
        const now = await $.clock.now()
        for (const [n, v] of Object.entries(JSON.parse(await $.fs.read(file)) ?? {})) {
          const e = entry(v?.title, v?.url)
          if (e && typeof v.at === 'number' && now - v.at < DAY) info.set(Number(n), { ...e, at: v.at })
        }
      }
    } catch {}
    return file
  }

  // One number's title and URL. A number gh answers it does not know (not found) stays
  // unknown for the session; any other failure (a timeout, the network, auth, a rate
  // limit) is tried again at the next lookup.
  async function lookUpOne($, file, n) {
    try {
      const r = await $.process.run(['gh', 'api', `repos/{owner}/{repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], {
        timeoutMs: 3000,
      })
      if (r.exitCode !== 0) {
        if (/Not Found|HTTP 404/i.test(r.stderr)) unknown.add(n)
        return
      }
      const [title, url] = r.stdout.trim().split('\t')
      const e = entry(title, url)
      if (!e) {
        unknown.add(n)
        return
      }
      info.set(n, { ...e, at: await $.clock.now() })
      await $.fs.write(file, JSON.stringify(Object.fromEntries(info)))
    } catch {}
  }

  // The lookups of these numbers, waited for at most WAIT_MS.
  async function lookUp($, numbers) {
    cache ??= readCache($).catch(() => null)
    const file = await cache
    if (!file) return
    for (const n of numbers) {
      if (info.has(n) || unknown.has(n) || pending.has(n)) continue
      pending.set(
        n,
        lookUpOne($, file, n).finally(() => pending.delete(n)),
      )
    }
    const waiting = numbers.map((n) => pending.get(n)).filter(Boolean)
    if (waiting.length) await Promise.race([Promise.all(waiting), $.clock.sleep(WAIT_MS)])
  }

  on('classic.MessageDisplay', async ($, e, next) => {
    const base = await next(e)
    try {
      const delta = base?.displayContent ?? e.delta
      let m = messages.get(e.message_id)
      if (!m) {
        m = message()
        messages.set(e.message_id, m)
        if (messages.size > KEPT) messages.delete(messages.keys().next().value)
      }
      // The last delta waits once, for its own numbers and the message's still missing.
      await lookUp($, e.final ? [...m.cited, ...refsIn(delta, m)] : refsIn(delta, m))
      let shown = annotate(delta, m, info)
      if (e.final) {
        shown += footer(m, info)
        messages.delete(e.message_id)
      }
      return shown === delta ? base : { ...base, displayContent: shown }
    } catch {
      return base
    }
  }).catch(($, e, next) => next(e)) // a failing hook shows the message as written
}
