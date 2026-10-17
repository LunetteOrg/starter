// `lntt review`: one review round on the current branch, or an answer to a reviewer
// (usage: bin/lntt.ts).

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { ConfigError } from './files.ts'
import { askAll, headlessInvocation, type Invocation, type Progress, type Spawn } from './headless.ts'
import { findConfig, loadConfig } from './index.ts'
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
import type { Agent } from './worktree.ts'

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
    if (error instanceof ConfigError) return {}
    throw error
  }
  return loadConfig(cwd()).data
}

// Where each agent sends the diff: the project's choice, shown every time.
function destinations(agents: Agent[]): string {
  const to = new Set(
    agents.map((a) =>
      a.kind === 'claude' ? 'anthropic (claude)' : `${a.model?.split('/')[0] ?? 'default'} (${a.kind})`,
    ),
  )
  return [...to].join(', ')
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

// One stderr line per start and end, and every 30 seconds the ones still running, for a
// person at the terminal. A watcher that should wake only when it matters (the review
// skill's) filters `failed` and `round N done`: every other line is routine.
function reporter(): { progress: (event: Progress) => void; stop: () => void } {
  const running = new Map<string, number>()
  const since = Date.now()
  const timer = setInterval(() => {
    if (running.size === 0) return
    const labels = [...running.keys()].join(', ')
    stderr.write(`lntt review: running ${running.size} (${duration(Date.now() - since)}): ${labels}\n`)
  }, 30_000)
  return {
    progress(event) {
      if (event.type === 'start') {
        running.set(event.label, Date.now())
        stderr.write(`lntt review: start ${event.label}\n`)
        return
      }
      running.delete(event.label)
      const took = duration(event.ms)
      if (!event.answer.ok) stderr.write(`lntt review: failed ${event.label} in ${took}: ${event.answer.error}\n`)
      else {
        const cost = event.answer.reply.cost === null ? '' : ` (${event.answer.reply.cost.toFixed(3)} $)`
        stderr.write(`lntt review: done ${event.label} in ${took}${cost}\n`)
      }
    },
    stop: () => clearInterval(timer),
  }
}

function spawner(timeoutMinutes: number): Spawn {
  return (inv: Invocation) =>
    new Promise((resolve, reject) => {
      const child = spawn(inv.command, inv.args, { env: { ...env, ...inv.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`timed out after ${timeoutMinutes} minutes`))
      }, timeoutMinutes * 60_000)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
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
  const data = loaded()
  const config = reviewConfig(data)
  const dirty = git('status', '--porcelain')
  if (dirty !== '') {
    stderr.write(`lntt review: the working tree has uncommitted changes; the review reads commits:\n${dirty}\n`)
    return 1
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
  const report = reporter()
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
    (questions) => askAll(questions, spawner(config.timeoutMinutes), report.progress),
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
  const cost = result.cost === null ? '' : `, ${result.cost.toFixed(3)} $`
  stderr.write(
    `lntt review: round ${saved.round} done in ${duration(Date.now() - began)}: ${result.findings.length} findings, ${result.refuted.length} refuted, ${result.failed.length} failed${cost}\n`,
  )
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
    stderr.write(`lntt review: ${(error as Error).message}\n`)
    exit(1)
  }
}
