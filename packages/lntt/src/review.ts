// `lntt review`: a review round done the same way every time. The configuration says
// who reviews (delivery.review); each lens runs on its agents, headless and read-only,
// all at once; every blocker and warning goes to verifiers briefed to refute it; what
// comes back is one list, by severity. The agent that runs it keeps only the judgement:
// fix, answer the reviewer, or stop and ask.

import { readFileSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HeadlessAgent as Agent, Answer, Question } from './headless.ts'

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
  // Agents of one provider running at once.
  perProvider: number
  // How long optional agents may go on once the others have answered.
  optionalGraceMinutes: number
  // How long a whole round may take before every agent still running is stopped.
  roundTimeoutMinutes: number
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
  perProvider: 4,
  optionalGraceMinutes: 2,
  roundTimeoutMinutes: 60,
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
  perProvider?: number
  optionalGraceMinutes?: number
  roundTimeoutMinutes?: number
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
  return {
    reviewers,
    verify,
    timeoutMinutes: raw.timeoutMinutes ?? DEFAULT.timeoutMinutes,
    perProvider: raw.perProvider ?? DEFAULT.perProvider,
    optionalGraceMinutes: raw.optionalGraceMinutes ?? DEFAULT.optionalGraceMinutes,
    roundTimeoutMinutes: raw.roundTimeoutMinutes ?? DEFAULT.roundTimeoutMinutes,
  }
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
// fields; `(no anchor)` in place of the anchor. Backticks and bold around the severity
// or the anchor, which models add, are dropped first. Other lines are the reviewer
// talking.
const FINDING = /^\s*[-*]\s*\[(blocker|warning|note)\]\s+(\(no anchor\)|\S+?)\s+(?:—|–|-)\s+(.+?)\s+(?:—|–|-)\s+(.+)$/

function unwrap(line: string): string {
  return line.replace(/^(\s*[-*]\s*)\*\*(\[\w+\])\*\*/, '$1$2').replace(/(\]\s+)[`*]+([^\s`*]+)[`*]+(?=\s)/, '$1$2')
}

// The reply of a reviewer that found nothing, wrapped in whatever markdown it adds.
export function isNoFindings(text: string): boolean {
  return /^no findings\.?$/i.test(text.replace(/[`*_]/g, '').trim())
}

// A finding line starts with a bullet and a severity in brackets; models wrap long ones,
// so the lines after it, up to the next bullet or a blank line, belong to it.
const FINDING_START = /^\s*[-*]\s*(\*\*)?\[(blocker|warning|note)\]/

function findingLines(text: string): string[] {
  const out: string[] = []
  let open = false
  for (const raw of text.split('\n')) {
    if (FINDING_START.test(raw)) {
      out.push(raw.trim())
      open = true
    } else if (open && raw.trim() !== '' && !/^\s*[-*#]/.test(raw)) {
      out[out.length - 1] = `${out[out.length - 1]} ${raw.trim()}`
    } else open = false
  }
  return out
}

// Finding lines that do not read as `[severity] anchor — what — action`: a reply with
// any of them is not a review that can be trusted whole.
export function unreadableFindings(text: string): number {
  return findingLines(text).filter((line) => !FINDING.exec(unwrap(line))).length
}

export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = []
  for (const raw of findingLines(text)) {
    const line = unwrap(raw)
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

// The verifiers other than the agents that found it. Since an optional verifier may be
// stopped before it answers, at least one required verifier always checks it: the
// finders among them when no other required one is listed, and the whole pool when
// nothing else is left, since a finding left unverified would pass for checked.
export function verifiersFor(found: Found, pool: Agent[]): Agent[] {
  const finders = new Set(found.foundBy.map((b) => b.agent))
  const others = pool.filter((agent) => !finders.has(agentLabel(agent)))
  if (others.length === 0) return pool
  if (others.some((agent) => !agent.optional)) return others
  return [...others, ...pool.filter((agent) => !agent.optional && finders.has(agentLabel(agent)))]
}

export type Outcome = 'confirmed' | 'refuted' | 'undecided'

// The first word decides, whatever markdown wraps it, and the proof may follow it on the
// same line (`refuted: a.ts:2 guards it`); anything else is undecided.
function firstWord(text: string): { word: string; rest: string } {
  const m = /^[^a-z]*([a-z]+)\b[^a-z0-9`(]*([\s\S]*)$/i.exec(text.trim())
  return m ? { word: (m[1] as string).toLowerCase(), rest: (m[2] as string).trim() } : { word: '', rest: '' }
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
  // The last commit every reviewer read; null when no round has read the branch whole.
  reviewed: string | null
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
  if (state.reviewed === null) {
    return {
      round: state.round + 1,
      from: mergeBase,
      whole: true,
      reason: 'no round read the whole branch: the whole branch',
    }
  }
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
  // The verifier did not answer: its proof is the error, and it has no say in the verdict.
  failed?: true
}

export interface Failure {
  lens: string
  agent: string
  error: string
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
  // Agents that did not answer: a failure keeps the round from being clean.
  failed: Failure[]
  // Optional agents that did not answer: reported, never blocking.
  skipped: Failure[]
  cost: number | null
  // Every token the round's agents took, where they report it.
  tokens: number | null
}

// Notes are reported, never blocking: a round is clean when no blocker or warning is
// left open and no reviewer or verifier failed.
export function roundClean(result: RoundResult): boolean {
  return result.findings.every((f) => f.severity === 'note' || f.verdict === 'withdrawn') && result.failed.length === 0
}

export type Ask = (questions: Question[]) => Promise<Answer[]>

export interface RoundInput extends PromptValues {
  range: Range
  // The text of a project lens's brief, by its path in the repository.
  readBrief?: (path: string) => string
}

function addTokens(total: number | null, answer: Answer): number | null {
  return answer.ok && answer.reply.tokens !== null ? (total ?? 0) + answer.reply.tokens : total
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
    skipped: [],
    cost: null,
    tokens: null,
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
  for (const [i, answer] of answers.entries()) {
    const job = jobs[i] as (typeof jobs)[number]
    result.cost = addCost(result.cost, answer)
    result.tokens = addTokens(result.tokens, answer)
    const failed = (error: string) =>
      (job.agent.optional ? result.skipped : result.failed).push({
        lens: job.lens,
        agent: agentLabel(job.agent),
        error,
      })
    if (!answer.ok) {
      failed(answer.error)
      continue
    }
    const findings = parseFindings(answer.reply.text)
    // A reply in another shape is a review that did not happen, not a clean one; one
    // finding line that cannot be read makes the whole reply unreadable.
    const unreadable = unreadableFindings(answer.reply.text)
    if (unreadable > 0 || (findings.length === 0 && !isNoFindings(answer.reply.text))) {
      const why =
        unreadable > 0 ? `${unreadable} finding lines that cannot be read` : 'no finding line and not "no findings"'
      failed(`${why}: ${answer.reply.text.trim().slice(0, 160)}`)
      continue
    }
    reviewed.push({ ...job, session: answer.reply.session, findings })
  }
  // Fresh reviewers read only the delta, so a finding still open from the last round
  // would go unseen: it goes back to the verifiers, at any severity, and stays while
  // they cannot refute it on the new head. Without verifiers it stays until withdrawn.
  // Notes are reported once, in the round that found them, and not carried.
  const carried = open.filter((f) => f.verdict !== 'withdrawn' && f.severity !== 'note').map((f) => ({ ...f }))
  const last = Math.max(0, ...open.map((f) => Number(f.id.slice(1)) || 0))
  // A fresh finding at the anchor of one still open is the same finding: it joins it.
  const fresh = mergeFindings(reviewed, last).filter((f) => {
    const same = f.path !== null && carried.find((c) => c.path === f.path && c.line === f.line)
    // The same agent finding it again replaces its own entry: its new session is the one
    // a reply resumes.
    if (same) same.foundBy = [...same.foundBy.filter((b) => !f.foundBy.some((n) => n.agent === b.agent)), ...f.foundBy]
    return !same
  })
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
    result.tokens = addTokens(result.tokens, answer)
    const by = agentLabel(check.agent)
    if (!answer.ok) {
      const failure = { lens: `verify ${(found[check.finding] as Found).id}`, agent: by, error: answer.error }
      ;(check.agent.optional ? result.skipped : result.failed).push(failure)
    }
    proofs[check.finding]?.push(
      answer.ok
        ? { by, ...parseOutcome(answer.reply.text) }
        : { by, outcome: 'undecided', proof: answer.error, failed: true },
    )
  })
  found.forEach((f, i) => {
    const mine = proofs[i] as Proof[]
    const before = i < carried.length ? (f as Checked) : null
    const checked: Checked = {
      ...f,
      // Only the verifiers that answered decide; none answering leaves it undecided.
      verdict: verified(i)
        ? verdict(mine.filter((p) => !p.failed).map((p) => p.outcome))
        : (before?.verdict ?? 'unverified'),
      proofs: mine,
    }
    if (checked.verdict === 'refuted') result.refuted.push(checked)
    else result.findings.push(checked)
  })
  return result
}
