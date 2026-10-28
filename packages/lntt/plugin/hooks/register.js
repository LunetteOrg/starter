// The lntt review band: while a round of `lntt review` runs in this worktree, a band
// above the prompt shows it (its phase as a bar, the tokens, the agents running, a
// failure in red), with no Claude turn; `/review-status` prints the same. It reads the
// progress events lntt review writes to <git dir>/lntt-review.progress and only shows
// them: what to show is review-band.mjs, tested on its own. The issue titles on screen
// are issue-titles-hook.js. At session start it reads the project's .claude/settings.json:
// entries that are not as lntt sync writes them are said in the band, with the command
// that fixes them, until the first message ends.

import { issueTitles } from './issue-titles-hook.js'
import { noticeText, settingsProblems } from './notices.mjs'
import { bandLines, fold, ownedBy, readEvents, SPIN_MS } from './review-band.mjs'

let progressFile = null
let session = null // this Claude Code session's id, which lntt review records with its round
let view = null
let alive = null // whether the round's lntt review process still runs, null when unknown
let settings = null // what .claude/settings.json lacks, said until the first message ends

async function locate($) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--absolute-git-dir'])
    if (r.exitCode === 0) progressFile = `${r.stdout.trim()}/lntt-review.progress`
  } catch {}
}

// The entries of the project's .claude/settings.json that lntt sync would write again.
async function checkSettings($) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
    if (r.exitCode !== 0) return
    const file = `${r.stdout.trim()}/.claude/settings.json`
    // No file: lntt sync writes one. A file that exists and cannot be read (permissions)
    // is no case lntt sync fixes: nothing to say.
    const keys = settingsProblems((await $.fs.exists(file)) ? await $.fs.read(file) : null)
    if (keys.length) settings = noticeText({ kind: 'settings', keys })
  } catch {}
}

// This session's id, read again at every refresh: a /clear gives the session a new one,
// and an id that cannot be read leaves none, never the last one.
async function readSession($) {
  try {
    session = (await $.session.id()) || null
  } catch {
    session = null
  }
}

async function refresh($) {
  await readSession($)
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
  issueTitles(on, {
    ended: () => {
      settings = null
    },
  })
  on('session.start', async ($, e, next) => {
    await locate($)
    await checkSettings($)
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
    const round = ownedBy(view, session) ? bandLines(view, await $.clock.now(), alive) : null
    const lines = [...(settings ? [{ tone: 'dim', text: settings }] : []), ...(round ?? [])]
    if (!lines.length) return next(e)
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
    const said = settings ? `${settings}\n` : ''
    if (view && !ownedBy(view, session))
      return { text: `${said}An lntt review round runs in another session of this worktree.` }
    const lines = bandLines(view, await $.clock.now(), alive)
    if (!lines || !view) return { text: `${said}No lntt review round in this worktree.` }
    const all = [...view.running.entries()].flatMap(([l, rs]) => rs.map((r) => `  running ${l}${r.optional ? ' (optional)' : ''}`))
    return { text: said + [...lines.map((l) => l.text), ...all].join('\n') }
  })
}
