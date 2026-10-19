// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N` and ends with a box of what it cited, with their URLs. Display-only: what Claude
// wrote and reads is unchanged. The titles come from `gh`, for the repository of the
// session, cached in <git dir>/lntt-issue-titles.json for a day; what to show is
// issue-titles.mjs, tested on its own.

import { annotate, footer, message, refsIn } from './issue-titles.mjs'

export const DAY = 24 * 60 * 60 * 1000
// Messages kept at once: one interrupted before its last delta is never closed.
const KEPT = 20

export function issueTitles(on) {
  const info = new Map() // number -> { title, url, at }
  const unknown = new Set() // numbers gh did not resolve in this session
  const messages = new Map() // message_id -> what that message has shown so far
  let cache = null // the cache file's path, once looked for (null outside a repository)

  async function readCache($) {
    const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
    if (r.exitCode !== 0) return null
    const file = `${r.stdout.trim()}/lntt-issue-titles.json`
    try {
      if (await $.fs.exists(file)) {
        const now = await $.clock.now()
        for (const [n, v] of Object.entries(JSON.parse(await $.fs.read(file)))) {
          if (now - v.at < DAY) info.set(Number(n), v)
        }
      }
    } catch {}
    return file
  }

  // The title and URL of each number; one gh cannot resolve stays unknown for the
  // session, and its text is shown as written.
  async function lookUp($, numbers) {
    cache ??= readCache($).catch(() => null)
    const file = await cache
    if (!file) return
    const missing = numbers.filter((n) => !info.has(n) && !unknown.has(n))
    if (!missing.length) return
    const now = await $.clock.now()
    await Promise.all(
      missing.map(async (n) => {
        try {
          const r = await $.process.run(['gh', 'api', `repos/{owner}/{repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], {
            timeoutMs: 3000,
          })
          const [title, url] = r.stdout.trim().split('\t')
          if (r.exitCode === 0 && title && url?.startsWith('https://')) info.set(n, { title, url, at: now })
          else unknown.add(n)
        } catch {
          unknown.add(n)
        }
      }),
    )
    try {
      await $.fs.write(file, JSON.stringify(Object.fromEntries(info)))
    } catch {}
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
      await lookUp($, refsIn(delta, m))
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
