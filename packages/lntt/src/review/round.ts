// One round of lntt review on Effect: the lenses the diff touches, each on its agents, then the
// findings to their verifiers (docs/adr/review-agents.md). The round asks through `ask`, which the
// command builds over the Agents service and its reporter; a brief and a finding's line are
// read through `readBrief` and `cite`, which the command gives over the file system. The
// library's runRound (src/review.ts) runs it with its callbacks on Promises.

import * as Effect from 'effect/Effect'
import type { Cited } from '../check.ts'
import type { HeadlessAgent as Agent, Answer, Question } from '../headless.ts'
import {
  agentLabel,
  anchorOf,
  type Checked,
  type Finding,
  type Found,
  isNoFindings,
  lensApplies,
  mergeFindings,
  type Ask as PromiseAsk,
  type RoundInput as PromiseInput,
  type PromptValues,
  type Proof,
  parseFindings,
  parseOutcome,
  type Range,
  type ReviewConfig,
  type Reviewed,
  type RoundResult,
  renderReviewPrompt,
  renderVerifyPrompt,
  repeats,
  unreadableLines,
  verdict,
  verifiersFor,
} from '../review.ts'

// The agents a round asks, each answer in its question's place.
export type Ask<E = never> = (questions: Question[]) => Effect.Effect<Answer[], E>

export interface RoundInput<E = never> extends PromptValues {
  range: Range
  // The text of a project lens's brief, by its path in the repository.
  readBrief?: (path: string) => Effect.Effect<string, E>
  // Whether the branch left a line as the base had it (touchedLines on the diff from the
  // merge base): only there does a finding keep its pre-existing mark. Absent: nowhere.
  untouched?: (path: string, line: number) => boolean
  // What a finding's line reads (lntt check cite). Absent: no line is read.
  cite?: (path: string, line: number | null) => Effect.Effect<Cited, E>
}

function unmarked<F extends Finding>(f: F): F {
  const { preexisting: _, ...plain } = f
  return plain as F
}

function addTokens(total: number | null, answer: Answer): number | null {
  return answer.ok && answer.reply.tokens !== null ? (total ?? 0) + answer.reply.tokens : total
}

function addCost(total: number | null, answer: Answer): number | null {
  return answer.ok && answer.reply.cost !== null ? Math.round(((total ?? 0) + answer.reply.cost) * 1e6) / 1e6 : total
}

// An answer's tokens and cost in the round's sums, and its agent named where it reported none.
function account(result: RoundResult, answer: Answer, agent: Agent): void {
  result.cost = addCost(result.cost, answer)
  result.tokens = addTokens(result.tokens, answer)
  const label = agentLabel(agent)
  if (!(answer.ok && answer.reply.tokens !== null) && !result.noTokens.includes(label)) result.noTokens.push(label)
  if (!(answer.ok && answer.reply.cost !== null) && !result.noUsd.includes(label)) result.noUsd.push(label)
}

// One round: the lenses the diff touches, every agent of each at once; then every
// finding at a verified severity, each to its verifiers at once. An empty delta asks
// nobody and keeps the findings still open from the last round.
export const runRound = <E>(
  config: ReviewConfig,
  input: RoundInput<E>,
  ask: Ask<E>,
  open: Checked[] = [],
): Effect.Effect<RoundResult, E> =>
  Effect.gen(function* () {
    const round = input.files.length === 0 ? Math.max(1, input.range.round - 1) : input.range.round
    const result: RoundResult = {
      round: input.range.round,
      base: input.base,
      head: input.head,
      scope: input.range.reason,
      lenses: [],
      findings: [],
      refuted: [],
      failed: [],
      partial: [],
      skipped: [],
      closed: [],
      preexisting: [],
      // An empty delta is no round more: it blocks as the round it keeps the number of.
      blocking: round > config.warningRounds ? ['blocker'] : ['blocker', 'warning'],
      cost: null,
      tokens: null,
      noTokens: [],
      noUsd: [],
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
      const brief = def.brief && input.readBrief ? yield* input.readBrief(def.brief) : undefined
      const prompt = renderReviewPrompt(lens, values, brief)
      for (const agent of def.with) jobs.push({ lens, agent, prompt })
    }
    const answers = yield* ask(
      jobs.map(({ lens, agent, prompt }) => ({ agent, prompt, label: `${lens} · ${agentLabel(agent)}` })),
    )
    const reviewed: Reviewed[] = []
    for (const [i, answer] of answers.entries()) {
      const job = jobs[i] as (typeof jobs)[number]
      account(result, answer, job.agent)
      const failed = (error: string, reply?: string) =>
        (job.agent.optional ? result.skipped : result.failed).push({
          lens: job.lens,
          agent: agentLabel(job.agent),
          error,
          ...(reply === undefined ? {} : { reply }),
        })
      if (!answer.ok) {
        failed(answer.error)
        continue
      }
      const findings = parseFindings(answer.reply.text)
      // A reply in another shape is a review that did not happen, not a clean one. A line
      // that cannot be read does not take the readable ones with it: it is reported apart.
      if (findings.length === 0 && !isNoFindings(answer.reply.text)) {
        const lines = unreadableLines(answer.reply.text).length
        failed(
          lines > 0 ? `${lines} finding lines that cannot be read` : 'no finding line and not "no findings"',
          answer.reply.text,
        )
        continue
      }
      const lines = unreadableLines(answer.reply.text)
      // An optional agent never keeps a round from moving on: its unreadable lines are
      // reported in skipped, and its readable findings stand.
      if (lines.length > 0 && job.agent.optional)
        failed(`${lines.length} finding lines that cannot be read`, answer.reply.text)
      else if (lines.length > 0)
        result.partial.push({ lens: job.lens, agent: agentLabel(job.agent), lines, reply: answer.reply.text })
      reviewed.push({ ...job, session: answer.reply.session, findings })
    }
    // Fresh reviewers read only the delta, so a finding still open from the last round
    // would go unseen: it goes back to the verifiers, at any severity, and stays while
    // they cannot refute it on the new head. Without verifiers it stays until withdrawn.
    // Notes are reported once, in the round that found them, and not carried; nor is a
    // finding the ledger closed (a warning accepted open past warningRounds).
    const ledger = input.closed ?? []
    const closedIds = new Set(ledger.map((c) => c.id))
    const carried = open
      .filter((f) => f.verdict !== 'withdrawn' && f.severity !== 'note' && !closedIds.has(f.id))
      .map((f) => ({ ...f }))
    const last = Math.max(0, ...[...open, ...ledger].map((f) => Number(f.id.slice(1)) || 0))
    // A fresh finding at the anchor of one still open is the same finding: it joins it. A
    // pre-existing mark on a line the branch wrote, or on a finding with no line, is dropped:
    // the finding is reported as any other.
    const fresh = mergeFindings(reviewed, last)
      .map((f) =>
        !f.preexisting || (f.path !== null && f.line !== null && input.untouched?.(f.path, f.line)) ? f : unmarked(f),
      )
      .filter((f) => {
        const same = f.path !== null && carried.find((c) => c.path === f.path && c.line === f.line)
        // The same agent finding it again replaces its own entry: its new session is the one
        // a reply resumes.
        if (same)
          same.foundBy = [...same.foundBy.filter((b) => !f.foundBy.some((n) => n.agent === b.agent)), ...f.foundBy]
        return !same
      })
    // A finding on a line past the end of its file is refuted before any verifier is
    // asked; the others carry the line's text to them. A file that is not there may be one
    // the change deletes: its verifiers decide.
    const found: Found[] = []
    for (const f of [...carried, ...fresh]) {
      const cited = f.path === null || !input.cite ? null : yield* input.cite(f.path, f.line)
      if (cited && 'missing' in cited && cited.what === 'file') found.push(unmarked(f))
      else if (cited && 'missing' in cited) {
        const proof = `${anchorOf(f)}: ${cited.missing}`
        result.refuted.push({
          ...f,
          verdict: 'refuted',
          proofs: [{ by: 'lntt check cite', outcome: 'refuted', proof }],
        })
      } else {
        const read = cited ? { ...f, cited: cited.text } : f
        // A fresh finding that repeats a closed one on an unchanged line asks no verifier.
        const repeated = carried.some((c) => c.id === f.id) ? undefined : repeats(read, ledger)
        if (repeated) result.closed.push({ ...read, closedBy: repeated.id, closedWhat: repeated.what })
        else if (read.preexisting) result.preexisting.push(read)
        else found.push(read)
      }
    }
    const kept = found.filter((f) => carried.some((c) => c.id === f.id)).length
    // A finding that proposes a mutation is read like any other: the round runs no test.
    const verified = (i: number): boolean =>
      config.verify !== null && (i < kept || config.verify.severities.includes((found[i] as Found).severity))

    const checks: { finding: number; agent: Agent }[] = []
    found.forEach((f, i) => {
      if (config.verify && verified(i)) {
        for (const agent of verifiersFor(f, config.verify.with)) checks.push({ finding: i, agent })
      }
    })
    const verdicts =
      checks.length === 0
        ? []
        : yield* ask(
            checks.map((c) => ({
              agent: c.agent,
              prompt: renderVerifyPrompt(found[c.finding] as Found, values),
              label: `verify ${(found[c.finding] as Found).id} · ${agentLabel(c.agent)}`,
            })),
          )
    const proofs: Proof[][] = found.map(() => [])
    verdicts.forEach((answer, i) => {
      const check = checks[i] as (typeof checks)[number]
      account(result, answer, check.agent)
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
      const before = i < kept ? (f as Checked) : null
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
  })

// The library's runRound: its asks, its brief and its cited lines on Promises, each rejection
// the round's.
export function runRoundWith(
  config: ReviewConfig,
  input: PromiseInput,
  ask: PromiseAsk,
  open: Checked[],
): Promise<RoundResult> {
  const { readBrief, cite, ...values } = input
  const sync = <A>(run: () => A) => Effect.try({ try: run, catch: (error) => error })
  return Effect.runPromise(
    runRound<unknown>(
      config,
      {
        ...values,
        ...(readBrief ? { readBrief: (path: string) => sync(() => readBrief(path)) } : {}),
        ...(cite ? { cite: (path: string, line: number | null) => sync(() => cite(path, line)) } : {}),
      },
      (questions) => Effect.tryPromise({ try: () => ask(questions), catch: (error) => error }),
      open,
    ),
  )
}
