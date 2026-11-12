// Issue titles on screen: a block of a message that cites issues or pull requests ends
// with a box of them, with their titles and URLs, drawn by a `ui.render` hook on
// AssistantMessage (the built-in plugins skip a classic.MessageDisplay hook). Display-only:
// what Claude wrote and reads is unchanged. The block's text is read whole (`e.props.text`)
// once it stops growing; the hook never waits for lntt: it draws what the session knows
// and a lookup that ends later redraws the blocks (`$.ui.invalidate`). A block drawn again
// (a scroll) asks lntt for nothing the session knows. Which numbers are references, their
// titles, the cache and the gh calls are `lntt refs`'s (the project's
// node_modules/.bin/lntt, else lntt on PATH); what to show is issue-titles.mjs, tested on
// its own. The functions that take `$` are declared at the top of the file, as the engine
// requires; the session's state is passed to them.

import { box, cite, entry, isKey, message, settled } from './issue-titles.mjs'
import { remember } from './issues-pane.mjs'
import { noticeText } from './notices.mjs'

// How long a block's text must stay as it is before lntt reads it: a block streams in
// and is drawn at each step, and only its last text is asked for.
export const SETTLE_MS = 300
// Blocks the session remembers the references of, the oldest forgotten first.
export const KEPT = 200
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
    blocks: new Map(), // text of a block -> what it cited ({ cited }), once lntt has read it
    waiting: new Set(), // texts drawn and not yet read: the last of a growing block is
    noticeOn: null, // the text of the block that carries the notice
    problem: null, // what keeps the titles off, for its notice (notices.mjs)
    told: false, // the notice was given to a block: once per session
    gh: null, // the look at gh (auth status), once, when the titles cannot be found
    at: 0, // when the last block was read, for the pane's order (strictly rising)
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
// asked, side by side, all waited for. A failed one is asked again at the next lookup, by
// another block.
async function lookUp($, s, keys) {
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
  if (waiting.length) await Promise.all(waiting)
}

// When a block was read, for the order of the pane of issues: the clock's time, and
// always later than the block read before it.
async function stamp($, s) {
  let now = 0
  try {
    now = await $.clock.now()
  } catch {}
  s.at = Math.max(Number.isFinite(now) ? now : 0, s.at + 1)
  return s.at
}

// What the block shows now: its box lines, from what the session knows.
function linesOf(s, text) {
  const m = s.blocks.get(text)
  return m ? box(m, s.info, s.home) : []
}

// A signature of what a block would show, to redraw only when it changes.
const signature = (lines) => JSON.stringify(lines)

// A block's references and titles, read once its text has settled; each stage that changes
// what the block shows redraws it. Never throws: a failing lookup leaves the block as drawn.
async function read($, s, text) {
  await $.clock.sleep(SETTLE_MS)
  // The block grew meanwhile (a longer text was drawn): only the last is read.
  if (!s.waiting.delete(text) || s.dead) return
  let drawn = signature(linesOf(s, text))
  const redraw = (force = false) => {
    const now = signature(linesOf(s, text))
    if (now === drawn && !force) return
    drawn = now
    $.ui.invalidate('ui.render')
  }
  const out = await refs($, s, ['--cached'], text)
  if (out?.repository) {
    s.home = out.repository
    learn(s, out)
  }
  const m = message()
  // Without the session's repository nothing can be told for certain: shown as written.
  if (out?.repository) cite(m, out.mentions, text)
  s.blocks.set(text, m)
  if (s.blocks.size > KEPT) s.blocks.delete(s.blocks.keys().next().value)
  const at = out?.repository ? await stamp($, s) : 0
  const found = out?.repository ? out.mentions.filter((x) => settled(x, text)) : []
  // A number that touches the end of the text may be cut in two by a pause (#1 of #138):
  // it waits one more SETTLE_MS, and is looked up only if the block did not grow.
  const early = [...new Set(found.filter((x) => x.after < text.length).map((x) => x.ref))]
  const last = [...new Set(found.filter((x) => x.after >= text.length).map((x) => x.ref))]
  // What the block cited and the session has a title for goes to the pane's list
  // (issues-pane.mjs), again when a title arrives; a block that grew since is no longer
  // the one on screen and writes nothing. The numbers at the end of the text wait for
  // `whole`, as their lookup does.
  const save = (whole = false) =>
    s.blocks.get(text) === m
      ? remember($, {
          home: s.home,
          at,
          fresh: m.cited.flatMap((k) => (s.info.has(k) && (whole || early.includes(k)) ? [{ ref: k, ...s.info.get(k) }] : [])),
        })
      : undefined
  if (out?.repository) {
    // The block is drawn at once; the list is written after, so a slow state never holds it.
    redraw()
    await save()
    // Waited for here, off the drawing: the block is drawn as it is until it ends.
    await lookUp($, s, early)
    await save()
    if (last.length) {
      await $.clock.sleep(SETTLE_MS)
      if (s.blocks.get(text) === m && !s.dead) {
        await lookUp($, s, last)
        await save(true)
      }
    }
  }
  // The notice of what keeps the titles off goes to the first block that finds it out
  // and is still drawn: one that grew meanwhile leaves it to the next.
  if (s.problem && !s.told && s.blocks.get(text) === m && noticeText(s.problem)) {
    s.told = true
    s.noticeOn = text
    redraw(true)
  } else redraw()
}

// The block as drawn by the engine, with the box of what it cited under it, and the
// notice when it carries it.
function draw($, s, e, base) {
  const text = e.props.text
  if (typeof text !== 'string' || !/#[1-9]/.test(text)) return base
  if (!s.dead && !s.blocks.has(text) && !s.waiting.has(text)) {
    // A longer text drawn replaces the shorter one it began with: the block grew, and the
    // shorter is neither read nor kept.
    for (const t of s.waiting) if (text.startsWith(t)) s.waiting.delete(t)
    for (const t of s.blocks.keys()) if (t !== text && text.startsWith(t)) s.blocks.delete(t)
    s.waiting.add(text)
    read($, s, text).catch(() => {})
  }
  const lines = linesOf(s, text)
  const note = s.noticeOn === text && s.problem ? noticeText(s.problem) : ''
  if (!lines.length && !note) return base
  const { Box, Text } = $.ui.resolve(e)
  const segment = (g) => Text({ dimColor: g.dim, children: [g.text] })
  return Box({
    flexDirection: 'column',
    children: [
      base,
      ...lines.map((line) => Box({ flexDirection: 'row', children: line.map(segment) })),
      ...(note ? [Text({ dimColor: true, children: [note] })] : []),
    ],
  })
}

// `ended`: called when a turn ends.
export function issueTitles(on, { ended } = {}) {
  const s = session()
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const base = await next(e)
    try {
      return draw($, s, e, base)
    } catch {
      return base
    }
  }).catch(($, e, next) => next(e)) // a failing hook draws the block as Claude Code does
  on('turn.complete', async ($, e, next) => {
    try {
      ended?.()
    } catch {}
    return next(e)
  })
}
