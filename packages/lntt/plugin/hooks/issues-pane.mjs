// The pane of the issues and pull requests a session cited: `/issues` opens it beside the
// chat, never unasked, and it lists each reference the issue-titles hook has a title for,
// the most recently cited first, with its title and URL. What it lists is what the box
// under each block already learned (`lntt refs`, through issue-titles-hook.js): nothing
// is looked up here. The list lives in `$.state` (the contract is types/index.d.ts), so a
// reload of the plugin keeps it. The data and its rules are here, tested on their own;
// the hook that fills it is issue-titles-hook.js, and `issuesPane` below opens and draws it.

import { entry, isKey, label } from './issue-titles.mjs'

export const PANE = 'lunette-issues'
export const TITLE = 'Issues and pull requests'
// Rows kept, the oldest cited forgotten first (as many as the hook keeps blocks).
export const KEPT = 200
// Writes that lost a race to another write, tried again before the row is let go.
const TRIES = 4

// The session's list: `{ home, rows }`, `home` the session's repository as `owner/repo`
// (or null), each row `{ ref, title, url, at, i }`: `at` when its block was read, `i` its
// place in the block's text. A plain constant with literal names, as `claude plugin
// validate` reads them; its contract is types/index.d.ts.
const CITED = { plugin: 'lunette', key: 'cited' }

// What the state holds, made safe to show again: a value an earlier version of the plugin
// stored in another shape reads as nothing, a row that is not a reference with a title
// and a URL is dropped. Most recently cited first, a block's references in its text's order.
export function rowsOf(value) {
  const rows = Array.isArray(value?.rows) ? value.rows : []
  const good = rows.flatMap((r) => {
    const e = isKey(r?.ref) && Number.isFinite(r.at) && Number.isFinite(r.i) ? entry(r.title, r.url) : null
    return e ? [{ ref: r.ref, ...e, at: r.at, i: r.i }] : []
  })
  return good.sort((a, b) => b.at - a.at || a.i - b.i).slice(0, KEPT)
}

export const homeOf = (value) => (typeof value?.home === 'string' ? value.home : null)

// The list with these references cited at `at`, in this order: each replaces its earlier
// row, so a reference cited again moves to the top. `fresh`: `{ ref, title, url }`.
export function merge(rows, fresh, at) {
  const again = new Set(fresh.map((f) => f.ref))
  return [...fresh.map((f, i) => ({ ...f, at, i })), ...rows.filter((r) => !again.has(r.ref))]
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .slice(0, KEPT)
}

// Writes what a block cited into the session's list: the references with a title, at
// `at`. Never throws: a list that cannot be kept leaves the box as drawn. A write that
// another one beat is made again on what stands.
export async function remember($, { home, fresh, at }) {
  if (!fresh.length) return
  try {
    for (let n = 0; n < TRIES; n += 1) {
      const { value, version } = await $.state.get(CITED)
      const next = { home: home ?? homeOf(value), rows: merge(rowsOf(value), fresh, at) }
      if ((await $.state.set(CITED, next, { ifVersion: version })).isSet) return
    }
  } catch {}
}

// The session's list, as stored. Called while drawing, it subscribes the pane: a later
// write draws it again.
export async function recall($) {
  try {
    const { value } = await $.state.get(CITED)
    return { home: homeOf(value), rows: rowsOf(value) }
  } catch {
    return { home: null, rows: [] }
  }
}

export const EMPTY = 'No issue or pull request cited yet.'

// The rows as lines of text, for a surface that seats no pane: the label, the title, the
// URL under it.
export function textOf({ home, rows }) {
  if (!rows.length) return EMPTY
  return rows.map((r) => `${label(r.ref, home)} ${r.title}\n  ${r.url}`).join('\n')
}

// Registers the slash command; register.js calls it from its one `session.start` hook.
export async function announce($) {
  try {
    await $.command.register({ name: 'issues', description: 'Open a pane with the issues and pull requests this session cited' })
  } catch {}
}

// `/issues` and its pane. `on` is the plugin's, as in register.js.
export function issuesPane(on) {
  // The command opens the pane, and answers with the list as text where no surface draws
  // one (desktop, vscode or mobile that place no pane, a session with no screen).
  on('command.run', { command: 'issues' }, async ($) => {
    let opened = null
    try {
      opened = await $.ui.open({ id: PANE, title: TITLE })
    } catch {}
    if (opened?.isPlaced) return { text: 'Issues pane opened.' }
    return { text: textOf(await recall($)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    try {
      const { home, rows } = await recall($)
      const { Box, Text } = $.ui.resolve(e)
      if (!rows.length) return Text({ dimColor: true, children: [EMPTY] })
      const width = Math.max(...rows.map((r) => label(r.ref, home).length))
      return Box({
        flexDirection: 'column',
        children: rows.map((r) =>
          Box({
            flexDirection: 'column',
            children: [
              Box({
                flexDirection: 'row',
                children: [Text({ bold: true, children: [`${label(r.ref, home).padEnd(width)} `] }), Text({ children: [r.title] })],
              }),
              Text({ dimColor: true, children: [`${' '.repeat(width)} ${r.url}`] }),
            ],
          }),
        ),
      })
    } catch {
      return next(e)
    }
  })
}
