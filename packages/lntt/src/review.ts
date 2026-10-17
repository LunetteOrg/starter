// `lntt review`: a review round done the same way every time. The configuration says
// who reviews (delivery.review); each lens runs on its agents, headless and read-only,
// all at once; every blocker and warning goes to verifiers briefed to refute it; what
// comes back is one list, by severity. The agent that runs it keeps only the judgement:
// fix, answer the reviewer, or stop and ask.

import { readFileSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Answer, Question } from './headless.ts'
import type { Agent } from './worktree.ts'

export type Severity = 'blocker' | 'warning' | 'note'
const SEVERITIES: Severity[] = ['blocker', 'warning', 'note']

export interface Lens {
  with: Agent[]
  // A brief in the repository, for a lens the package does not ship; null for its own.
  brief: string | null
  // The lens runs only when the diff touches one of these globs; empty: always.
  paths: string[]
}

export interface ReviewConfig {
  reviewers: Record<string, Lens>
  verify: { with: Agent[]; severities: Severity[] } | null
  timeoutMinutes: number
}

export const TEST_PATHS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']

const DEFAULT: ReviewConfig = {
  reviewers: {
    decisions: { with: [{ kind: 'claude', model: 'haiku' }], brief: null, paths: [] },
    code: { with: [{ kind: 'claude', model: 'sonnet' }], brief: null, paths: [] },
    tests: { with: [{ kind: 'claude', model: 'sonnet' }], brief: null, paths: TEST_PATHS },
  },
  verify: { with: [{ kind: 'claude', model: 'sonnet' }], severities: ['blocker', 'warning'] },
  timeoutMinutes: 20,
}

interface RawLens {
  with?: Agent[]
  brief?: string
  paths?: string[]
}

interface RawReview {
  reviewers?: Record<string, RawLens>
  verify?: false | { with?: Agent[]; severities?: Severity[] }
  timeoutMinutes?: number
}

// delivery.review over the defaults, lens by lens. A lens with no agents is off.
export function reviewConfig(data: Record<string, unknown>): ReviewConfig {
  const raw = ((data.delivery as { review?: RawReview } | undefined)?.review ?? {}) as RawReview
  const reviewers: Record<string, Lens> = { ...DEFAULT.reviewers }
  for (const [name, lens] of Object.entries(raw.reviewers ?? {})) {
    const base = DEFAULT.reviewers[name]
    if (!base && !lens.brief) throw new Error(`delivery.review.reviewers.${name} needs a brief: no lens ${name} ships`)
    const merged: Lens = {
      with: lens.with ?? base?.with ?? [],
      brief: lens.brief ?? base?.brief ?? null,
      paths: lens.paths ?? base?.paths ?? [],
    }
    if (merged.with.length === 0) delete reviewers[name]
    else reviewers[name] = merged
  }
  const verify =
    raw.verify === false
      ? null
      : {
          with: raw.verify?.with ?? (DEFAULT.verify?.with as Agent[]),
          severities: raw.verify?.severities ?? (DEFAULT.verify?.severities as Severity[]),
        }
  return { reviewers, verify, timeoutMinutes: raw.timeoutMinutes ?? DEFAULT.timeoutMinutes }
}

export function lensApplies(lens: Lens, files: string[]): boolean {
  return lens.paths.length === 0 || files.some((file) => lens.paths.some((glob) => matchesGlob(file, glob)))
}

export function agentLabel(agent: Agent): string {
  return [agent.kind, agent.model, agent.effort ? `(${agent.effort})` : undefined].filter(Boolean).join(' ')
}

export interface Finding {
  severity: Severity
  path: string | null
  line: number | null
  what: string
  action: string
}

// `- [severity] path:line — what — action`, an em dash or a spaced hyphen between the
// fields; `(no anchor)` in place of the anchor. Other lines are the reviewer talking.
const FINDING = /^\s*[-*]\s*\[(blocker|warning|note)\]\s+(\(no anchor\)|\S+?)\s+(?:—|–|-)\s+(.+?)\s+(?:—|–|-)\s+(.+)$/

export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = []
  for (const line of text.split('\n')) {
    const m = FINDING.exec(line)
    if (!m) continue
    const [, severity, anchor, what, action] = m as unknown as [string, Severity, string, string, string]
    const at = anchor === '(no anchor)' ? null : /^(.+?)(?::(\d+))?$/.exec(anchor)
    findings.push({
      severity,
      path: at ? (at[1] as string) : null,
      line: at?.[2] ? Number(at[2]) : null,
      what: what.trim(),
      action: action.trim(),
    })
  }
  return findings
}

export interface FoundBy {
  lens: string
  agent: string
  session: string | null
}

export interface Found extends Finding {
  id: string
  foundBy: FoundBy[]
}

export interface Reviewed {
  lens: string
  agent: Agent
  session: string | null
  findings: Finding[]
}

// One finding per anchor, at the highest severity any reviewer gave it, with every
// reviewer that found it; findings without an anchor stay apart. Ordered by severity,
// then place; numbered in that order, after `after` (the last id of earlier rounds).
export function mergeFindings(reviewed: Reviewed[], after = 0): Found[] {
  const byAnchor = new Map<string, Omit<Found, 'id'>>()
  let loose = 0
  for (const r of reviewed) {
    for (const f of r.findings) {
      const key = f.path === null ? `loose ${loose++}` : `${f.path}:${f.line ?? ''}`
      const by = { lens: r.lens, agent: agentLabel(r.agent), session: r.session }
      const seen = byAnchor.get(key)
      if (!seen) {
        byAnchor.set(key, { ...f, foundBy: [by] })
        continue
      }
      seen.foundBy.push(by)
      if (SEVERITIES.indexOf(f.severity) < SEVERITIES.indexOf(seen.severity)) {
        Object.assign(seen, { severity: f.severity, what: f.what, action: f.action })
      }
    }
  }
  return [...byAnchor.values()]
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
        (a.path ?? '~').localeCompare(b.path ?? '~') ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .map((f, i) => ({ id: `f${after + i + 1}`, ...f }))
}

// The verifiers other than the agents that found it; those same agents only when no
// other is listed, since a finding left unverified would pass for checked.
export function verifiersFor(found: Found, pool: Agent[]): Agent[] {
  const finders = new Set(found.foundBy.map((b) => b.agent))
  const others = pool.filter((agent) => !finders.has(agentLabel(agent)))
  return others.length > 0 ? others : pool
}

export type Outcome = 'confirmed' | 'refuted' | 'undecided'

// The first word decides, whatever markdown wraps it; anything else is undecided.
function firstWord(text: string): { word: string; rest: string } {
  const [first = '', ...rest] = text.trim().split('\n')
  return { word: first.replace(/[^a-z]/gi, '').toLowerCase(), rest: rest.join('\n').trim() }
}

export function parseOutcome(text: string): { outcome: Outcome; proof: string } {
  const { word, rest } = firstWord(text)
  if (word === 'confirmed' || word === 'refuted' || word === 'undecided') return { outcome: word, proof: rest }
  return { outcome: 'undecided', proof: text.trim() }
}

export function verdict(outcomes: Outcome[]): Outcome {
  if (outcomes.length > 0 && outcomes.every((o) => o === 'confirmed')) return 'confirmed'
  if (outcomes.length > 0 && outcomes.every((o) => o === 'refuted')) return 'refuted'
  return 'undecided'
}

export function parseWithdrawal(text: string): { withdrawn: boolean; reason: string } {
  const { word, rest } = firstWord(text)
  return { withdrawn: word === 'withdrawn', reason: rest || text.trim() }
}

// What lntt review keeps between rounds, in the worktree's git directory.
export interface ReviewState {
  branch: string
  round: number
  reviewed: string
  result: RoundResult
}

export interface Range {
  round: number
  from: string
  whole: boolean
  reason: string
}

// The first round reads the branch from where it left the base; a later one only what
// came after the commit the last round read. After a rebase that commit is gone: the
// whole branch again.
export function roundRange(
  state: ReviewState | null,
  branch: string,
  head: string,
  mergeBase: string,
  isAncestor: (commit: string, of: string) => boolean,
): Range {
  if (!state || state.branch !== branch) return { round: 1, from: mergeBase, whole: true, reason: 'first round' }
  if (!isAncestor(state.reviewed, head)) {
    return {
      round: state.round + 1,
      from: mergeBase,
      whole: true,
      reason: `${state.reviewed} is no longer in the branch: the whole branch`,
    }
  }
  return { round: state.round + 1, from: state.reviewed, whole: false, reason: `the delta since ${state.reviewed}` }
}

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '../agents')

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

export interface PromptValues {
  base: string
  head: string
  files: string[]
  diff: string
  records: string
  scope?: string
}

// The lens brief (shipped, or the text of the project's) inside the common frame.
export function renderReviewPrompt(lens: string, values: PromptValues, brief?: string): string {
  const text = brief ?? readFileSync(join(AGENTS, 'review', `${lens}.md`), 'utf8')
  return fill(readFileSync(join(AGENTS, 'review', 'common.md'), 'utf8'), {
    lens,
    brief: text.trim(),
    scope: values.scope ?? 'The change',
    range: `${values.base}..${values.head}`,
    files: values.files.map((f) => `- ${f}`).join('\n') || '(none)',
    records: values.records || '(none configured)',
    diff: values.diff,
  })
}

function anchorOf(f: Finding): string {
  return f.path === null ? '(no anchor)' : f.line === null ? f.path : `${f.path}:${f.line}`
}

export function renderVerifyPrompt(found: Found, values: PromptValues): string {
  return fill(readFileSync(join(AGENTS, 'verify.md'), 'utf8'), {
    severity: found.severity,
    anchor: anchorOf(found),
    what: found.what,
    action: found.action,
    range: `${values.base}..${values.head}`,
    diff: values.diff,
  })
}

export function renderReplyPrompt(found: Found, answer: string): string {
  return fill(readFileSync(join(AGENTS, 'reply.md'), 'utf8'), {
    id: found.id,
    finding: `[${found.severity}] ${anchorOf(found)} — ${found.what} — ${found.action}`,
    answer,
  })
}

export interface Proof {
  by: string
  outcome: Outcome
  proof: string
}

export type Verdict = Outcome | 'unverified' | 'withdrawn'

export interface Checked extends Found {
  verdict: Verdict
  proofs: Proof[]
}

export interface RoundResult {
  round: number
  base: string
  head: string
  scope: string
  lenses: string[]
  // Confirmed, undecided and unverified findings: what the author acts on.
  findings: Checked[]
  refuted: Checked[]
  failed: { lens: string; agent: string; error: string }[]
  cost: number | null
}

export function roundClean(result: RoundResult): boolean {
  return result.findings.every((f) => f.verdict === 'withdrawn') && result.failed.length === 0
}

export type Ask = (questions: Question[]) => Promise<Answer[]>

export interface RoundInput extends PromptValues {
  range: Range
  // The text of a project lens's brief, by its path in the repository.
  readBrief?: (path: string) => string
}

function addCost(total: number | null, answer: Answer): number | null {
  return answer.ok && answer.reply.cost !== null ? Math.round(((total ?? 0) + answer.reply.cost) * 1e6) / 1e6 : total
}

// One round: the lenses the diff touches, every agent of each at once; then every
// finding at a verified severity, each to its verifiers at once. An empty delta asks
// nobody and keeps the findings still open from the last round.
export async function runRound(
  config: ReviewConfig,
  input: RoundInput,
  ask: Ask,
  open: Checked[] = [],
): Promise<RoundResult> {
  const result: RoundResult = {
    round: input.range.round,
    base: input.base,
    head: input.head,
    scope: input.range.reason,
    lenses: [],
    findings: [],
    refuted: [],
    failed: [],
    cost: null,
  }
  if (input.files.length === 0) {
    result.findings = open.filter((f) => f.verdict !== 'withdrawn')
    return result
  }
  const values = { ...input, scope: input.range.reason }
  const jobs: { lens: string; agent: Agent; prompt: string }[] = []
  for (const [lens, def] of Object.entries(config.reviewers)) {
    if (!lensApplies(def, input.files)) continue
    result.lenses.push(lens)
    const brief = def.brief ? (input.readBrief ?? ((p) => readFileSync(p, 'utf8')))(def.brief) : undefined
    const prompt = renderReviewPrompt(lens, values, brief)
    for (const agent of def.with) jobs.push({ lens, agent, prompt })
  }
  const answers = await ask(
    jobs.map(({ lens, agent, prompt }) => ({ agent, prompt, label: `${lens} · ${agentLabel(agent)}` })),
  )
  const reviewed: Reviewed[] = []
  answers.forEach((answer, i) => {
    const job = jobs[i] as (typeof jobs)[number]
    result.cost = addCost(result.cost, answer)
    if (!answer.ok) result.failed.push({ lens: job.lens, agent: agentLabel(job.agent), error: answer.error })
    else reviewed.push({ ...job, session: answer.reply.session, findings: parseFindings(answer.reply.text) })
  })
  // Fresh reviewers read only the delta, so a finding still open from the last round
  // would go unseen: it goes back to the verifiers, at any severity, and stays while
  // they cannot refute it on the new head. Without verifiers it stays until withdrawn.
  const carried = open.filter((f) => f.verdict !== 'withdrawn')
  const last = Math.max(0, ...carried.map((f) => Number(f.id.slice(1)) || 0))
  const fresh = mergeFindings(reviewed, last)
  const found: Found[] = [...carried, ...fresh]
  const verified = (i: number): boolean =>
    config.verify !== null && (i < carried.length || config.verify.severities.includes((found[i] as Found).severity))

  const checks: { finding: number; agent: Agent }[] = []
  found.forEach((f, i) => {
    if (config.verify && verified(i)) {
      for (const agent of verifiersFor(f, config.verify.with)) checks.push({ finding: i, agent })
    }
  })
  const verdicts = await (checks.length > 0
    ? ask(
        checks.map((c) => ({
          agent: c.agent,
          prompt: renderVerifyPrompt(found[c.finding] as Found, values),
          label: `verify ${(found[c.finding] as Found).id} · ${agentLabel(c.agent)}`,
        })),
      )
    : Promise.resolve([]))
  const proofs: Proof[][] = found.map(() => [])
  verdicts.forEach((answer, i) => {
    const check = checks[i] as (typeof checks)[number]
    result.cost = addCost(result.cost, answer)
    const by = agentLabel(check.agent)
    proofs[check.finding]?.push(
      answer.ok ? { by, ...parseOutcome(answer.reply.text) } : { by, outcome: 'undecided', proof: answer.error },
    )
  })
  found.forEach((f, i) => {
    const mine = proofs[i] as Proof[]
    const before = i < carried.length ? (f as Checked) : null
    const checked: Checked = {
      ...f,
      verdict: verified(i) ? verdict(mine.map((p) => p.outcome)) : (before?.verdict ?? 'unverified'),
      proofs: mine,
    }
    if (checked.verdict === 'refuted') result.refuted.push(checked)
    else result.findings.push(checked)
  })
  return result
}
