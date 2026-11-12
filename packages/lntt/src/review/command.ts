// The commands of `lntt review` that hold the worktree's lock, on Effect: a round, a reply, and
// `allow` (docs/adr/effect-in-lntt.md). src/review-cli.ts parses their arguments and loads this
// module only for them, so `lntt review status` and `cost` do not load Effect.
//
// A command runs in one scope, the command's: the worktree's lock is a resource of that scope,
// and the agents are fibers of askAll inside it (src/review/asking.ts). However the command ends
// (an answer, a failure, an interrupt), the agents are released first, then the lock.
//
// The logic reaches the machine only through services: git (Git), the agents (Agents), the state
// store and the progress file (ReviewStore), the working tree (FileSystem, Path), the clock
// (Clock), processes (ChildProcessSpawner), the terminal (Console), the environment (Config),
// and the sync code of modules not yet on Effect through the bridge (ReviewBridge). src/review/command.spec.ts runs it on their in-memory layers.

import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Scope from 'effect/Scope'
import { type BranchRules, branchRules } from '../branch.ts'
import { citeTarget, citeText, isArea } from '../check.ts'
import { exit, Exit as LnttExit } from '../exit.ts'
import { Git, type GitError, GitLive } from '../git/git.ts'
import { type HeadlessAgent as Agent, type Progress, type Question, timerMs } from '../headless.ts'
import { projectPhase } from '../index.ts'
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
} from '../review.ts'
import { runCommand } from '../run-command.ts'
import { type LockedError, lockWorktree, Pids, WorktreeLockLive } from '../worktree/lock.ts'
import { AgentsLive } from './agents.ts'
import { Agents, askAll } from './asking.ts'
import { ReviewBridge, ReviewBridgeLive, ReviewFailed } from './bridge.ts'
import { reporting } from './reporter.ts'
import { runRound } from './round.ts'
import { ReviewStore, ReviewStoreLive } from './store.ts'
import {
  destinations,
  duration,
  legacyRounds,
  noRoundLine,
  records,
  stateView,
  summary,
  untouchedIn,
  withDefaults,
} from './view.ts'

export { ReviewFailed }

// A command as review-cli.ts parsed it.
export type ReviewCommand =
  | { kind: 'round'; base: string | undefined; plan: boolean }
  | { kind: 'reply'; id: string; answer: string }
  | { kind: 'allow'; rounds: number }

// A command refused by one of its own checks: a dirty tree, a detached HEAD, a configuration that
// does not validate, an agent that cannot start, a finding that is not open, a branch with no round.
export class ReviewRefused extends Data.TaggedError('ReviewRefused')<{ message: string }> {}

// What a command is given: the worktree's lock, taken in the command's scope whichever step
// takes it.
export type Tools = {
  lock: (command: string) => Effect.Effect<void, GitError | LockedError | PlatformError, FileSystem.FileSystem | Pids>
}

const say = (line: string) => Console.error(`lntt review: ${line}`)

const validConfig = (data: Record<string, unknown>) =>
  Effect.try({
    try: () => reviewConfig(data),
    catch: (error) => new ReviewRefused({ message: String((error as Error).message ?? error) }),
  })

// The branch HEAD names; the review keeps its rounds per branch.
const headBranch = Effect.gen(function* () {
  const branch = yield* (yield* Git).branch
  if (branch === 'HEAD')
    return yield* new ReviewRefused({
      message: 'HEAD is detached; the review keeps its rounds per branch: switch to one',
    })
  return branch
})

// The deadline of a round or a reply, from now: one for all its asks (a round asks its reviewers,
// then its verifiers). A fiber of the command's scope sleeps on the Clock, then every agent still
// running is stopped, those waiting do not start, and each answer is the reason. An interrupt of
// the command stops them too, as an interrupt: nothing is answered.
const deadline = Effect.fnUntraced(function* (minutes: number) {
  const passed = yield* Deferred.make<string>()
  yield* Effect.forkScoped(
    Effect.sleep(Duration.millis(timerMs(minutes * 60_000))).pipe(
      Effect.andThen(Deferred.succeed(passed, `the round took longer than ${minutes} minutes`)),
    ),
  )
  return Deferred.await(passed)
})

// How a round or a reply asks its agents: the project's slots, grace and timeouts, the
// deadline, and what the reporter writes as each agent starts and ends.
const asking = (config: ReviewConfig, stop: Effect.Effect<string>, progress: (event: Progress) => void) => ({
  perProvider: config.perProvider,
  optionalGraceMs: config.optionalGraceMinutes * 60_000,
  timeoutMinutes: config.timeoutMinutes,
  stop,
  progress: (event: Progress) => Effect.sync(() => progress(event)),
})

// macOS sleeps on its own schedule, and a sleeping machine stops the round's agents: caffeinate
// keeps it awake while this process runs. Its release is its own `-w <pid>`: it exits with this
// process, however that ends, so it runs in a scope of its own that nothing closes, in a process
// group of its own, and does not keep the process alive. Where there is none (not macOS, not
// installed) the round goes on without it; any other failure to start it is the round's.
const keepAwake = Effect.gen(function* () {
  const { self } = yield* Pids
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const own = yield* Scope.make()
  const awake = yield* spawner
    .spawn(
      ChildProcess.make('caffeinate', ['-i', '-w', String(self)], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      }),
    )
    .pipe(
      Scope.provide(own),
      Effect.map((handle) => handle.unref),
      Effect.catchTag('PlatformError', (error) =>
        error.reason._tag === 'NotFound'
          ? Effect.succeed(Effect.void)
          : Effect.fail(new ReviewFailed({ cause: error })),
      ),
    )
  yield* awake.pipe(Effect.ignore)
})

// The round past the limit does not start: the person decides on what the last round
// left, its findings not withdrawn and its failures. Exit 3, with a `limit:` line the
// review skill watches for, and the summary of a round on stdout.
const stopAtLimit = Effect.fnUntraced(function* (
  state: ReviewState | null,
  branch: string,
  round: number,
  config: ReviewConfig,
  rules: BranchRules,
) {
  const store = yield* ReviewStore
  const bridge = yield* ReviewBridge
  const own = state?.branch === branch ? withDefaults(state) : null
  const allowed = own?.allowed ?? 0
  const open = (own?.result.findings ?? []).filter((f) => f.verdict !== 'withdrawn')
  const failed = own?.result.failed ?? []
  const listed = [
    ...open.map((f) => `${f.id} (${f.severity}, ${f.verdict})`),
    ...failed.map((f) => `${f.lens} · ${f.agent} failed`),
  ]
  const cost = reviewCost(own?.rounds ?? [], legacyRounds(own))
  const passing = `round ${round} would pass delivery.review.maxRounds (${config.maxRounds})${allowed > 0 ? ` and ${allowed} allowed` : ''}`
  const still = listed.length === 0 ? 'nothing' : listed.join(', ')
  yield* say(`limit: ${passing} on ${branch}; still open: ${still}`)
  yield* say(
    'the person decides: the pull request as it is, more rounds for this branch (pnpm exec lntt review allow <rounds>), or an issue for what is open',
  )
  yield* say(`branch total: ${cost.line}`)
  // A branch lntt worktree start started reports to its parent as well: the open
  // findings in full, so the answer needs nothing else.
  const marker = yield* bridge.reportsTo(branch, rules)
  const details = open.map((f) => {
    const anchor = f.path === null ? '(no anchor)' : `${f.path}${f.line === null ? '' : `:${f.line}`}`
    return `- ${f.id} [${f.severity}, ${f.verdict}] ${anchor} — ${f.what} — ${f.action}`
  })
  const sent = marker
    ? yield* bridge.askAtLimit(
        marker,
        branch,
        [
          `${marker.issue === null ? '' : `#${marker.issue} `}${branch}: lntt review limit, ${passing}; still open: ${still}; decide: the pull request as it is, pnpm exec lntt review allow <rounds>, or an issue for what is open`,
          '',
          `review cost: ${cost.line}`,
          ...(details.length > 0 ? ['', ...details] : []),
        ].join('\n'),
      )
    : null
  if (sent) yield* say(sent.line)
  yield* store.emit({
    type: 'limit',
    round,
    maxRounds: config.maxRounds,
    allowed,
    open: open.length,
    failed: failed.length,
    ...(sent?.asked ? { asked: sent.asked } : {}),
  })
  // No own state never gets here (a first round is round 1, and maxRounds is at least 1);
  // the type allows it.
  const lines = own
    ? summary(own, stateView(own, config.maxRounds, yield* store.closed(branch)), `round ${round} refused at the limit`)
    : [noRoundLine(branch, '')]
  yield* Console.log(lines.join('\n'))
  return 3
})

export const round = Effect.fnUntraced(function* (
  options: { base: string | undefined; plan: boolean },
  { lock }: Tools,
) {
  const git = yield* Git
  const agents = yield* Agents
  const store = yield* ReviewStore
  const bridge = yield* ReviewBridge
  const { self } = yield* Pids
  if (!options.plan) {
    yield* lock('lntt review')
    yield* store.startProgress
  }
  const data = yield* bridge.config
  const config = yield* validConfig(data)
  const dirty = yield* git.status
  if (dirty !== '') {
    return yield* new ReviewRefused({
      message: `the working tree has uncommitted changes; the review reads commits:\n${dirty}`,
    })
  }
  const branch = yield* git.branch
  if (branch === 'HEAD') {
    return yield* new ReviewRefused({
      message: 'HEAD is detached; the review keeps its rounds per branch: switch to one',
    })
  }
  const head = yield* git.short('HEAD')
  // The first line of a round: which commit it reads, whatever the base or the plan say next.
  yield* say(`reviewing ${head} ${yield* git.subject('HEAD')} (${branch})`)
  const root = yield* git.root
  const state = yield* store.readState(branch)
  const given = yield* bridge.base(root, options.base)
  if (given.said !== null) yield* say(given.said)
  const base = yield* git.short(yield* git.mergeBase('HEAD', given.ref))
  // The commit the last round read is still in the branch, or the round reads it all again.
  const kept = state?.branch === branch && state.reviewed !== null ? yield* git.isAncestor(state.reviewed, head) : false
  const range = roundRange(state, branch, head, base, () => kept)
  const files = yield* git.changed(`${range.from}..${head}`)
  // A run with nothing new to read keeps the round's number: it is not a round more.
  const pastLimit = files.length > 0 && range.round > roundLimit(state, branch, config.maxRounds)
  if (pastLimit && !options.plan) return yield* stopAtLimit(state, branch, range.round, config, branchRules(data))
  const lenses = Object.entries(config.reviewers).filter(([, lens]) => lensApplies(lens, files))
  const plan = [
    `round ${range.round}, ${range.reason}: ${range.from}..${head}, ${files.length} files`,
    ...lenses.map(([name, lens]) => `  ${name}: ${lens.with.map(agentLabel).join(', ')}`),
    `  verify ${config.verify ? `${config.verify.severities.join(', ')}: ${config.verify.with.map(agentLabel).join(', ')}` : 'off'}`,
  ]
  const asked: Agent[] = [...lenses.flatMap(([, lens]) => lens.with), ...(config.verify?.with ?? [])]
  // A lens named after an area of lntt check reads its results instead of redoing them.
  const areas = lenses.map(([name]) => name).filter(isArea)
  if (areas.length > 0) plan.push(`  before the reviewers: ${areas.map((a) => `lntt check ${a}`).join(', ')}`)
  if (pastLimit) {
    plan.push(
      `  limit: round ${range.round} would pass delivery.review.maxRounds (${config.maxRounds}): it will not start`,
    )
  }
  plan.push(`  the diff goes to: ${destinations(asked)}`)
  for (const warning of reviewWarnings(config)) plan.push(`  warning: ${warning}`)
  yield* say(plan.join('\n'))
  const problems = yield* agents.problems(asked)
  if (options.plan) {
    for (const problem of problems) yield* say(`cannot start ${problem}`)
    return 0
  }
  if (problems.length > 0) return yield* new ReviewRefused({ message: `cannot start ${problems.join('; ')}` })

  const open = state?.branch === branch ? state.result.findings : []
  const ledger = yield* store.readLedger(branch)
  yield* keepAwake
  // The Claude Code session that started the round, so its band shows there only.
  const session = yield* Config.String('CLAUDE_CODE_SESSION_ID').pipe(Config.withDefault(''))
  yield* store.emit({
    type: 'round',
    pid: self,
    session: session || null,
    round: range.round,
    range: `${range.from}..${head}`,
    files: files.length,
    optionalGraceMs: config.optionalGraceMinutes * 60_000,
  })
  const checks = files.length === 0 ? {} : yield* bridge.checks(areas, { root, data, base: range.from })
  const report = yield* reporting(yield* bridge.orca(root))
  const began = yield* Clock.currentTimeMillis
  const diff = files.length > 0 ? yield* git.diff(`${range.from}..${head}`) : ''
  // The lines the whole branch wrote, from the merge base whatever range the round reads.
  const written = yield* git.written(`${base}..${head}`)
  // The working tree as the reviewers read it: a lens's brief, and the line a finding cites.
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cite = (anchor: string, line: number | null) =>
    Effect.gen(function* () {
      const { file, at } = citeTarget(root, anchor, line)
      const isFile =
        file !== null &&
        (yield* fs.stat(file).pipe(
          Effect.map((info) => info.type === 'File'),
          Effect.catchTag('PlatformError', (error) =>
            error.reason._tag === 'NotFound' ? Effect.succeed(false) : Effect.fail(error),
          ),
        ))
      if (!isFile) return citeText(null, at)
      return citeText(at === null ? '' : yield* fs.readFileString(file), at)
    })
  const stop = yield* deadline(config.roundTimeoutMinutes)
  const ask = (questions: Question[]) =>
    Effect.gen(function* () {
      report.phase(questions.map((q) => q.label ?? ''))
      return yield* askAll(questions, asking(config, stop, report.progress)).pipe(Effect.provideService(Agents, agents))
    })
  const result = yield* runRound<PlatformError>(
    config,
    {
      base: range.from,
      head,
      files,
      diff,
      records: records(data),
      phase: projectPhase(data),
      range,
      readBrief: (brief) => fs.readFileString(path.join(root, brief)),
      checks,
      closed: ledger,
      untouched: untouchedIn(written),
      cite,
    },
    ask,
    open,
  )
  yield* report.flush
  // The reviewers read the working tree: a commit or an edit during the round means they
  // did not all read the head the diff names.
  const moved = (yield* git.short('HEAD')) !== head || (yield* git.status) !== ''
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
  yield* store.writeState(saved)
  // Only a round that read its range whole closes anything: the next one reads it again.
  if (files.length > 0 && result.failed.length === 0 && result.partial.length === 0)
    yield* store.writeLedger(branch, closeRound(ledger, result, open, config.warningRounds))
  const ended = yield* Clock.currentTimeMillis
  const tokens = result.tokens === null ? '' : `, ${formatTokens(result.tokens)}`
  yield* say(
    `round ${saved.round} done in ${duration(ended - began)}: ${result.findings.length} findings, ${result.refuted.length} refuted, ${result.failed.length} failed, ${result.partial.length} partial, ${result.skipped.length} skipped, ${result.closed.length} closed${tokens}`,
  )
  yield* say(`branch total: ${reviewCost(saved.rounds ?? []).line}`)
  // Past delivery.review.warningRounds a warning does not block: it goes in the pull
  // request as an open item.
  if (!result.blocking.includes('warning') && result.findings.some((f) => f.severity !== 'blocker'))
    yield* say(
      `round ${saved.round} is past delivery.review.warningRounds (${config.warningRounds}): only blockers block; warnings and notes go in the pull request as open items`,
    )
  yield* store.emit({
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
  const view = stateView(saved, config.maxRounds, yield* store.closed(branch))
  yield* Console.log(summary(saved, view, '').join('\n'))
  return roundClean(result) ? 0 : 1
})

// The reviewers that found it, each resumed in its own session with the author's
// answer. Withdrawn when every one of them withdraws it.
export const reply = Effect.fnUntraced(function* ({ id, answer }: { id: string; answer: string }, { lock }: Tools) {
  const store = yield* ReviewStore
  const bridge = yield* ReviewBridge
  const state = yield* store.readState(yield* headBranch)
  const finding = state?.result.findings.find((f) => f.id === id)
  if (!state || !finding) return yield* new ReviewRefused({ message: `no open finding ${id} in the last round` })
  yield* lock('lntt review reply')
  const config = yield* validConfig(yield* bridge.config)
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
  const answers = yield* askAll(
    finders.map((b) => ({
      agent: known.get(b.agent) as Agent,
      prompt: renderReplyPrompt(finding, answer),
      session: b.session as string,
      label: `reply ${id} · ${b.agent}`,
    })),
    asking(config, yield* deadline(config.roundTimeoutMinutes), report.progress),
  )
  yield* report.flush
  const replies = answers.map((a, i) => ({
    agent: finders[i]?.agent,
    ...(a.ok ? parseWithdrawal(a.reply.text) : { withdrawn: false, reason: a.error }),
  }))
  const withdrawn = replies.every((r) => r.withdrawn)
  // Kept or withdrawn, the answer stays with the finding: lntt review status lists it.
  ;(finding as Checked).reply = { answer, withdrawn }
  if (withdrawn) {
    ;(finding as Checked).verdict = 'withdrawn'
    const proof = `withdrawn by its reviewers after the answer: ${answer}`
    const ledger = yield* store.readLedger(state.branch)
    yield* store.writeLedger(state.branch, [
      ...ledger.filter((c) => c.id !== id),
      closedEntry(finding, state.round, 'refuted', { proof }),
    ])
  }
  yield* store.writeState(state)
  yield* Console.log(JSON.stringify({ id, withdrawn, replies }, null, 2))
  return withdrawn ? 0 : 1
})

// A person allows the branch more rounds past delivery.review.maxRounds, kept in its
// state: the configuration, and every other branch, stay as they are.
export const allow = Effect.fnUntraced(function* ({ rounds }: { rounds: number }, { lock }: Pick<Tools, 'lock'>) {
  const store = yield* ReviewStore
  const bridge = yield* ReviewBridge
  yield* lock('lntt review allow')
  const branch = yield* headBranch
  const state = yield* store.readState(branch)
  if (!state) return yield* new ReviewRefused({ message: `no round on ${branch} yet: nothing to allow more rounds to` })
  const { maxRounds } = yield* validConfig(yield* bridge.config)
  state.allowed = (state.allowed ?? 0) + rounds
  yield* store.writeState(state)
  // The band stops showing the limit: the next round may run.
  yield* store.startProgress
  yield* store.emit({ type: 'allow', allowed: state.allowed })
  yield* say(
    `${branch} may take ${maxRounds + state.allowed} rounds: delivery.review.maxRounds (${maxRounds}) and ${state.allowed} allowed`,
  )
  return 0
})

// The error report of a command: its `error:` line, which the review skill watches for with
// `failed`, `limit:` and `round N done`, and its progress event. A round that has not started its
// progress file starts it, so the error is not read as the end of the round before; a refused
// lock means another command owns that file, and a --plan writes none.
export const reportError = Effect.fnUntraced(function* (command: ReviewCommand, error: unknown) {
  const store = yield* ReviewStore
  const message = error instanceof Error ? error.message : String(error)
  yield* say(`error: ${message}`)
  const locked = error instanceof Error && (error as { _tag?: string })._tag === 'LockedError'
  if (!locked && command.kind === 'round' && !command.plan && !(yield* store.started)) yield* store.startProgress
  yield* store.emit({ type: 'error', message })
})

// A command in its scope, its expected failures reported while the lock is still held (the report
// writes the progress file) and exiting 1. A defect is reported too, for whoever watches the
// round; then it reaches the runner, which prints it with its stack. An exit(code) is no defect:
// it is the command's code.
export const command = (parsed: ReviewCommand) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const git = yield* Git
    // One round (or reply, or mutation run) at a time per worktree: a second would overwrite the
    // state and the progress of the first, or change the tree it reads (src/worktree/lock.ts).
    const lock = (name: string) =>
      git.gitDir.pipe(
        Effect.flatMap((gitDir) => lockWorktree(gitDir, name)),
        Scope.provide(scope),
      )
    const run =
      parsed.kind === 'allow'
        ? allow(parsed, { lock })
        : parsed.kind === 'reply'
          ? reply(parsed, { lock })
          : round(parsed, { lock })
    const failure = (error: Error) => reportError(parsed, error).pipe(Effect.as(1))
    return yield* run.pipe(
      Effect.tapDefect((defect) => (defect instanceof LnttExit ? Effect.void : reportError(parsed, defect))),
      Effect.catchTags({
        ReviewFailed: failure,
        ReviewRefused: failure,
        LockedError: failure,
        PlatformError: failure,
        GitError: failure,
      }),
    )
  }).pipe(Effect.scoped)

// The services on the machine.
const Live = ReviewStoreLive.pipe(
  Layer.provideMerge(GitLive),
  Layer.provideMerge(Layer.mergeAll(AgentsLive, WorktreeLockLive, ReviewBridgeLive, Path.layer)),
)

// Runs a round, a reply or `allow` as the process's main program (src/run-command.ts): its exit
// code; 130 for an interrupt once the agents and the lock are released.
export function runReview(parsed: ReviewCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
