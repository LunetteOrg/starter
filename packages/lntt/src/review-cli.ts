// `lntt review`: one review round on the current branch, or an answer to a reviewer
// (usage: bin/lntt.ts).

import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { projectBase } from './base.ts'
import { type BranchRules, branchRules, fromToolName } from './branch.ts'
import { cite, formatJson, isArea, projectFiles, runArea } from './check.ts'
import { localRef } from './ci/event.ts'
import { NoConfigError } from './files.ts'
import {
  type HeadlessAgent as Agent,
  askAll,
  headlessInvocation,
  type Invocation,
  type Progress,
  providerOf,
  type Spawn,
  timerMs,
} from './headless.ts'
import { findConfig, loadConfig, projectPhase } from './index.ts'
import { type Message, pending, type Started, send, startedBy } from './messages.ts'
import { messagesRoot, systemMailbox } from './messages-cli.ts'
import { describeOutcome, mutateAll } from './mutate.ts'
import { loadOperator, slug } from './operator.ts'
import { orcaSubagents, type Subagents } from './orca-subagents.ts'
import {
  agentLabel,
  type Checked,
  type Closed,
  closedEntry,
  closeRound,
  formatTokens,
  type Ledger,
  lensApplies,
  type MutationAnswer,
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
} from './review.ts'
import {
  branchesIn,
  ledgerPathIn,
  migrateOld,
  type Place,
  parseRefs,
  pruneReason,
  removeBranch,
  resolvePlace,
  statePathIn,
} from './review-store.ts'
import { commandExists } from './viewer.ts'

export { formatTokens }

const USAGE = `usage: lntt review [--base <branch>] [--plan]
       lntt review reply <finding> <answer>
       lntt review allow <rounds>
       lntt review status [--json] [--query <jq>] [--clear | --prune [--dry-run]]
       lntt review cost [--json]`

function usage(message?: string): never {
  if (message) stderr.write(`lntt review: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString()
    .trimEnd()
}

// No configuration file: the defaults. A file that does not validate is an error: a
// review on the defaults would pass for the one the project configured.
function loaded(): Record<string, unknown> {
  try {
    findConfig(cwd())
  } catch (error) {
    if (error instanceof NoConfigError) return {}
    throw error
  }
  return loadConfig(cwd()).data
}

// Where each agent sends the diff: the project's choice, shown every time.
function destinations(agents: Agent[]): string {
  return [...new Set(agents.map((a) => `${providerOf(a)} (${a.kind})`))].join(', ')
}

// The decision logs, as the decisions lens needs to find them.
function records(data: Record<string, unknown>): string {
  const logs = (data.recording as { logs?: Record<string, Record<string, string>> } | undefined)?.logs ?? {}
  return Object.entries(logs)
    .map(([name, log]) => {
      const index = log.index ? `, index ${log.index}` : ''
      return `- ${name}: ${log.path}${index}${log.scope ? ` — ${log.scope}` : ''}`
    })
    .join('\n')
}

// Where each branch's state and ledger are kept between runs: one file of each per branch,
// in the place the operator, the project or the clone names (src/review-store.ts). The first
// look also takes in what this worktree kept in its git directory before the place existed.
let placed: Place | null = null
function place(): Place {
  if (placed) return placed
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
  const review = (loaded().delivery as { review?: { stateDir?: unknown } } | undefined)?.review
  const operator = (loadOperator(cwd()).profile.review as { stateDir?: unknown } | undefined)?.stateDir
  placed = resolvePlace({
    common,
    main: common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : common,
    slug: slug(cwd()),
    operator,
    project: review?.stateDir,
  })
  migrateOld(git('rev-parse', '--absolute-git-dir'), placed.dir, (line) => stderr.write(`lntt review: ${line}\n`))
  return placed
}

function statePath(branch: string): string {
  return statePathIn(place().dir, branch)
}

function readState(branch: string): ReviewState | null {
  const path = statePath(branch)
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8')) as ReviewState | null
  if (state?.branch !== branch) {
    throw new Error(`${path} cannot be read: pnpm exec lntt review status --clear removes it`)
  }
  return state
}

function writeState(state: ReviewState): void {
  const path = statePath(state.branch)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

// The findings the branch closed, round after round, next to the state: the reviewers and
// verifiers of every round read it.
function ledgerPath(branch: string): string {
  return ledgerPathIn(place().dir, branch)
}

// A state saved before the rounds were kept: the rounds it ran, none of them with a cost.
// A state of this version keeps `rounds` (empty too) and its gaps show in the numbers.
function legacyRounds(state: ReviewState | null): number {
  return state && state.rounds === undefined ? state.round : 0
}

// A ledger that cannot be read (a write cut short) costs the reviewers what it told them,
// not the round: it is said, and the branch starts a new one.
function readLedger(branch: string): Closed[] {
  const path = ledgerPath(branch)
  if (!existsSync(path)) return []
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
    if (ledger.branch !== branch) return []
    if (Array.isArray(ledger.closed)) return ledger.closed
  } catch {}
  stderr.write(`lntt review: ${path} cannot be read: the branch starts a new ledger\n`)
  return []
}

function writeLedger(branch: string, closed: Closed[]): void {
  mkdirSync(dirname(ledgerPath(branch)), { recursive: true })
  writeFileSync(ledgerPath(branch), `${JSON.stringify({ branch, closed } satisfies Ledger, null, 2)}\n`)
}

type Asked = { id: string; to: string; path: string }

// Who the branch reports to, when `lntt worktree start` started it; null otherwise, and
// outside a git repository. A branch still on the name Orca gave it
// (`<user>/<type>-<issue>-<slug>`, until `lntt branch rename`) has the marker of its
// conventional name.
function reportsTo(branch: string, rules: BranchRules): Started | null {
  try {
    const root = messagesRoot()
    const conventional = fromToolName(branch, rules)
    return (
      startedBy(root, branch) ??
      (conventional !== null && conventional !== branch ? startedBy(root, conventional) : null)
    )
  } catch {
    return null
  }
}

// The limit message of this branch still waiting for its answer in the directory it goes
// to: its first line names the branch.
function pendingLimit(root: string, marker: Started, branch: string): Message | undefined {
  const address = marker.to === 'coordinator' ? { theme: marker.theme as string } : {}
  return pending(root, marker.to, address).find((message) => {
    const first = message.question.split('\n')[0] ?? ''
    return /(^|-)review-limit(-\d+)?$/.test(message.topic) && first.split(' ').slice(0, 2).includes(`${branch}:`)
  })
}

// What is open goes to the coordinator or the orchestrator as a message the round does not
// wait for: it holds the review lock, and `lntt review allow` must stay possible while the
// answer is awaited. A limit already sent and not yet answered is not sent again: its id
// is the one to wait on. Null when the message cannot be written, which is only said.
function askAtLimit(marker: Started, branch: string, text: string): Asked | null {
  const who = marker.to === 'coordinator' ? `the coordinator ${marker.theme}` : 'the orchestrator'
  const address = {
    ...(marker.to === 'coordinator' ? { theme: marker.theme as string } : {}),
    ...(marker.issue === null ? {} : { issue: marker.issue }),
  }
  try {
    const box = systemMailbox()
    const earlier = pendingLimit(box.dir, marker, branch)
    const sent = earlier ?? send(box, marker.to, text, { topic: 'review-limit', ...address })
    stderr.write(
      `lntt review: limit: ${earlier ? 'already sent' : 'sent'} ${sent.id} to ${who}; wait with: pnpm exec lntt ask --wait ${sent.id}\n`,
    )
    return { id: sent.id, to: marker.to, path: sent.path }
  } catch (error) {
    stderr.write(`lntt review: limit: could not send to ${who}: ${(error as Error).message}\n`)
    return null
  }
}

// The round past the limit does not start: the person decides on what the last round
// left, its findings not withdrawn and its failures. Exit 3, with a `limit:` line the
// review skill watches for, and the summary of a round on stdout.
function stopAtLimit(
  state: ReviewState | null,
  branch: string,
  round: number,
  config: ReviewConfig,
  rules: BranchRules,
): number {
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
  stderr.write(
    `lntt review: limit: ${passing} on ${branch}; still open: ${still}\n` +
      'lntt review: the person decides: the pull request as it is, more rounds for this branch (pnpm exec lntt review allow <rounds>), or an issue for what is open\n' +
      `lntt review: branch total: ${cost.line}\n`,
  )
  // A branch lntt worktree start started reports to its parent as well: the open
  // findings in full, so the answer needs nothing else.
  const marker = reportsTo(branch, rules)
  const details = open.map((f) => {
    const anchor = f.path === null ? '(no anchor)' : `${f.path}${f.line === null ? '' : `:${f.line}`}`
    return `- ${f.id} [${f.severity}, ${f.verdict}] ${anchor} — ${f.what} — ${f.action}`
  })
  const asked = marker
    ? askAtLimit(
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
  emit({
    type: 'limit',
    round,
    maxRounds: config.maxRounds,
    allowed,
    open: open.length,
    failed: failed.length,
    ...(asked ? { asked } : {}),
  })
  // No own state never gets here (a first round is round 1, and maxRounds is at least 1);
  // the type allows it.
  const lines = own
    ? summary(own, stateView(own, config.maxRounds), `round ${round} refused at the limit`)
    : [noRoundLine(branch, '')]
  stdout.write(`${lines.join('\n')}\n`)
  return 3
}

// What keeps an agent from starting: a CLI that is not installed, or one that cannot be
// made read-only (headlessInvocation throws). A round refuses before any starts.
function agentProblems(agents: Agent[]): string[] {
  const problems: string[] = []
  for (const agent of agents) {
    try {
      headlessInvocation(agent, '')
      if (!commandExists(agent.kind)) problems.push(`${agentLabel(agent)}: ${agent.kind} is not on the PATH`)
    } catch (error) {
      problems.push(`${agentLabel(agent)}: ${(error as Error).message}`)
    }
  }
  return problems
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

// Where a round's progress goes as JSON events, one per line, for whatever shows it
// beside the agent (the lunette band): <git dir>/lntt-review.progress, emptied when a
// round starts.
function progressPath(): string {
  return join(git('rev-parse', '--absolute-git-dir'), 'lntt-review.progress')
}

// Found once per run: an event is written while agents run, without a git call each.
let progressFile: string | null = null

// A round starts its own file, before anything that can stop it, so an error is never
// read as the end of the round before.
export function startProgress(): void {
  try {
    progressFile = progressPath()
    writeFileSync(progressFile, '')
  } catch {
    progressFile = null
  }
}

function emit(event: Record<string, unknown>): void {
  if (!progressFile) return
  try {
    appendFileSync(progressFile, `${JSON.stringify({ t: Date.now(), ...event })}\n`)
  } catch {}
}

function phaseOf(label: string): string {
  return label.startsWith('verify ') ? 'verify' : label.startsWith('reply ') ? 'reply' : 'reviewers'
}

// One stderr line per start and end, and every 30 seconds the ones still running, for a
// person at the terminal; the same as JSON events in the progress file. A watcher that
// should wake only when it matters (the review skill's) filters `failed`, `error:`,
// `limit:` and `round N done`: every other line is routine.
export function reporter(orca: Subagents | null = null): {
  progress: (event: Progress) => void
  phase: (labels: string[]) => void
  stop: () => void
} {
  // By question, not by label: two agents can carry the same label.
  const running = new Map<number, string>()
  const since = Date.now()
  let beats = 0
  // A beat every 15 seconds says lntt review is alive; stderr hears every second one.
  const timer = setInterval(() => {
    emit({ type: 'beat', running: running.size })
    if (++beats % 2 === 1 || running.size === 0) return
    const labels = [...running.values()].join(', ')
    stderr.write(`lntt review: running ${running.size} (${duration(Date.now() - since)}): ${labels}\n`)
  }, 15_000)
  const id = (phase: string, index: number) => `lntt-review-${process.pid}-${phase}-${index}`
  return {
    phase(labels) {
      if (labels.length > 0) emit({ type: 'phase', phase: phaseOf(labels[0] as string), total: labels.length })
    },
    progress(event) {
      const phase = phaseOf(event.label)
      if (event.type === 'start') {
        running.set(event.index, event.label)
        orca?.start(id(phase, event.index), event.label)
        stderr.write(`lntt review: start ${event.label}\n`)
        emit({ type: 'start', phase, label: event.label, optional: event.optional })
        return
      }
      running.delete(event.index)
      orca?.stop(id(phase, event.index), event.label, event.answer.ok ? 'answered' : event.answer.error)
      const took = duration(event.ms)
      if (!event.answer.ok) {
        // An optional agent's failure does not need anyone: not a `failed` line.
        const word = event.optional ? 'skipped' : 'failed'
        stderr.write(`lntt review: ${word} ${event.label} in ${took}: ${event.answer.error}\n`)
        emit({ type: 'end', phase, label: event.label, outcome: word, error: event.answer.error, ms: event.ms })
      } else {
        const tokens = event.answer.reply.tokens
        stderr.write(
          `lntt review: done ${event.label} in ${took}${tokens === null ? '' : ` (${formatTokens(tokens)})`}\n`,
        )
        emit({ type: 'end', phase, label: event.label, outcome: 'done', tokens, ms: event.ms })
      }
    },
    stop: () => {
      clearInterval(timer)
      orca?.close()
    },
  }
}

// Each agent runs in a process group of its own, so a timeout stops it and whatever it
// started; an interrupt of lntt review stops every group still running.
const groups = new Set<number>()

// The groups SIGTERM was sent to, until their SIGKILL: a closed leader says nothing of its
// group, where a child that ignored SIGTERM may still run.
const terminated = new Set<number>()

// SIGTERM to the group, then SIGKILL to the group five seconds later, whatever the leader
// did meanwhile: a process group id is not reused while a member lives, so the SIGKILL can
// only reach what ignored SIGTERM (an empty group fails with ESRCH). Only a group still
// running is signalled at first: a closed agent's pid may already belong to another process.
function terminate(pid: number): void {
  if (!groups.has(pid)) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  terminated.add(pid)
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
    groups.delete(pid)
    terminated.delete(pid)
  }, 5000).unref()
}

function stopGroups(): void {
  for (const pid of groups) terminate(pid)
}

// Whatever ignored SIGTERM and is still running when lntt review exits goes with it.
process.on('exit', () => {
  for (const pid of [...groups, ...terminated]) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
})

// The host's hook variables stay with the session that owns them: an agent of the round
// would otherwise report to Orca (or Herdr) as that session.
const HOST_HOOKS = /^(ORCA_AGENT_HOOK_|ORCA_PANE_KEY$|ORCA_TAB_ID$|ORCA_AGENT_LAUNCH_TOKEN$|HERDR_)/

export function agentEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !HOST_HOOKS.test(name)) out[name] = value
  return { ...out, ...extra }
}
// An interrupt keeps the agents still waiting from starting, gives the running ones
// SIGTERM and up to five seconds to go before exiting; the exit handler kills what is left.
const interrupted = new AbortController()
// Only for the commands that run agents: a handler cannot run while a jq query holds the event
// loop, so status keeps the default, and a signal ends a query that does not end.
function stopAgentsOnInterrupt() {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      interrupted.abort(`interrupted by ${signal}`)
      stopGroups()
      const until = Date.now() + 5000
      const wait = setInterval(() => {
        if (groups.size > 0 && Date.now() < until) return
        clearInterval(wait)
        exit(130)
      }, 100)
    })
  }
}

function spawner(timeoutMinutes: number): Spawn {
  return (inv: Invocation, signal?: AbortSignal) =>
    new Promise((resolve, reject) => {
      const child = spawn(inv.command, inv.args, {
        env: agentEnv(env, inv.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      if (child.pid) groups.add(child.pid)
      const onAbort = () => {
        if (child.pid) terminate(child.pid)
        reject(new Error(String(signal?.reason)))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      const timer = setTimeout(
        () => {
          if (child.pid) terminate(child.pid)
          reject(new Error(`timed out after ${timeoutMinutes} minutes`))
        },
        timerMs(timeoutMinutes * 60_000),
      )
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (child.pid) groups.delete(child.pid)
        if (code === 0) resolve(out)
        else
          reject(
            new Error(`${inv.command} exited ${code}: ${(err.trim() || out.trim()).split('\n').slice(-3).join(' ')}`),
          )
      })
      // An agent that exits before reading its prompt closes the pipe: `close` reports it.
      child.stdin.on('error', () => {})
      child.stdin.end(inv.stdin)
    })
}

// macOS sleeps on its own schedule, and a sleeping machine stops the round's agents: keep
// it awake while this process runs.
function keepAwake(): void {
  if (process.platform !== 'darwin' || !commandExists('caffeinate')) return
  try {
    spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

// What stops every agent of a round or a reply: its deadline, or an interrupt.
function deadline(minutes: number): AbortSignal {
  const timeout = new AbortController()
  setTimeout(() => timeout.abort(`the round took longer than ${minutes} minutes`), timerMs(minutes * 60_000)).unref()
  return AbortSignal.any([timeout.signal, interrupted.signal])
}

// One round (or reply) at a time per worktree: a second would overwrite the state and the
// progress of the first. A lock whose process is gone is taken over.
class LockedError extends Error {}

// The pid a lock names, or null when it names none: a file just created by another run
// is empty for an instant, so a fresh empty one counts as held.
function lockHolder(lock: string): number | 'held' | null {
  try {
    const text = readFileSync(lock, 'utf8').trim()
    if (text === '') return Date.now() - statSync(lock).mtimeMs < 2000 ? 'held' : null
    const pid = Number(text)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

// The lock of the worktree's rounds, next to its state.
function lockPath(): string {
  return join(git('rev-parse', '--absolute-git-dir'), 'lntt-review.lock')
}

// Created atomically (`wx`): of two runs started together, one gets it. A lock whose
// process is gone, or that names none, is removed and tried once more.
function acquireLock(): void {
  const lock = lockPath()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      process.on('exit', () => {
        try {
          if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock)
        } catch {}
      })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = lockHolder(lock)
      if (holder !== null) {
        throw new LockedError(
          `a round is already running in this worktree (pid ${holder === 'held' ? 'starting' : holder})`,
        )
      }
      try {
        unlinkSync(lock)
      } catch {}
    }
  }
  throw new LockedError('a round is already running in this worktree (pid unknown)')
}

// Where the branch left its base: --base as given (origin/<base>, else <base>), else the
// base every lntt command resolves (src/base.ts), which the plan names.
function mergeBase(root: string, given: string | undefined): string {
  if (given === undefined) {
    const base = projectBase(root, 'head')
    stderr.write(`lntt review: ${base.warning ?? `base ${base.reason}`}\n`)
    return git('merge-base', 'HEAD', base.ref)
  }
  const ref = localRef(root, given)
  if (ref === null)
    throw new Error(`no ${given} or origin/${given} to compare the branch with: run git fetch origin, or check --base`)
  return git('merge-base', 'HEAD', ref)
}

// The mutations the reviewers proposed, run on a scratch copy of the head: the tree the
// reviewers read is not touched. A run that cannot happen (a project without tests.levels,
// no scratch worktree) leaves the finding to the verifiers.
function runMutations(
  root: string,
  data: Record<string, unknown>,
  mutations: { path: string; line: number; text: string; to: string }[],
): MutationAnswer[] {
  try {
    const { outcomes } = mutateAll({ root, data, files: projectFiles(root) }, mutations)
    return outcomes.map((outcome, i) => {
      const { message } = describeOutcome(mutations[i] as (typeof mutations)[number], outcome)
      const decided = outcome.outcome === 'killed' ? 'killed' : outcome.outcome === 'survived' ? 'survived' : null
      return { decided, proof: message }
    })
  } catch (error) {
    return mutations.map(() => ({ decided: null, proof: `could not run: ${(error as Error).message}` }))
  }
}

async function round(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { base: { type: 'string' }, plan: { type: 'boolean', default: false } },
  })
  if (!values.plan) {
    acquireLock()
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
  const root = git('rev-parse', '--show-toplevel')
  const state = readState(branch)
  const range = roundRange(state, branch, head, git('rev-parse', '--short', mergeBase(root, values.base)), (a, b) => {
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
  const stop = deadline(config.roundTimeoutMinutes)
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
      : areas.map((area) => [area, formatJson(runArea(area, undefined, [], { root, data, base: range.from }))]),
  )
  const report = reporter(orcaSubagents(env, root))
  const began = Date.now()
  const result = await runRound(
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
      cite: (path, line) => cite(root, path, line),
      mutate: async (mutations) => runMutations(root, data, mutations),
    },
    (questions) => {
      report.phase(questions.map((q) => q.label ?? ''))
      return askAll(questions, spawner(config.timeoutMinutes), report.progress, {
        perProvider: config.perProvider,
        optionalGraceMs: config.optionalGraceMinutes * 60_000,
        signal: stop,
      })
    },
    open,
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
  report.stop()
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
}

// The branch HEAD names; the review keeps its rounds per branch.
function headBranch(): string {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') throw new Error('HEAD is detached; the review keeps its rounds per branch: switch to one')
  return branch
}

// The reviewers that found it, each resumed in its own session with the author's
// answer. Withdrawn when every one of them withdraws it.
async function reply(args: string[]): Promise<number> {
  const [id, ...words] = args
  if (!id || words.length === 0) usage('give the finding and the answer')
  const state = readState(headBranch())
  const finding = state?.result.findings.find((f) => f.id === id)
  if (!state || !finding) throw new Error(`no open finding ${id} in the last round`)
  acquireLock()
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
  const report = reporter()
  const answers = await askAll(
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
      signal: deadline(config.roundTimeoutMinutes),
    },
  )
  report.stop()
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
}

// What the branch's rounds cost, from its state alone: the line the pull request's Review
// cost takes, or with --json each round and the total.
function cost(args: string[]): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean', default: false } } })
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const state = branch === 'HEAD' ? null : readState(branch)
  const rounds = state?.rounds ?? []
  const total = reviewCost(rounds, legacyRounds(state))
  stdout.write(
    values.json
      ? `${JSON.stringify({ branch, rounds, total: { rounds: total.rounds, tokens: total.tokens, usd: total.usd, unrecorded: total.unrecorded, line: total.line } }, null, 2)}\n`
      : `${total.line}\n`,
  )
  return 0
}

// A person allows the branch more rounds past delivery.review.maxRounds, kept in its
// state: the configuration, and every other branch, stay as they are.
function allow(args: string[]): number {
  const [count, ...rest] = args
  const rounds = Number(count)
  if (rest.length > 0 || !count || !/^\d+$/.test(count) || rounds < 1)
    usage('give the rounds to allow, a whole number from 1')
  acquireLock()
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
}

// A state file that is not a state (a write cut short, a hand edit): `status` says so and
// `--clear` removes it, the only way out that does not open the git directory.
class UnreadableStateError extends Error {}

// The state as `lntt review status` reads it: an error when it cannot be read, never a
// round started on a guess.
function statusState(branch: string | null): { state: ReviewState; updated: Date } | null {
  if (branch === null) return null
  const path = statePath(branch)
  if (!existsSync(path)) return null
  let state: ReviewState
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as ReviewState
  } catch {
    state = null as unknown as ReviewState
  }
  const result = state?.result as Partial<ReviewState['result']> | undefined
  if (
    state?.branch !== branch ||
    typeof state.round !== 'number' ||
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray(result.findings)
  )
    throw new UnreadableStateError(`${path} cannot be read: pnpm exec lntt review status --clear removes it`)
  return { state: withDefaults(state), updated: statSync(path).mtime }
}

// A state written before a field existed, with that field's default.
function withDefaults(state: ReviewState): ReviewState {
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
    } as ReviewState['result'],
  }
}

// The ledger as it is on disk, whatever branch it names: {} when it cannot be read.
function ledgerFile(branch: string): Partial<Ledger> | null {
  const path = ledgerPath(branch)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
  } catch {
    return {}
  }
}

// A branch is merged when its tip (its local ref, else the head its last round read) is
// in the base every lntt command resolves (src/base.ts), which may ask GitHub for the open
// candidate. Null, with the reason, when that cannot be told: no base to compare with, a
// candidate GitHub could not name, no tip. Never a guess of "not merged".
function mergedInto(root: string, branch: string, head: string | null): { merged: boolean | null; why: string } {
  let ref: string
  try {
    const base = projectBase(root, 'head')
    if (base.warning) return { merged: null, why: base.warning }
    ref = base.ref
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  } catch (error) {
    return { merged: null, why: `no base to compare with (${(error as Error).message.split('\n')[0]})` }
  }
  let tip = head
  try {
    tip = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`)
  } catch {}
  if (!tip) return { merged: null, why: `no commit of ${branch} to compare with ${ref}` }
  try {
    git('merge-base', '--is-ancestor', tip, ref)
    return { merged: true, why: `in ${ref}` }
  } catch {
    return { merged: false, why: `not in ${ref}` }
  }
}

function anchor(f: { path: string | null; line: number | null }): string {
  return f.path === null ? '(no anchor)' : `${f.path}${f.line === null ? '' : `:${f.line}`}`
}

// "a", "a and b", "a, b and c".
function listed(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

// The current branch's state, ledger and progress go once the branch is merged, or at once
// when its state cannot be read; never while a round holds the lock, and never the lock itself.
// The ledger of a branch that is not merged stays when only an unreadable state goes. The
// states of branches that no longer exist go with --prune.
function clear(root: string, current: string | null): number {
  const holder = lockHolder(lockPath())
  if (holder !== null)
    throw new Error(
      `a round is running in this worktree (pid ${holder === 'held' ? 'starting' : holder}): nothing cleared`,
    )
  let own: ReturnType<typeof statusState> = null
  let unreadable = false
  try {
    own = statusState(current)
  } catch (error) {
    if (!(error instanceof UnreadableStateError)) throw error
    unreadable = true
  }
  const ledger = current === null ? null : ledgerFile(current)
  if (current === null || (!own && !unreadable && !ledger)) {
    stdout.write('lntt review: nothing to clear\n')
    return 0
  }
  const check = mergedInto(root, current, own?.state.result.head ?? null)
  const merged = check.merged === true
  if (!merged && !unreadable)
    throw new Error(
      check.merged === null
        ? `the state is ${current}'s, the current branch, and whether it is merged cannot be told (${check.why}): nothing cleared`
        : `the state is ${current}'s, the current branch, and it is not merged (${check.why}): nothing cleared`,
    )
  const removed: string[] = []
  const remove = (name: string, path: string) => {
    if (!existsSync(path)) return
    unlinkSync(path)
    removed.push(name)
  }
  remove('state', statePath(current))
  if (merged) remove('ledger', ledgerPath(current))
  remove('progress', progressPath())
  stdout.write(`lntt review: cleared ${unreadable ? 'an unreadable state: its' : `${current}'s`} ${listed(removed)}\n`)
  return 0
}

// The states and ledgers of branches that are gone: no local branch and no remote-tracking
// one of that name, or a local branch whose upstream is gone (GitHub deletes the head branch
// when it merges and the local one stays). A branch checked out in a worktree stays: a round
// may be running there. --dry-run says what would go.
function prune(dry: boolean): number {
  const dir = place().dir
  const refs = parseRefs(
    git('for-each-ref', '--format=%(refname)%09%(upstream:track)', 'refs/heads', 'refs/remotes'),
    git('worktree', 'list', '--porcelain'),
  )
  let gone = 0
  for (const branch of branchesIn(dir).sort()) {
    const reason = pruneReason(branch, refs)
    if (reason === null) continue
    gone++
    const removed = dry ? [] : removeBranch(dir, branch)
    stdout.write(
      `lntt review: ${dry ? 'would prune' : 'pruned'} ${branch} (${reason})${dry ? '' : `: ${listed(removed)}`}\n`,
    )
  }
  if (gone === 0) stdout.write('lntt review: nothing to prune\n')
  return 0
}

// What the views of a state share: its limit, and what is left of its last round.
function stateView(state: ReviewState, maxRounds: number) {
  const { result } = state
  const allowed = state.allowed ?? 0
  const limit = maxRounds + allowed
  const clean = roundClean(result)
  const ledger = ledgerFile(state.branch)
  return {
    allowed,
    limit,
    clean,
    atLimit: state.round >= limit && !clean,
    open: result.findings.filter((f) => f.verdict !== 'withdrawn'),
    replied: result.findings.filter((f) => f.reply !== undefined || f.verdict === 'withdrawn'),
    closed: ledger?.branch === state.branch && Array.isArray(ledger.closed) ? ledger.closed : [],
    // The last round's own tokens and USD; the branch's total is lntt review cost.
    tokens: result.tokens ?? null,
    cost: result.cost ?? null,
  }
}

// An error as one short line: a reviewer's can run for lines and pages. The whole of it is in
// `.state.failed`.
function oneLine(text: string): string {
  const [first = ''] = text.split('\n')
  return first.length > 200 ? `${first.slice(0, 200)}…` : first === text ? text : `${first} …`
}

// One line of outcome and one per thing to act on: what a round, the limit and status print.
// `also` is one more clause of the outcome: a round running, a round refused.
function summary(state: ReviewState, view: ReturnType<typeof stateView>, also: string): string[] {
  const { result } = state
  const { open, replied, closed, tokens, cost } = view
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
  ]
}

// Each level of the state as its count, named as its key under `.state`: what is there to ask
// for with --query.
function folded(state: ReviewState, view: ReturnType<typeof stateView>): string[] {
  const { result } = state
  return [
    `findings: ${result.findings.length} (${view.open.length} open)`,
    `refuted: ${result.refuted.length}`,
    `repeated: ${result.closed.length}`,
    `closed: ${view.closed.length}`,
    `failed: ${result.failed.length}`,
    `partial: ${result.partial.length}`,
    `skipped: ${result.skipped.length}`,
    `rounds: ${(state.rounds ?? []).length}`,
  ]
}

function noRoundLine(here: string, running: string): string {
  return `lntt review: no round on ${here} yet${running ? `; ${running}` : ''}`
}

// A jq expression on the document --json prints, run by jq-wasm, loaded here so that no other
// call pays for it. Strings raw unless --json. `--` ends jq's flags: an expression that starts
// with a dash stays an expression. A success exits as status does; any failure of jq exits 2
// with nothing on stdout, what it printed before failing included, and so does the wasm giving
// up (out of memory, too deep a recursion). With no state at all, a failure while running exits
// 4, there being no round to read, with jq's message: the expression may be at fault too.
async function runQuery(
  document: { state: unknown },
  expression: string,
  json: boolean,
  code: number,
  noRound: string,
): Promise<number> {
  const { raw } = await import('jq-wasm')
  let jq: Awaited<ReturnType<typeof raw>>
  try {
    jq = await raw(JSON.stringify(document), expression, [...(json ? [] : ['-r']), '-c', '--'])
  } catch (error) {
    stderr.write(`lntt review: jq gave up: ${(error as Error).message}\n`)
    return 2
  }
  if (jq.exitCode === 5 && document.state === null) {
    stderr.write(`${noRound}\n${jq.stderr}\n`)
    return 4
  }
  if (jq.exitCode !== 0) {
    stderr.write(`${jq.stderr || `jq exited ${jq.exitCode}`}\n`)
    return 2
  }
  if (jq.stderr) stderr.write(`${jq.stderr}\n`)
  if (jq.stdout) stdout.write(`${jq.stdout}\n`)
  return code
}

// What `lntt review status` reads: the worktree's own state, through lntt review and
// never from its files, which live in each worktree's git directory. Each level folded, one
// line of outcome and one per thing to act on; the whole of it with --json, a part with
// --query. The exit code says which: 0 clean, 1 something to act on, 3 at the limit, 4 no
// round on this branch. It never takes the lock and never writes the progress file: a
// running round keeps both.
async function status(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      query: { type: 'string' },
    },
  })
  if (values.clear && values.json) usage('--clear does not take --json')
  if (values.clear && values.query !== undefined) usage('--clear does not take --query')
  if (values.prune && (values.clear || values.json || values.query !== undefined)) {
    usage('--prune takes only --dry-run')
  }
  if (values['dry-run'] && !values.prune) usage('--dry-run goes with --prune')
  const root = git('rev-parse', '--show-toplevel')
  // The branch HEAD names, also before its first commit; null when HEAD is detached.
  let current: string | null = null
  try {
    current = git('symbolic-ref', '--short', '-q', 'HEAD') || null
  } catch {}
  if (values.clear) return clear(root, current)
  if (values.prune) return prune(values['dry-run'])
  // A lock created an instant ago names no pid yet: not a round running, for the summary as
  // for the JSON; --clear still waits for it.
  const holder = lockHolder(lockPath())
  const running = typeof holder === 'number' ? holder : null
  const runningText = running === null ? '' : `a round is running (pid ${running})`
  const own = statusState(current)
  const here = current ?? 'detached HEAD'
  if (!own) {
    const line = noRoundLine(here, runningText)
    const none = { branch: current, running, state: null }
    if (values.query !== undefined) return runQuery(none, values.query, values.json, 4, line)
    stdout.write(values.json ? `${JSON.stringify(none, null, 2)}\n` : `${line}\n`)
    return 4
  }
  const { state, updated } = own
  const result = state.result
  const { maxRounds } = reviewConfig(loaded())
  const view = stateView(state, maxRounds)
  const code = view.clean ? 0 : view.atLimit ? 3 : 1
  if (values.json || values.query !== undefined) {
    const out = {
      branch: current,
      running,
      state: {
        branch: state.branch,
        // The place holds a branch's own state: it is always the current branch's.
        current: true,
        updated: updated.toISOString(),
        merged: mergedInto(root, state.branch, result.head).merged,
        round: state.round,
        maxRounds,
        allowed: view.allowed,
        limit: view.limit,
        reviewed: state.reviewed,
        base: result.base,
        head: result.head,
        clean: view.clean,
        atLimit: view.atLimit,
        blocking: result.blocking,
        scope: result.scope,
        lenses: result.lenses,
        open: view.open,
        replied: view.replied,
        closed: view.closed,
        failed: result.failed,
        partial: result.partial,
        skipped: result.skipped,
        tokens: view.tokens,
        cost: view.cost,
        // The last round whole, and the cost of each round.
        findings: result.findings,
        refuted: result.refuted,
        // Not `closed`, which is the ledger: the fresh findings that repeat an entry of it.
        repeated: result.closed,
        rounds: state.rounds ?? [],
      },
    }
    if (values.query !== undefined) return runQuery(out, values.query, values.json, code, '')
    stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return code
  }
  stdout.write(`${[...folded(state, view), ...summary(state, view, runningText)].join('\n')}\n`)
  return code
}

// process.exit drops what a pipe has not taken yet, so a long document would arrive cut, with
// no sign of it: stdout is flushed first.
async function leave(code: number): Promise<never> {
  await new Promise<void>((resolve) => stdout.write('', () => resolve()))
  exit(code)
}

export async function main([command, ...args]: string[]): Promise<void> {
  // A reader that left (`| head`) is its own business: the exit code still says the outcome.
  stdout.on('error', () => {})
  try {
    if (command === 'allow') await leave(allow(args))
    if (command === 'status') await leave(await status(args))
    if (command === 'cost') await leave(cost(args))
    stopAgentsOnInterrupt()
    await leave(command === 'reply' ? await reply(args) : await round(command === undefined ? [] : [command, ...args]))
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    // `error:` is what the review skill watches for, with `failed`, `limit:` and `round N done`.
    stderr.write(`lntt review: error: ${(error as Error).message}\n`)
    // A refused lock means another round owns the progress file: leave it alone.
    const own = !(error instanceof LockedError)
    // lntt review status never writes the progress file: it only reads the state.
    const reads = command === 'status'
    if (
      own &&
      !reads &&
      command !== 'reply' &&
      command !== 'allow' &&
      command !== 'cost' &&
      !progressFile &&
      ![command, ...args].includes('--plan')
    )
      startProgress()
    emit({ type: 'error', message: (error as Error).message })
    exit(1)
  }
}
