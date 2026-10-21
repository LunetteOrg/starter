// What the lntt review band shows, from the progress events lntt review writes (one JSON
// object per line in <git dir>/lntt-review.progress, docs/adr/review-agents.md). Pure:
// the events and the clock in, the band's lines out; register.js reads the file and
// draws them. Nothing here decides anything about the round: it only shows it.

export const SPIN_MS = 120
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const WIDTH = 20
// How long the end of a round, or the error that kept it from starting, stays in view.
const LINGER_MS = 60_000
// lntt review beats every 15 seconds: silence for longer says something is wrong.
const STALE_MS = 45_000

// The events in the progress file; a line that is not JSON (one being written) is skipped.
export function readEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    try {
      if (line.trim()) events.push(JSON.parse(line))
    } catch {}
  }
  return events
}

// The round as the events tell it, or null when there are none. Agents running are
// counted by label, since two agents can carry the same one.
export function fold(events) {
  if (events.length === 0) return null
  const v = {
    round: null,
    pid: null,
    started: null,
    grace: null,
    last: 0,
    lastRequiredEnd: null,
    phase: null,
    total: 0,
    ended: 0,
    failed: 0,
    tokens: 0,
    running: new Map(),
    done: null,
    error: null,
    limit: null,
  }
  for (const e of events) {
    if (typeof e.t === 'number') v.last = e.t
    if (e.type === 'round') {
      Object.assign(v, { round: e.round, pid: e.pid ?? null, started: e.t, grace: e.optionalGraceMs ?? null })
    } else if (e.type === 'phase') {
      Object.assign(v, { phase: e.phase, total: e.total, ended: 0 })
    } else if (e.type === 'start') {
      v.running.set(e.label, [...(v.running.get(e.label) ?? []), { t: e.t, optional: e.optional === true }])
    } else if (e.type === 'end') {
      const same = v.running.get(e.label) ?? []
      if (same[0]?.optional === false) v.lastRequiredEnd = e.t
      if (same.length > 1) v.running.set(e.label, same.slice(1))
      else v.running.delete(e.label)
      if (e.phase === v.phase) v.ended += 1
      if (e.outcome === 'failed') v.failed += 1
      if (typeof e.tokens === 'number') v.tokens += e.tokens
    } else if (e.type === 'done') v.done = e
    else if (e.type === 'error') v.error = e
    else if (e.type === 'limit') v.limit = e
  }
  return v
}

export function tokens(n) {
  if (n < 1000) return `${n} tokens`
  if (Math.round(n / 1000) < 1000) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k tokens`
  return `${Number((n / 1_000_000).toFixed(1))}M tokens`
}

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function bar(done, total) {
  // An end that arrives after its phase changed can push done past total.
  const full = total <= 0 ? 0 : Math.min(WIDTH, Math.round((done / total) * WIDTH))
  return `▕${'█'.repeat(full)}${'░'.repeat(WIDTH - full)}▏`
}

// The band's lines, each with its tone (strong, dim, error, ok), or null for an empty
// band. `alive`: whether the round's lntt review process still runs, null when unknown.
export function bandLines(view, now, alive) {
  if (!view) return null
  if (view.error) {
    if (now - view.error.t >= LINGER_MS) return null
    const what = view.round === null ? 'not started' : `round ${view.round} stopped`
    return [{ text: `lntt review · ${what}: ${view.error.message}`, tone: 'error' }]
  }
  // The round past delivery.review.maxRounds: nothing ran, the person decides.
  if (view.limit) {
    const l = view.limit
    if (now - l.t >= LINGER_MS) return null
    const rounds = (l.maxRounds ?? 0) + (l.allowed ?? 0)
    return [{ text: `lntt review · round ${l.round} not started: limit of ${rounds} rounds · ${l.open ?? 0} open · the person decides`, tone: 'strong' }]
  }
  if (view.done) {
    const d = view.done
    if (now - d.t > LINGER_MS) return null
    const what = d.clean ? 'clean' : `${d.findings ?? 0} findings, ${d.failed ?? 0} failed`
    const tone = d.clean ? 'ok' : d.failed ? 'error' : 'strong'
    return [{ text: `lntt review · round ${d.round} done · ${what} · ${d.refuted ?? 0} refuted · ${tokens(d.tokens ?? 0)}`, tone }]
  }
  if (view.round === null) return null
  if (alive === false) {
    if (now - view.last >= LINGER_MS) return null
    return [{ text: `lntt review · round ${view.round} stopped without finishing (process ${view.pid} is gone)`, tone: 'error' }]
  }
  if (view.phase === null) return null
  const spin = SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]
  const elapsed = view.started === null ? '' : ` · ${seconds(now - view.started)}`
  const out = [
    {
      text: `${spin} lntt review · round ${view.round} · ${view.phase} ${bar(view.ended, view.total)} ${view.ended}/${view.total} · ${tokens(view.tokens)}${elapsed}`,
      tone: 'strong',
    },
  ]
  if (view.failed > 0) out.push({ text: `  ${view.failed} failed`, tone: 'error' })
  if (now - view.last > STALE_MS) out.push({ text: `  no news from lntt review for ${seconds(now - view.last)}`, tone: 'error' })
  const entries = [...view.running.entries()].flatMap(([label, all]) => all.map((r) => [label, r]))
  const shown = entries.slice(0, 3).map(([label, r]) => `${label} (${seconds(now - r.t)})`)
  const more = entries.length > 3 ? ` +${entries.length - 3}` : ''
  // Only optional agents left: the bar waits on them, and they stop after the grace.
  const onlyOptional = entries.length > 0 && entries.every(([, r]) => r.optional)
  if (onlyOptional && view.grace !== null && view.lastRequiredEnd !== null) {
    const left = view.grace - (now - view.lastRequiredEnd)
    out.push({ text: `  waiting on optional: ${shown.join(' · ')}${more} · stops in ${seconds(left)}`, tone: 'dim' })
  } else if (shown.length > 0) {
    out.push({ text: `  running: ${shown.join(' · ')}${more}`, tone: 'dim' })
  }
  return out
}
