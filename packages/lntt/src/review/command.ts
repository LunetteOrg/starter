// The commands of `lntt review` that hold the worktree's lock, on Effect: a round, a reply, and
// `allow` (docs/adr/effect-in-lntt.md). src/review-cli.ts loads this module only for them, so
// `lntt review status` and `cost` do not load Effect.
//
// A command runs in one scope, the command's: the worktree's lock is a resource of that scope,
// and the agents run in a scope inside it (withAgents). However the command ends (an answer, a
// failure, an interrupt), the agents are released first, then the lock.
//
// The commands still call the sync code of src/review-cli.ts (git, the state files, the
// configuration), which is not on Effect yet: each call runs in Effect.try, and what it throws is
// a ReviewFailed. Their services come with #326.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import * as Clock from 'effect/Clock'
import * as Data from 'effect/Data'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type { FileSystem } from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import type { PlatformError } from 'effect/PlatformError'
import * as Scope from 'effect/Scope'
import { branchRules } from '../branch.ts'
import { cite, formatJson, isArea, runArea } from '../check.ts'
import { exit, Exit as LnttExit } from '../exit.ts'
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
  reportError,
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
  lock: (command: string) => Effect.Effect<void, ReviewFailed | LockedError | PlatformError, FileSystem | Pids>
}

// What the sync code of src/review-cli.ts threw: an expected failure, reported by its message.
export class ReviewFailed extends Data.TaggedError('ReviewFailed')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

// A command refused by one of its own checks: a dirty tree, a detached HEAD, an agent that cannot
// start, a finding that is not open, a branch with no round.
export class ReviewRefused extends Data.TaggedError('ReviewRefused')<{ message: string }> {}

const legacy = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new ReviewFailed({ cause }) })

// The reporter of a round or a reply, stopped however the command ends.
const reporting = (orca: Subagents | null = null) =>
  Effect.acquireRelease(
    Effect.sync(() => reporter(orca)),
    (report) => Effect.sync(() => report.stop()),
  )

// The agents of a round or a reply, asked by askAll, still on Promises: the signal it is given
// stops them at the round's deadline, a fiber that sleeps on the Clock, or when the command is
// interrupted, which aborts the signal of tryPromise. The agents still waiting do not start.
const asking = <A>(minutes: number, ask: (signal: AbortSignal) => Promise<A>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stop = new AbortController()
      yield* Effect.forkScoped(
        Effect.sleep(Duration.millis(timerMs(minutes * 60_000))).pipe(
          Effect.andThen(Effect.sync(() => stop.abort(`the round took longer than ${minutes} minutes`))),
        ),
      )
      return yield* Effect.tryPromise({
        try: (interrupt) => {
          interrupt.addEventListener('abort', () => stop.abort('interrupted'), { once: true })
          return ask(stop.signal)
        },
        catch: (cause) => new ReviewFailed({ cause }),
      })
    }),
  )

// macOS sleeps on its own schedule, and a sleeping machine stops the round's agents: keep
// it awake while this process runs.
function keepAwake(): void {
  if (process.platform !== 'darwin' || !commandExists('caffeinate')) return
  try {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

export const round = Effect.fnUntraced(function* (args: string[], { spawner, lock }: Tools) {
  const { values } = yield* legacy(() =>
    parseArgs({ args, options: { base: { type: 'string' }, plan: { type: 'boolean', default: false } } }),
  )
  if (!values.plan) {
    yield* lock('lntt review')
    startProgress()
  }
  const data = yield* legacy(loaded)
  const config = yield* legacy(() => reviewConfig(data))
  const dirty = yield* legacy(() => git('status', '--porcelain'))
  if (dirty !== '') {
    return yield* new ReviewRefused({
      message: `the working tree has uncommitted changes; the review reads commits:\n${dirty}`,
    })
  }
  const branch = yield* legacy(() => git('rev-parse', '--abbrev-ref', 'HEAD'))
  if (branch === 'HEAD') {
    return yield* new ReviewRefused({
      message: 'HEAD is detached; the review keeps its rounds per branch: switch to one',
    })
  }
  const { head, root, state, base, range, files } = yield* legacy(() => {
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
    return { head, root, state, base, range, files }
  })
  // A run with nothing new to read keeps the round's number: it is not a round more.
  const pastLimit = files.length > 0 && range.round > roundLimit(state, branch, config.maxRounds)
  if (pastLimit && !values.plan)
    return yield* legacy(() => stopAtLimit(state, branch, range.round, config, branchRules(data)))
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
  if (problems.length > 0) return yield* new ReviewRefused({ message: `cannot start ${problems.join('; ')}` })

  const open = state?.branch === branch ? state.result.findings : []
  const ledger = yield* legacy(() => readLedger(branch))
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
  const checks = yield* legacy(() =>
    Object.fromEntries(
      files.length === 0
        ? []
        : // A round runs no test: touched places the lines from the imports, never by coverage.
          areas.map((area) => [
            area,
            formatJson(runArea(area, undefined, [], { root, data, base: range.from, coverage: false })),
          ]),
    ),
  )
  const report = yield* reporting(orcaSubagents(env, root))
  const began = yield* Clock.currentTimeMillis
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
  const moved = yield* legacy(() => git('rev-parse', '--short', 'HEAD') !== head || git('status', '--porcelain') !== '')
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
  yield* legacy(() => {
    writeState(saved)
    // Only a round that read its range whole closes anything: the next one reads it again.
    if (files.length > 0 && result.failed.length === 0 && result.partial.length === 0)
      writeLedger(branch, closeRound(ledger, result, open, config.warningRounds))
  })
  const ended = yield* Clock.currentTimeMillis
  const tokens = result.tokens === null ? '' : `, ${formatTokens(result.tokens)}`
  stderr.write(
    `lntt review: round ${saved.round} done in ${duration(ended - began)}: ${result.findings.length} findings, ${result.refuted.length} refuted, ${result.failed.length} failed, ${result.partial.length} partial, ${result.skipped.length} skipped, ${result.closed.length} closed${tokens}\n` +
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
  const state = yield* legacy(() => readState(headBranch()))
  const finding = state?.result.findings.find((f) => f.id === id)
  if (!state || !finding) return yield* new ReviewRefused({ message: `no open finding ${id} in the last round` })
  yield* lock('lntt review reply')
  const config: ReviewConfig = yield* legacy(() => reviewConfig(loaded()))
  const known = new Map<string, Agent>()
  for (const lens of Object.values(config.reviewers)) for (const a of lens.with) known.set(agentLabel(a), a)
  // Withdrawn only by every reviewer that found it: one that cannot be resumed (no
  // session, or no longer in the configuration) is refused, not skipped.
  const lost = finding.foundBy.filter((b) => !b.session || !known.has(b.agent))
  if (lost.length > 0) {
    return yield* new ReviewRefused({
      message: `${id}: cannot resume ${lost.map((b) => b.agent).join(', ')}; the person decides on this finding`,
    })
  }
  const finders = finding.foundBy
  if (finders.length === 0) return yield* new ReviewRefused({ message: `${id}: no reviewer to answer` })
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
  yield* legacy(() => {
    if (withdrawn) {
      ;(finding as Checked).verdict = 'withdrawn'
      const proof = `withdrawn by its reviewers after the answer: ${words.join(' ')}`
      writeLedger(state.branch, [
        ...readLedger(state.branch).filter((c) => c.id !== id),
        closedEntry(finding, state.round, 'refuted', { proof }),
      ])
    }
    writeState(state)
  })
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
  const branch = yield* legacy(headBranch)
  const state = yield* legacy(() => readState(branch))
  if (!state) return yield* new ReviewRefused({ message: `no round on ${branch} yet: nothing to allow more rounds to` })
  const { maxRounds } = yield* legacy(() => reviewConfig(loaded()))
  state.allowed = (state.allowed ?? 0) + rounds
  yield* legacy(() => writeState(state))
  // The band stops showing the limit: the next round may run.
  startProgress()
  emit({ type: 'allow', allowed: state.allowed })
  stderr.write(
    `lntt review: ${branch} may take ${maxRounds + state.allowed} rounds: delivery.review.maxRounds (${maxRounds}) and ${state.allowed} allowed\n`,
  )
  return 0
})

// Runs a round, a reply or `allow` as the process's main program (src/run-command.ts): its exit
// code; for an expected failure the error report of src/review-cli.ts, made while the lock is
// still held, since it writes the progress file; 130 for an interrupt once the agents and the
// lock are released. A defect reaches the runner, which prints it with its stack.
export function runReview(command: string | undefined, args: string[]): Promise<never> {
  const program = Effect.gen(function* () {
    const scope = yield* Scope.Scope
    // One round (or reply, or mutation run) at a time per worktree: a second would overwrite the
    // state and the progress of the first, or change the tree it reads (src/worktree/lock.ts).
    const lock = (name: string) =>
      legacy(() => git('rev-parse', '--absolute-git-dir')).pipe(
        Effect.flatMap((gitDir) => lockWorktree(gitDir, name)),
        Scope.provide(scope),
      )
    const run =
      command === 'allow'
        ? allow(args, { lock })
        : withAgents(({ spawner }) =>
            command === 'reply'
              ? reply(args, { spawner, lock })
              : round(command === undefined ? [] : [command, ...args], { spawner, lock }),
          )
    const report = (error: unknown) => Effect.promise(() => failed(command, args, error))
    return yield* run.pipe(
      // A defect is reported as an error too, for whoever watches the round; then the runner
      // prints it with its stack and exits 1. An exit(code) is no defect: it is the command's code.
      Effect.tapDefect((defect) =>
        Effect.sync(() => {
          if (!(defect instanceof LnttExit)) reportError(command, args, defect)
        }),
      ),
      Effect.catchTags({
        ReviewFailed: (error) => report(error.cause),
        ReviewRefused: report,
        LockedError: report,
        PlatformError: report,
      }),
    )
  })
  return runCommand(
    Effect.scoped(program).pipe(Effect.map(exit), Effect.provide(Layer.mergeAll(AgentsLive, WorktreeLockLive))),
  )
}
