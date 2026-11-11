// The commands of `lntt review` that hold the worktree's lock, on Effect: a round, a reply, and
// `allow` (docs/adr/effect-in-lntt.md). src/review-cli.ts loads this module only for them, so
// `lntt review status` and `cost` do not load Effect.
//
// A command runs in one scope, the command's: the worktree's lock is a resource of that scope,
// and the agents run in a scope inside it (withAgents). However the command ends (an answer, a
// failure, an interrupt), the agents are released first, then the lock.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import type { FileSystem } from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import { branchRules } from '../branch.ts'
import { cite, formatJson, isArea, runArea } from '../check.ts'
import { exit } from '../exit.ts'
import { type HeadlessAgent as Agent, askAll, type Spawn, timerMs } from '../headless.ts'
import { projectPhase } from '../index.ts'
import { orcaSubagents, type Subagents } from '../orca-subagents.ts'
import {
  agentLabel,
  type Checked,
  closedEntry,
  closeRound,
  formatTokens,
  lensApplies,
  parseWithdrawal,
  type ReviewConfig,
  type ReviewState,
  renderReplyPrompt,
  reviewConfig,
  reviewCost,
  reviewedAfter,
  reviewWarnings,
  roundClean,
  roundCosts,
  roundLimit,
  roundRange,
  runRound,
} from '../review.ts'
import {
  agentProblems,
  destinations,
  duration,
  emit,
  failed,
  git,
  headBranch,
  loaded,
  mergeBase,
  readLedger,
  readState,
  records,
  reporter,
  startProgress,
  stateView,
  stopAtLimit,
  summary,
  untouchedIn,
  usage,
  writeLedger,
  writeState,
} from '../review-cli.ts'
import { runCommand } from '../run-command.ts'
import { commandExists } from '../viewer.ts'
import { type LockedError, lockWorktree, type Pids, WorktreeLockLive } from '../worktree/lock.ts'
import { AgentsLive, withAgents } from './agents.ts'

// What a command is given: the agents' spawner, and the worktree's lock, taken in the command's
// scope whichever step takes it.
type Tools = {
  spawner: (timeoutMinutes: number) => Spawn
  lock: (command: string) => Effect.Effect<void, LockedError | PlatformError, FileSystem | Pids>
}

// The reporter of a round or a reply, stopped however the command ends.
const reporting = (orca: Subagents | null = null) =>
  Effect.acquireRelease(
    Effect.sync(() => reporter(orca)),
    (report) => Effect.sync(() => report.stop()),
  )

// The agents of a round or a reply, asked by askAll, still on Promises: the signal it is given
// stops them at the round's deadline, or when the command is interrupted, which aborts the
// signal of tryPromise. The agents still waiting do not start.
const asking = <A>(minutes: number, ask: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: (interrupt) => {
      const stop = new AbortController()
      const timer = setTimeout(
        () => stop.abort(`the round took longer than ${minutes} minutes`),
        timerMs(minutes * 60_000),
      )
      timer.unref()
      interrupt.addEventListener('abort', () => stop.abort('interrupted'), { once: true })
      return ask(stop.signal).finally(() => clearTimeout(timer))
    },
    catch: (error) => error,
  })

// macOS sleeps on its own schedule, and a sleeping machine stops the round's agents: keep
// it awake while this process runs.
function keepAwake(): void {
  if (process.platform !== 'darwin' || !commandExists('caffeinate')) return
  try {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

export const round = Effect.fnUntraced(function* (args: string[], { spawner, lock }: Tools) {
  const { values } = parseArgs({
    args,
    options: { base: { type: 'string' }, plan: { type: 'boolean', default: false } },
  })
  if (!values.plan) {
    yield* lock('lntt review')
    startProgress()
  }
  const data = loaded()
  const config = reviewConfig(data)
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    throw new Error(`the working tree has uncommitted changes; the review reads commits:\n${dirty}`)
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') throw new Error('HEAD is detached; the review keeps its rounds per branch: switch to one')
  const head = git('rev-parse', '--short', 'HEAD')
  // The first line of a round: which commit it reads, whatever the base or the plan say next.
  stderr.write(`lntt review: reviewing ${head} ${git('log', '-1', '--format=%s', 'HEAD')} (${branch})\n`)
  const root = git('rev-parse', '--show-toplevel')
  const state = readState(branch)
  const base = git('rev-parse', '--short', mergeBase(root, values.base))
  const range = roundRange(state, branch, head, base, (a, b) => {
    try {
      git('merge-base', '--is-ancestor', a, b)
      return true
    } catch {
      return false
    }
  })
  const files = git('diff', '--name-only', `${range.from}..${head}`).split('\n').filter(Boolean)
  // A run with nothing new to read keeps the round's number: it is not a round more.
  const pastLimit = files.length > 0 && range.round > roundLimit(state, branch, config.maxRounds)
  if (pastLimit && !values.plan) return stopAtLimit(state, branch, range.round, config, branchRules(data))
  const lenses = Object.entries(config.reviewers).filter(([, lens]) => lensApplies(lens, files))
  const plan = [
    `round ${range.round}, ${range.reason}: ${range.from}..${head}, ${files.length} files`,
    ...lenses.map(([name, lens]) => `  ${name}: ${lens.with.map(agentLabel).join(', ')}`),
    `  verify ${config.verify ? `${config.verify.severities.join(', ')}: ${config.verify.with.map(agentLabel).join(', ')}` : 'off'}`,
  ]
  const agents = [...lenses.flatMap(([, lens]) => lens.with), ...(config.verify?.with ?? [])]
  // A lens named after an area of lntt check reads its results instead of redoing them.
  const areas = lenses.map(([name]) => name).filter(isArea)
  if (areas.length > 0) plan.push(`  before the reviewers: ${areas.map((a) => `lntt check ${a}`).join(', ')}`)
  if (pastLimit) {
    plan.push(
      `  limit: round ${range.round} would pass delivery.review.maxRounds (${config.maxRounds}): it will not start`,
    )
  }
  plan.push(`  the diff goes to: ${destinations(agents)}`)
  for (const warning of reviewWarnings(config)) plan.push(`  warning: ${warning}`)
  stderr.write(`lntt review: ${plan.join('\n')}\n`)
  const problems = agentProblems(agents)
  if (values.plan) {
    for (const problem of problems) stderr.write(`lntt review: cannot start ${problem}\n`)
    return 0
  }
  if (problems.length > 0) throw new Error(`cannot start ${problems.join('; ')}`)

  const open = state?.branch === branch ? state.result.findings : []
  const ledger = readLedger(branch)
  keepAwake()
  emit({
    type: 'round',
    pid: process.pid,
    // The Claude Code session that started the round, so its band shows there only.
    session: process.env.CLAUDE_CODE_SESSION_ID || null,
    round: range.round,
    range: `${range.from}..${head}`,
    files: files.length,
    optionalGraceMs: config.optionalGraceMinutes * 60_000,
  })
  const checks = Object.fromEntries(
    files.length === 0
      ? []
      : // A round runs no test: touched places the lines from the imports, never by coverage.
        areas.map((area) => [
          area,
          formatJson(runArea(area, undefined, [], { root, data, base: range.from, coverage: false })),
        ]),
  )
  const report = yield* reporting(orcaSubagents(env, root))
  const began = Date.now()
  const result = yield* asking(config.roundTimeoutMinutes, (signal) =>
    runRound(
      config,
      {
        base: range.from,
        head,
        files,
        diff: files.length > 0 ? git('diff', `${range.from}..${head}`) : '',
        records: records(data),
        phase: projectPhase(data),
        range,
        readBrief: (path) => readFileSync(join(root, path), 'utf8'),
        checks,
        closed: ledger,
        // The lines the whole branch wrote, from the merge base whatever range the round reads;
        // the prefixes and the root named, which a user's diff.noprefix or diff.relative would change.
        untouched: untouchedIn(
          git(
            '-c',
            'core.quotePath=false',
            'diff',
            '-U0',
            '--no-color',
            '--no-ext-diff',
            '--no-relative',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            `${base}..${head}`,
          ),
        ),
        cite: (path, line) => cite(root, path, line),
      },
      (questions) => {
        report.phase(questions.map((q) => q.label ?? ''))
        return askAll(questions, spawner(config.timeoutMinutes), report.progress, {
          perProvider: config.perProvider,
          optionalGraceMs: config.optionalGraceMinutes * 60_000,
          signal,
        })
      },
      open,
    ),
  )
  // The reviewers read the working tree: a commit or an edit during the round means they
  // did not all read the head the diff names.
  const moved = git('rev-parse', '--short', 'HEAD') !== head || git('status', '--porcelain') !== ''
  if (moved)
    result.failed.push({ lens: 'round', agent: 'lntt', error: `the branch moved from ${head} during the round` })
  // An empty delta keeps this branch's last round number, 1 with no state of its own: nothing new
  // was read. A round with a failure or a line left unread does not move the reviewed commit,
  // so the next one reads this range again.
  const previous = state?.branch === branch ? state.reviewed : null
  const saved: ReviewState = {
    branch,
    round: files.length > 0 ? range.round : (state?.round ?? 1),
    reviewed: reviewedAfter(result, previous, head),
    result,
    ...(state?.branch === branch && state.allowed ? { allowed: state.allowed } : {}),
    rounds: roundCosts(state, branch, result, range.round, files.length > 0),
  }
  writeState(saved)
  // Only a round that read its range whole closes anything: the next one reads it again.
  if (files.length > 0 && result.failed.length === 0 && result.partial.length === 0)
    writeLedger(branch, closeRound(ledger, result, open, config.warningRounds))
  const tokens = result.tokens === null ? '' : `, ${formatTokens(result.tokens)}`
  stderr.write(
    `lntt review: round ${saved.round} done in ${duration(Date.now() - began)}: ${result.findings.length} findings, ${result.refuted.length} refuted, ${result.failed.length} failed, ${result.partial.length} partial, ${result.skipped.length} skipped, ${result.closed.length} closed${tokens}\n` +
      `lntt review: branch total: ${reviewCost(saved.rounds ?? []).line}\n`,
  )
  // Past delivery.review.warningRounds a warning does not block: it goes in the pull
  // request as an open item.
  if (!result.blocking.includes('warning') && result.findings.some((f) => f.severity !== 'blocker'))
    stderr.write(
      `lntt review: round ${saved.round} is past delivery.review.warningRounds (${config.warningRounds}): only blockers block; warnings and notes go in the pull request as open items\n`,
    )
  emit({
    type: 'done',
    round: saved.round,
    findings: result.findings.length,
    refuted: result.refuted.length,
    failed: result.failed.length,
    partial: result.partial.length,
    skipped: result.skipped.length,
    tokens: result.tokens,
    clean: roundClean(result),
  })
  // The summary alone: the round's whole result is in the state, read with lntt review status.
  stdout.write(`${summary(saved, stateView(saved, config.maxRounds), '').join('\n')}\n`)
  return roundClean(result) ? 0 : 1
})

// The reviewers that found it, each resumed in its own session with the author's
// answer. Withdrawn when every one of them withdraws it.
export const reply = Effect.fnUntraced(function* (args: string[], { spawner, lock }: Tools) {
  const [id, ...words] = args
  if (!id || words.length === 0) usage('give the finding and the answer')
  const state = readState(headBranch())
  const finding = state?.result.findings.find((f) => f.id === id)
  if (!state || !finding) throw new Error(`no open finding ${id} in the last round`)
  yield* lock('lntt review reply')
  const config: ReviewConfig = reviewConfig(loaded())
  const known = new Map<string, Agent>()
  for (const lens of Object.values(config.reviewers)) for (const a of lens.with) known.set(agentLabel(a), a)
  // Withdrawn only by every reviewer that found it: one that cannot be resumed (no
  // session, or no longer in the configuration) is refused, not skipped.
  const lost = finding.foundBy.filter((b) => !b.session || !known.has(b.agent))
  if (lost.length > 0) {
    throw new Error(`${id}: cannot resume ${lost.map((b) => b.agent).join(', ')}; the person decides on this finding`)
  }
  const finders = finding.foundBy
  if (finders.length === 0) throw new Error(`${id}: no reviewer to answer`)
  const report = yield* reporting()
  const answers = yield* asking(config.roundTimeoutMinutes, (signal) =>
    askAll(
      finders.map((b) => ({
        agent: known.get(b.agent) as Agent,
        prompt: renderReplyPrompt(finding, words.join(' ')),
        session: b.session as string,
        label: `reply ${id} · ${b.agent}`,
      })),
      spawner(config.timeoutMinutes),
      report.progress,
      {
        perProvider: config.perProvider,
        optionalGraceMs: config.optionalGraceMinutes * 60_000,
        signal,
      },
    ),
  )
  const replies = answers.map((a, i) => ({
    agent: finders[i]?.agent,
    ...(a.ok ? parseWithdrawal(a.reply.text) : { withdrawn: false, reason: a.error }),
  }))
  const withdrawn = replies.every((r) => r.withdrawn)
  // Kept or withdrawn, the answer stays with the finding: lntt review status lists it.
  ;(finding as Checked).reply = { answer: words.join(' '), withdrawn }
  if (withdrawn) {
    ;(finding as Checked).verdict = 'withdrawn'
    const proof = `withdrawn by its reviewers after the answer: ${words.join(' ')}`
    writeLedger(state.branch, [
      ...readLedger(state.branch).filter((c) => c.id !== id),
      closedEntry(finding, state.round, 'refuted', { proof }),
    ])
  }
  writeState(state)
  stdout.write(`${JSON.stringify({ id, withdrawn, replies }, null, 2)}\n`)
  return withdrawn ? 0 : 1
})

// A person allows the branch more rounds past delivery.review.maxRounds, kept in its
// state: the configuration, and every other branch, stay as they are.
export const allow = Effect.fnUntraced(function* (args: string[], { lock }: Pick<Tools, 'lock'>) {
  const [count, ...rest] = args
  const rounds = Number(count)
  if (rest.length > 0 || !count || !/^\d+$/.test(count) || rounds < 1)
    usage('give the rounds to allow, a whole number from 1')
  yield* lock('lntt review allow')
  const branch = headBranch()
  const state = readState(branch)
  if (!state) throw new Error(`no round on ${branch} yet: nothing to allow more rounds to`)
  const { maxRounds } = reviewConfig(loaded())
  state.allowed = (state.allowed ?? 0) + rounds
  writeState(state)
  // The band stops showing the limit: the next round may run.
  startProgress()
  emit({ type: 'allow', allowed: state.allowed })
  stderr.write(
    `lntt review: ${branch} may take ${maxRounds + state.allowed} rounds: delivery.review.maxRounds (${maxRounds}) and ${state.allowed} allowed\n`,
  )
  return 0
})

// Runs a round, a reply or `allow` as the process's main program (src/run-command.ts): its exit
// code, the error report of src/review-cli.ts for a failure, 130 for an interrupt once the
// agents and the lock are released.
export function runReview(command: string | undefined, args: string[]): Promise<never> {
  const program = Effect.gen(function* () {
    const scope = yield* Scope.Scope
    // One round (or reply, or mutation run) at a time per worktree: a second would overwrite the
    // state and the progress of the first, or change the tree it reads (src/worktree/lock.ts).
    const lock = (name: string) => lockWorktree(git('rev-parse', '--absolute-git-dir'), name).pipe(Scope.provide(scope))
    if (command === 'allow') return yield* allow(args, { lock })
    return yield* withAgents(({ spawner }) =>
      command === 'reply'
        ? reply(args, { spawner, lock })
        : round(command === undefined ? [] : [command, ...args], { spawner, lock }),
    )
  })
  return runCommand(
    Effect.scoped(program).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.promise(() => failed(command, args, Cause.squash(cause))),
      ),
      Effect.map(exit),
      Effect.provide(Layer.mergeAll(AgentsLive, WorktreeLockLive)),
    ),
  )
}
