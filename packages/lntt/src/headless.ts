// Agents run headless, in parallel, each with no context but its prompt and no tool
// that writes: the reviewers and verifiers of `lntt review`, and whatever else asks
// several agents and providers the same question. One process per question; a
// conversation goes on by resuming its session, which the agent keeps on disk.

import type { Agent } from './worktree.ts'

export interface Invocation {
  command: string
  args: string[]
  env: Record<string, string>
  // The prompt, written to stdin.
  stdin: string
}

export interface Reply {
  text: string
  session: string | null
  // In USD, when the agent reports it (claude does, opencode does not).
  cost: number | null
  // Every token the answer took: input, cache written and read, output, reasoning.
  tokens: number | null
}

// An agent as lntt review lists it: optional when its failure (a free model that times
// out) is reported without failing the round.
export interface HeadlessAgent extends Agent {
  optional?: boolean
}

// Where the prompt goes: claude's provider, or the provider part of an opencode model.
export function providerOf(agent: Agent): string {
  if (agent.kind === 'claude') return 'anthropic'
  return agent.model?.split('/')[0] ?? agent.kind
}

export interface Question {
  agent: HeadlessAgent
  prompt: string
  // A session to resume: the same reviewer, answering the author.
  session?: string
  // How progress names it: `code · claude sonnet`.
  label?: string
}

export type Answer = { ok: true; reply: Reply } | { ok: false; error: string }

// Starts one invocation in the working directory and resolves with its stdout; rejects
// when the process fails, outlives the timeout, or the signal stops it.
export type Spawn = (invocation: Invocation, signal?: AbortSignal) => Promise<string>

// claude: only the read tools, and no MCP server (the machine's servers can send mail
// or write to other services). opencode: an inline agent, read by a standalone server
// only, that denies every tool and allows the read ones back, so a tool opencode adds
// (or one this list would forget, as `write` or `question`) is denied too. Both take the
// prompt on stdin: a diff does not fit an argument.
const CLAUDE_READ_ONLY = ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
const OPENCODE_AGENT = 'lntt-readonly'
const OPENCODE_PERMISSION = { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' }

export function headlessInvocation(agent: Agent, prompt: string, session?: string): Invocation {
  if (agent.kind === 'claude') {
    const args = ['-p', '--output-format', 'json', ...CLAUDE_READ_ONLY]
    if (agent.model) args.push('--model', agent.model)
    if (agent.effort) args.push('--effort', agent.effort)
    if (session) args.push('--resume', session)
    return { command: 'claude', args, env: {}, stdin: prompt }
  }
  if (agent.kind === 'opencode') {
    if (agent.effort) throw new Error('opencode takes no effort from the command line; drop it from the reviewer')
    if (agent.model && !/^[\w.:-]+\/[\w.:/#-]+$/.test(agent.model)) {
      throw new Error(`opencode model ${agent.model} is not provider/model`)
    }
    const config = { agent: { [OPENCODE_AGENT]: { mode: 'primary', permission: OPENCODE_PERMISSION } } }
    const args = ['run', '--standalone', '--agent', OPENCODE_AGENT, '--format', 'json']
    if (agent.model) args.push('-m', agent.model)
    if (session) args.push('-s', session)
    return { command: 'opencode', args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdin: prompt }
  }
  throw new Error(`${agent.kind} has no read-only headless mode here; the agents are claude, opencode`)
}

function json<T>(kind: string, text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${kind} printed ${what}: ${text.trim().slice(0, 200)}`)
  }
}

export function parseReply(kind: string, stdout: string): Reply {
  if (kind === 'claude') {
    const out = json<{
      result?: string
      session_id?: string
      is_error?: boolean
      total_cost_usd?: number
      usage?: Record<string, unknown>
    }>(kind, stdout, 'no JSON')
    if (out.is_error) throw new Error(out.result ?? 'claude failed')
    if (typeof out.result !== 'string') throw new Error('claude gave no result')
    const u = out.usage
    const tokens = u
      ? ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
          .map((k) => (typeof u[k] === 'number' ? (u[k] as number) : 0))
          .reduce((a, b) => a + b, 0)
      : null
    return { text: out.result, session: out.session_id ?? null, cost: out.total_cost_usd ?? null, tokens }
  }
  // opencode: one JSON event per line; the answer is the text of the last message.
  const events = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) =>
      json<{
        type: string
        sessionID?: string
        part?: {
          messageID?: string
          type?: string
          text?: string
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        }
        error?: { message?: string }
      }>(kind, line, 'a line that is not JSON'),
    )
  const error = events.find((e) => e.type === 'error')
  if (error) throw new Error(error.error?.message ?? 'opencode failed')
  const texts = events.filter((e) => e.type === 'text' && typeof e.part?.text === 'string')
  const last = texts.at(-1)?.part?.messageID
  if (!last) throw new Error('opencode gave no reply')
  const text = texts
    .filter((e) => e.part?.messageID === last)
    .map((e) => e.part?.text)
    .join('\n')
  // opencode reports each step's tokens; the answer took their sum.
  const steps = events.filter((e) => e.type === 'step_finish' && e.part?.tokens)
  const tokens =
    steps.length === 0
      ? null
      : steps
          .map(({ part }) => {
            const t = part?.tokens ?? {}
            return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
          })
          .reduce((a, b) => a + b, 0)
  return { text, session: events.find((e) => e.sessionID)?.sessionID ?? null, cost: null, tokens }
}

// setTimeout holds at most 2^31-1 ms (about 24.8 days); a longer delay fires at once.
export function timerMs(ms: number): number {
  return Math.min(Math.max(0, ms), 2 ** 31 - 1)
}

export type Progress =
  | { type: 'start'; index: number; label: string; optional: boolean }
  | { type: 'end'; index: number; label: string; optional: boolean; answer: Answer; ms: number }

export interface AskOptions {
  // How many agents of one provider run at once; the rest wait their turn. A provider
  // given dozens of sessions at once queues or limits them until they time out.
  perProvider?: number
  // How long optional agents may go on once every other agent has answered; then they
  // are stopped, and those still waiting never start. Without it, they are awaited.
  optionalGraceMs?: number
  // Stops every agent, required ones too, and keeps the waiting ones from starting: the
  // round's own deadline.
  signal?: AbortSignal
}

// Every question runs as soon as its provider has a free slot; each answer stays in its
// question's place. Progress hears each start when the agent starts, and each end.
export async function askAll(
  questions: Question[],
  spawn: Spawn,
  progress: (event: Progress) => void = () => {},
  options: AskOptions = {},
): Promise<Answer[]> {
  const limit = options.perProvider ?? Number.POSITIVE_INFINITY
  const queues = new Map<string, { running: number; waiting: (() => void)[] }>()
  const slot = async (provider: string): Promise<() => void> => {
    const q = queues.get(provider) ?? { running: 0, waiting: [] }
    queues.set(provider, q)
    if (q.running >= limit) await new Promise<void>((resolve) => q.waiting.push(resolve))
    q.running++
    return () => {
      q.running--
      q.waiting.shift()?.()
    }
  }
  const stop = new AbortController()
  const required = questions.filter((q) => !q.agent.optional).length
  let answered = 0
  const grace = options.optionalGraceMs
  const runs = questions.map(async (q, index): Promise<Answer> => {
    const label = q.label ?? q.agent.kind
    const optional = q.agent.optional === true
    // Optional agents queue apart: a slow one never holds a required agent's turn.
    const release = await slot(`${providerOf(q.agent)}${optional ? ' (optional)' : ''}`)
    const signals = [options.signal, optional ? stop.signal : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    )
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined
    let answer: Answer
    if (signal?.aborted) {
      release()
      answer = { ok: false, error: String(signal.reason) }
      progress({ type: 'end', index, label, optional, answer, ms: 0 })
      return answer
    }
    const started = Date.now()
    progress({ type: 'start', index, label, optional })
    try {
      const stdout = await spawn(headlessInvocation(q.agent, q.prompt, q.session), signal)
      answer = { ok: true, reply: parseReply(q.agent.kind, stdout) }
    } catch (error) {
      answer = { ok: false, error: (error as Error).message }
    }
    release()
    progress({ type: 'end', index, label, optional, answer, ms: Date.now() - started })
    if (!optional && ++answered === required && grace !== undefined) {
      const reason = `stopped: the other agents answered ${Math.round(grace / 1000)}s before`
      setTimeout(() => stop.abort(reason), timerMs(grace)).unref()
    }
    return answer
  })
  return Promise.all(runs)
}
