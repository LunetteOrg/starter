// Agents run headless, in parallel, each with no context but its prompt and no tool
// that writes: the reviewers and verifiers of `lntt review`, and whatever else asks
// several agents and providers the same question. One process per question; a
// conversation goes on by resuming its session, which the agent keeps on disk.

import type { Agent } from './worktree.ts'

export interface Invocation {
  command: string
  args: string[]
  env: Record<string, string>
  // The prompt on stdin, or null when it is an argument.
  stdin: string | null
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
}

export type Answer = { ok: true; reply: Reply } | { ok: false; error: string }

// Starts one invocation in the working directory and resolves with its stdout; rejects
// when the process fails or outlives the timeout.
export type Spawn = (invocation: Invocation) => Promise<string>

// claude: only the read tools, and no MCP server (the machine's servers can send mail
// or write to other services). opencode: an inline agent with every tool that writes,
// runs or asks denied (`question` would wait for an answer nobody gives), read by a
// standalone server only.
const CLAUDE_READ_ONLY = ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
const OPENCODE_AGENT = 'lntt-readonly'
const OPENCODE_DENY = ['edit', 'bash', 'webfetch', 'websearch', 'task', 'execute', 'subagent', 'question']

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
    const permission = Object.fromEntries(OPENCODE_DENY.map((tool) => [tool, 'deny']))
    const config = { agent: { [OPENCODE_AGENT]: { mode: 'primary', permission } } }
    const args = ['run', '--standalone', '--agent', OPENCODE_AGENT, '--format', 'json']
    if (agent.model) args.push('-m', agent.model)
    if (session) args.push('-s', session)
    args.push(prompt)
    return { command: 'opencode', args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdin: null }
  }
  throw new Error(`${agent.kind} has no read-only headless mode here; the agents are claude, opencode`)
}

export function parseReply(kind: string, stdout: string): Reply {
  if (kind === 'claude') {
    const out = JSON.parse(stdout) as {
      result?: string
      session_id?: string
      is_error?: boolean
      total_cost_usd?: number
    }
    if (out.is_error) throw new Error(out.result ?? 'claude failed')
    return { text: out.result ?? '', session: out.session_id ?? null, cost: out.total_cost_usd ?? null }
  }
  // opencode: one JSON event per line; the answer is the text of the last message.
  const events = stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string
          sessionID?: string
          part?: { messageID?: string; type?: string; text?: string }
          error?: { message?: string }
        },
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

// Every question starts at once; each answer stays in its question's place.
export async function askAll(questions: Question[], spawn: Spawn): Promise<Answer[]> {
  return Promise.all(
    questions.map(async (q): Promise<Answer> => {
      try {
        const stdout = await spawn(headlessInvocation(q.agent, q.prompt, q.session))
        return { ok: true, reply: parseReply(q.agent.kind, stdout) }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }),
  )
}
