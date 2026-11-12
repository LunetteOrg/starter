// What lntt review prints and shows of a branch's rounds, from values alone: no I/O and no
// Effect, so src/review-cli.ts (status, cost) and src/review/command.ts (a round, a reply,
// allow) share it.

import { type HeadlessAgent as Agent, providerOf } from '../headless.ts'
import {
  type Checked,
  type Closed,
  formatTokens,
  type Ledger,
  type ReviewState,
  roundClean,
  touchedLines,
} from '../review.ts'

// The closed findings of a ledger as it was read: none when it names another branch or is not one.
export function closedIn(ledger: Partial<Ledger> | null, branch: string): Closed[] {
  return ledger?.branch === branch && Array.isArray(ledger.closed) ? ledger.closed : []
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

// Where each agent sends the diff: the project's choice, shown every time.
export function destinations(agents: Agent[]): string {
  return [...new Set(agents.map((a) => `${providerOf(a)} (${a.kind})`))].join(', ')
}

// The decision logs, as the decisions lens needs to find them.
export function records(data: Record<string, unknown>): string {
  const logs = (data.recording as { logs?: Record<string, Record<string, string>> } | undefined)?.logs ?? {}
  return Object.entries(logs)
    .map(([name, log]) => {
      const index = log.index ? `, index ${log.index}` : ''
      return `- ${name}: ${log.path}${index}${log.scope ? ` — ${log.scope}` : ''}`
    })
    .join('\n')
}

export function untouchedIn(diff: string): (path: string, line: number) => boolean {
  const touched = touchedLines(diff)
  return (path, line) => touched !== null && !touched.get(path)?.has(line)
}

// A state written before a field existed, with that field's default.
export function withDefaults(state: ReviewState): ReviewState {
  const result: Partial<ReviewState['result']> = state.result
  return {
    ...state,
    result: {
      ...result,
      scope: result.scope ?? '',
      lenses: result.lenses ?? [],
      findings: result.findings ?? [],
      blocking: result.blocking ?? ['blocker', 'warning'],
      refuted: result.refuted ?? [],
      failed: result.failed ?? [],
      partial: result.partial ?? [],
      skipped: result.skipped ?? [],
      closed: result.closed ?? [],
      preexisting: result.preexisting ?? [],
    } as ReviewState['result'],
  }
}

// A state saved before the rounds were kept: the rounds it ran, none of them with a cost.
// A state of this version keeps `rounds` (empty too) and its gaps show in the numbers.
export function legacyRounds(state: ReviewState | null): number {
  return state && state.rounds === undefined ? state.round : 0
}

export function anchor(f: { path: string | null; line: number | null }): string {
  return f.path === null ? '(no anchor)' : `${f.path}${f.line === null ? '' : `:${f.line}`}`
}

// An error as one short line: a reviewer's can run for lines and pages. The whole of it is in
// `.state.failed`.
export function oneLine(text: string): string {
  const [first = ''] = text.split('\n')
  return first.length > 200 ? `${first.slice(0, 200)}…` : first === text ? text : `${first} …`
}

export function noRoundLine(here: string, running: string): string {
  return `lntt review: no round on ${here} yet${running ? `; ${running}` : ''}`
}

// What the views of a state share: its limit, and what is left of its last round. `closed` is
// its branch's ledger (closedIn).
export function stateView(state: ReviewState, maxRounds: number, closed: Closed[]) {
  const { result } = state
  const allowed = state.allowed ?? 0
  const limit = maxRounds + allowed
  const clean = roundClean(result)
  return {
    allowed,
    limit,
    clean,
    atLimit: state.round >= limit && !clean,
    open: result.findings.filter((f) => f.verdict !== 'withdrawn'),
    replied: result.findings.filter((f) => f.reply !== undefined || f.verdict === 'withdrawn'),
    closed,
    // The branch's pre-existing findings, every round's, and the last round's that a failure
    // kept out of the ledger: listed apart, for the person.
    preexisting: [
      ...closed.filter((c) => c.outcome === 'pre-existing'),
      ...(result.preexisting ?? []).filter((f) => !closed.some((c) => c.id === f.id)),
    ],
    // The last round's own tokens and USD; the branch's total is lntt review cost.
    tokens: result.tokens ?? null,
    cost: result.cost ?? null,
  }
}

// One line of outcome and one per thing to act on: what a round, the limit and status print.
// `also` is one more clause of the outcome: a round running, a round refused.
export function summary(state: ReviewState, view: ReturnType<typeof stateView>, also: string): string[] {
  const { result } = state
  const { open, replied, closed, preexisting, tokens, cost } = view
  const outcome = [
    `round ${state.round} of ${view.limit}`,
    `reviewed ${state.reviewed ?? 'nothing'}`,
    view.clean ? 'clean' : 'not clean',
    ...(view.atLimit ? ['at the limit'] : []),
    ...(also ? [also] : []),
  ]
  const blocked = open.filter((f) => result.blocking.includes(f.severity)).length
  const counts = [
    `${open.length} open${open.length > 0 ? ` (${blocked} blocking)` : ''}`,
    `${replied.length} replied`,
    `${closed.length} closed`,
    ...(preexisting.length > 0 ? [`${preexisting.length} pre-existing`] : []),
    ...(result.failed.length > 0 ? [`${result.failed.length} failed`] : []),
    ...(result.partial.length > 0 ? [`${result.partial.length} partial`] : []),
    ...(result.skipped.length > 0 ? [`${result.skipped.length} skipped`] : []),
    ...(tokens === null ? [] : [formatTokens(tokens)]),
    ...(cost === null ? [] : [`$${cost.toFixed(2)}`]),
  ]
  // Blocking severities first: what keeps the round from being clean.
  const rank = (f: Checked) => (result.blocking.includes(f.severity) ? 0 : 1)
  return [
    `lntt review: ${state.branch}: ${outcome.join(', ')}; ${counts.join(', ')}`,
    ...[...open]
      .sort((a, b) => rank(a) - rank(b))
      .map((f) => `  ${f.id} ${f.severity} ${f.verdict} ${anchor(f)} — ${f.what}`),
    ...result.failed.map((f) => `  ${f.lens} · ${f.agent} failed: ${oneLine(f.error)}`),
    ...result.partial.map((p) => `  ${p.lens} · ${p.agent}: ${p.lines.length} lines not read`),
    ...result.closed.map((f) => `  ${f.id} ${f.severity} repeats ${f.closedBy} ${anchor(f)} — ${f.what}`),
    ...preexisting.map((c) => `  pre-existing ${c.id} ${c.severity} ${anchor(c)} — ${c.what}`),
  ]
}
