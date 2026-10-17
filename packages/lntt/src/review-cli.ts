// `lntt review`: one review round on the current branch, or an answer to a reviewer
// (usage: bin/lntt.ts).

import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
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
import { findConfig, loadConfig } from './index.ts'
import { orcaSubagents, type Subagents } from './orca-subagents.ts'
import {
  agentLabel,
  type Checked,
  lensApplies,
  parseWithdrawal,
  type ReviewConfig,
  type ReviewState,
  renderReplyPrompt,
  reviewConfig,
  roundClean,
  roundRange,
  runRound,
} from './review.ts'
import { commandExists } from './viewer.ts'

const USAGE = `usage: lntt review [--base <branch>] [--plan]
       lntt review reply <finding> <answer>`

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

// What the round lntt review keeps between runs: in the worktree's own git directory,
// so each worktree has its own and nothing reaches a commit.
function statePath(): string {
  return join(git('rev-parse', '--absolute-git-dir'), 'lntt-review.json')
}

function readState(): ReviewState | null {
  const path = statePath()
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ReviewState) : null
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

export function formatTokens(n: number | null): string {
  if (n === null) return ''
  if (n < 1000) return `${n} tokens`
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k tokens`.replace('.0k', 'k')
  return `${Math.round(n / 100_000) / 10}M tokens`.replace('.0M', 'M')
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
function startProgress(): void {
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
// should wake only when it matters (the review skill's) filters `failed`, `error:` and
// `round N done`: every other line is routine.
function reporter(orca: Subagents | null = null): {
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

// SIGTERM to the group, then SIGKILL to what is still there five seconds later. Only a
// group still running: a closed agent's pid may already belong to another process.
function terminate(pid: number): void {
  if (!groups.has(pid)) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {}
  setTimeout(() => {
    if (!groups.has(pid)) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
    groups.delete(pid)
  }, 5000).unref()
}

function stopGroups(): void {
  for (const pid of groups) terminate(pid)
}

// Whatever ignored SIGTERM and is still running when lntt review exits goes with it.
process.on('exit', () => {
  for (const pid of groups) {
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

// Created atomically (`wx`): of two runs started together, one gets it. A lock whose
// process is gone, or that names none, is removed and tried once more.
function acquireLock(): void {
  const lock = join(git('rev-parse', '--absolute-git-dir'), 'lntt-review.lock')
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

function configuredBase(data: Record<string, unknown>): string {
  return (data.delivery as { candidate?: { base?: string } } | undefined)?.candidate?.base ?? 'main'
}

function mergeBase(base: string): string {
  for (const ref of [`origin/${base}`, base]) {
    try {
      return git('merge-base', 'HEAD', ref)
    } catch {}
  }
  throw new Error(`no ${base} or origin/${base} to compare the branch with; give --base`)
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
  const state = readState()
  const range = roundRange(
    state,
    branch,
    head,
    git('rev-parse', '--short', mergeBase(values.base ?? configuredBase(data))),
    (a, b) => {
      try {
        git('merge-base', '--is-ancestor', a, b)
        return true
      } catch {
        return false
      }
    },
  )
  const files = git('diff', '--name-only', `${range.from}..${head}`).split('\n').filter(Boolean)
  const lenses = Object.entries(config.reviewers).filter(([, lens]) => lensApplies(lens, files))
  const plan = [
    `round ${range.round}, ${range.reason}: ${range.from}..${head}, ${files.length} files`,
    ...lenses.map(([name, lens]) => `  ${name}: ${lens.with.map(agentLabel).join(', ')}`),
    `  verify ${config.verify ? `${config.verify.severities.join(', ')}: ${config.verify.with.map(agentLabel).join(', ')}` : 'off'}`,
  ]
  const agents = [...lenses.flatMap(([, lens]) => lens.with), ...(config.verify?.with ?? [])]
  plan.push(`  the diff goes to: ${destinations(agents)}`)
  stderr.write(`lntt review: ${plan.join('\n')}\n`)
  const problems = agentProblems(agents)
  if (values.plan) {
    for (const problem of problems) stderr.write(`lntt review: cannot start ${problem}\n`)
    return 0
  }
  if (problems.length > 0) throw new Error(`cannot start ${problems.join('; ')}`)

  const open = state?.branch === branch ? state.result.findings : []
  keepAwake()
  const stop = deadline(config.roundTimeoutMinutes)
  emit({
    type: 'round',
    pid: process.pid,
    round: range.round,
    range: `${range.from}..${head}`,
    files: files.length,
    optionalGraceMs: config.optionalGraceMinutes * 60_000,
  })
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
      range,
      readBrief: (path) => readFileSync(join(root, path), 'utf8'),
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
  // An empty delta keeps the last round's number: nothing new was read. A round with a
  // failure does not move the reviewed commit, so the next one reads this range again.
  const previous = state?.branch === branch ? state.reviewed : null
  const saved: ReviewState = {
    branch,
    round: files.length > 0 ? range.round : (state?.round ?? 1),
    reviewed: result.failed.length > 0 ? previous : head,
    result,
  }
  writeFileSync(statePath(), `${JSON.stringify(saved, null, 2)}\n`)
  report.stop()
  const tokens = result.tokens === null ? '' : `, ${formatTokens(result.tokens)}`
  stderr.write(
    `lntt review: round ${saved.round} done in ${duration(Date.now() - began)}: ${result.findings.length} findings, ${result.refuted.length} refuted, ${result.failed.length} failed, ${result.skipped.length} skipped${tokens}\n`,
  )
  emit({
    type: 'done',
    round: saved.round,
    findings: result.findings.length,
    refuted: result.refuted.length,
    failed: result.failed.length,
    skipped: result.skipped.length,
    tokens: result.tokens,
    clean: roundClean(result),
  })
  stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return roundClean(result) ? 0 : 1
}

// The reviewers that found it, each resumed in its own session with the author's
// answer. Withdrawn when every one of them withdraws it.
async function reply(args: string[]): Promise<number> {
  const [id, ...words] = args
  if (!id || words.length === 0) usage('give the finding and the answer')
  const state = readState()
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
  if (withdrawn) (finding as Checked).verdict = 'withdrawn'
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`)
  stdout.write(`${JSON.stringify({ id, withdrawn, replies }, null, 2)}\n`)
  return withdrawn ? 0 : 1
}

export async function main([command, ...args]: string[]): Promise<void> {
  try {
    exit(command === 'reply' ? await reply(args) : await round(command === undefined ? [] : [command, ...args]))
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    // `error:` is what the review skill watches for, with `failed` and `round N done`.
    stderr.write(`lntt review: error: ${(error as Error).message}\n`)
    // A refused lock means another round owns the progress file: leave it alone.
    const own = !(error instanceof LockedError)
    if (own && command !== 'reply' && !progressFile && ![command, ...args].includes('--plan')) startProgress()
    emit({ type: 'error', message: (error as Error).message })
    exit(1)
  }
}
