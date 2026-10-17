// Orca shows the agents of a round of `lntt review` as subagents of the Claude Code
// session that started it, nested under it in its sidebar. Orca learns of a subagent from
// the SubagentStart and SubagentStop events Claude Code sends through Orca's hook script,
// with the session's pane variables; this adapter sends the same events for each reviewer
// and verifier. It follows an internal Orca protocol (see docs/adr/review-agents.md), so
// it does nothing when any piece is missing, and a failed send never fails the round.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type Env = Record<string, string | undefined>

// The variables of a Claude Code session running in an Orca terminal.
const NEEDED = ['ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN', 'ORCA_PANE_KEY', 'CLAUDE_CODE_SESSION_ID']

// Orca's hook script, when this process runs under a Claude Code session in Orca.
export function orcaHookScript(env: Env, exists: (path: string) => boolean = existsSync): string | null {
  if (NEEDED.some((name) => !env[name]) || !env.HOME) return null
  const script = join(env.HOME, '.orca/agent-hooks/claude-hook.sh')
  return exists(script) ? script : null
}

export type SubagentEventName = 'SubagentStart' | 'SubagentStop'

// The payload Claude Code sends for a subagent, with the label as its type: Orca shows it.
export function subagentEvent(
  name: SubagentEventName,
  session: string,
  agentId: string,
  label: string,
  cwd: string,
  lastMessage?: string,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    session_id: session,
    transcript_path: '',
    cwd,
    hook_event_name: name,
    agent_id: agentId,
    agent_type: label,
  }
  if (name === 'SubagentStop') {
    Object.assign(event, {
      stop_hook_active: false,
      agent_transcript_path: '',
      last_assistant_message: lastMessage ?? '',
    })
  }
  return event
}

export interface Subagents {
  start(id: string, label: string): void
  stop(id: string, label: string, message: string): void
  close(): void
}

// Orca drops subagents when the parent's turn stops: a running agent's start is sent
// again every `everyMs`, so it comes back within the interval.
export function subagents(
  send: (event: Record<string, unknown>) => void,
  session: string,
  cwd: string,
  everyMs = 2000,
): Subagents {
  const running = new Map<string, string>()
  const timer = setInterval(() => {
    for (const [id, label] of running) send(subagentEvent('SubagentStart', session, id, label, cwd))
  }, everyMs)
  timer.unref()
  return {
    start(id, label) {
      running.set(id, label)
      send(subagentEvent('SubagentStart', session, id, label, cwd))
    },
    stop(id, label, message) {
      running.delete(id)
      send(subagentEvent('SubagentStop', session, id, label, cwd, message))
    },
    close() {
      clearInterval(timer)
      for (const [id, label] of running) send(subagentEvent('SubagentStop', session, id, label, cwd, 'stopped'))
      running.clear()
    },
  }
}

// The subagents of this round in Orca, or null when this is not a Claude Code session in
// Orca. Each event goes through Orca's own script, in the background.
export function orcaSubagents(env: Env, cwd: string): Subagents | null {
  const script = orcaHookScript(env)
  if (!script) return null
  const send = (event: Record<string, unknown>) => {
    try {
      const child = spawn('sh', [script], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => {})
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(event))
    } catch {}
  }
  return subagents(send, env.CLAUDE_CODE_SESSION_ID as string, cwd)
}
