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
}

export interface Question {
  agent: Agent
  prompt: string
  // A session to resume: the same reviewer, answering the author.
  session?: string
  // How progress names it: `code · claude sonnet`.
  label?: string
}

export type Answer = { ok: true; reply: Reply } | { ok: false; error: string }

// Starts one invocation in the working directory and resolves with its stdout; rejects
// when the process fails or outlives the timeout.
export type Spawn = (invocation: Invocation) => Promise<string>

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
    }>(kind, stdout, 'no JSON')
    if (out.is_error) throw new Error(out.result ?? 'claude failed')
    if (typeof out.result !== 'string') throw new Error('claude gave no result')
    return { text: out.result, session: out.session_id ?? null, cost: out.total_cost_usd ?? null }
  }
  // opencode: one JSON event per line; the answer is the text of the last message.
  const events = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) =>
      json<{
        type: string
        sessionID?: string
        part?: { messageID?: string; type?: string; text?: string }
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
  return { text, session: events.find((e) => e.sessionID)?.sessionID ?? null, cost: null }
}

export type Progress = { type: 'start'; label: string } | { type: 'end'; label: string; answer: Answer; ms: number }

// Every question starts at once; each answer stays in its question's place. Progress
// hears each start, then each end as it comes.
export async function askAll(
  questions: Question[],
  spawn: Spawn,
  progress: (event: Progress) => void = () => {},
): Promise<Answer[]> {
  const runs = questions.map((q) => {
    const label = q.label ?? q.agent.kind
    const started = Date.now()
    progress({ type: 'start', label })
    return (async (): Promise<Answer> => {
      let answer: Answer
      try {
        const stdout = await spawn(headlessInvocation(q.agent, q.prompt, q.session))
        answer = { ok: true, reply: parseReply(q.agent.kind, stdout) }
      } catch (error) {
        answer = { ok: false, error: (error as Error).message }
      }
      progress({ type: 'end', label, answer, ms: Date.now() - started })
      return answer
    })()
  })
  return Promise.all(runs)
}
