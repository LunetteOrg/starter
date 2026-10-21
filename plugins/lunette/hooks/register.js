// The lntt review band: while a round of `lntt review` runs in this worktree, a band
// above the prompt shows it (its phase as a bar, the tokens, the agents running, a
// failure in red), with no Claude turn; `/review-status` prints the same. It reads the
// progress events lntt review writes to <git dir>/lntt-review.progress and only shows
// them: what to show is review-band.mjs, tested on its own. The issue titles on screen
// are issue-titles-hook.js.

import { issueTitles } from './issue-titles-hook.js'
import { bandLines, fold, ownedBy, readEvents, SPIN_MS } from './review-band.mjs'

let progressFile = null
let session = null // this Claude Code session's id, which lntt review records with its round
let view = null
let alive = null // whether the round's lntt review process still runs, null when unknown

async function locate($) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
    if (r.exitCode === 0) progressFile = `${r.stdout.trim()}/lntt-review.progress`
  } catch {}
}

async function refresh($) {
  if (!progressFile) return
  try {
    if (!(await $.fs.exists(progressFile))) {
      view = null
    } else {
      view = fold(readEvents(await $.fs.read(progressFile)))
    }
    alive = null
    if (view?.pid && !view.done && !view.error) {
      try {
        alive = (await $.process.run(['kill', '-0', String(view.pid)])).exitCode === 0
      } catch {}
    }
    $.ui.invalidate('ui.render')
  } catch {}
}

const running = () => view && view.round !== null && !view.done && !view.error

export function register(on) {
  issueTitles(on)
  on('session.start', async ($, e, next) => {
    try {
      session = await $.session.id()
    } catch {}
    await locate($)
    $.clock.every(1000, () => refresh($))
    // Only the spinner needs the faster redraw, and only while a round runs.
    $.clock.every(SPIN_MS, () => {
      if (running()) $.ui.invalidate('ui.render')
    })
    try {
      await $.command.register({
        name: 'review-status',
        description: 'Show the lntt review round running in this worktree',
        immediate: true,
      })
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ownedBy(view, session)) return next(e)
    const lines = bandLines(view, await $.clock.now(), alive)
    if (!lines) return next(e)
    const { Text, Box } = $.ui.resolve(e)
    const tone = {
      strong: { bold: true },
      dim: { dimColor: true },
      error: { color: 'red', bold: true },
      ok: { color: 'green', bold: true },
    }
    return Box({
      flexDirection: 'column',
      children: [...lines.map((l) => Text({ ...tone[l.tone], children: [l.text] })), await next(e)],
    })
  })

  on('command.run', { command: 'review-status' }, async ($) => {
    const lines = bandLines(view, await $.clock.now(), alive)
    if (!lines || !view) return { text: 'No lntt review round in this worktree.' }
    if (!ownedBy(view, session)) return { text: 'An lntt review round runs in another session of this worktree.' }
    const all = [...view.running.entries()].flatMap(([l, rs]) => rs.map((r) => `  running ${l}${r.optional ? ' (optional)' : ''}`))
    return { text: [...lines.map((l) => l.text), ...all].join('\n') }
  })
}
