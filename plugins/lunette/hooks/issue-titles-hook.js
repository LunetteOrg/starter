// Issue titles on screen: each message Claude writes shows the title beside the first
// `#N` and ends with a box of what it cited, with their URLs. Display-only: what Claude
// wrote and reads is unchanged. The titles come from `gh`, for the repository of the
// session, cached in <git dir>/lntt-issue-titles.json for a day; what to show is
// issue-titles.mjs, tested on its own.

import { annotate, footer, message, refsIn } from './issue-titles.mjs'

const DAY = 24 * 60 * 60 * 1000
const info = new Map() // number -> { title, url, at }
const messages = new Map() // message_id -> what that message has shown so far
let cacheFile // undefined until looked for; null outside a git repository

async function readCache($) {
  cacheFile = null
  try {
    const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
    if (r.exitCode !== 0) return
    cacheFile = `${r.stdout.trim()}/lntt-issue-titles.json`
    if (!(await $.fs.exists(cacheFile))) return
    const now = await $.clock.now()
    for (const [n, v] of Object.entries(JSON.parse(await $.fs.read(cacheFile)))) {
      if (now - v.at < DAY) info.set(Number(n), v)
    }
  } catch {}
}

// The title and URL of each number; one `gh` cannot resolve stays unknown, and its
// text is shown as written.
async function lookUp($, numbers) {
  if (cacheFile === undefined) await readCache($)
  if (!cacheFile) return
  const missing = numbers.filter((n) => !info.has(n))
  if (!missing.length) return
  const now = await $.clock.now()
  await Promise.all(
    missing.map(async (n) => {
      try {
        const r = await $.process.run(['gh', 'api', `repos/{owner}/{repo}/issues/${n}`, '--jq', '[.title, .html_url] | @tsv'], {
          timeoutMs: 5000,
        })
        const [title, url] = r.stdout.trim().split('\t')
        if (r.exitCode === 0 && title && url) info.set(n, { title, url, at: now })
      } catch {}
    }),
  )
  try {
    await $.fs.write(cacheFile, JSON.stringify(Object.fromEntries(info)))
  } catch {}
}

export function issueTitles(on) {
  on('classic.MessageDisplay', async ($, e, next) => {
    const base = await next(e)
    try {
      const delta = base?.displayContent ?? e.delta
      const m = messages.get(e.message_id) ?? message()
      messages.set(e.message_id, m)
      await lookUp($, refsIn(delta, m))
      let shown = annotate(delta, m, info)
      if (e.final) {
        shown += footer(m, info)
        messages.delete(e.message_id)
      }
      return shown === e.delta ? base : { ...base, displayContent: shown }
    } catch {
      return base
    }
  }).catch(($, e, next) => next(e)) // a failing hook shows the message as written
}
