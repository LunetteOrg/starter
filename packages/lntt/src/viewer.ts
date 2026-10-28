// Where to show a page to the operator, decided without asking the agent to reason
// about it: detect the app the session runs in, then take the first of the operator's
// preferred viewers (workspace.viewers) that is available here. Viewers reachable from
// a shell are opened directly; the others are tool calls only the agent can make, so
// the script names the call instead.

import { execFileSync, spawn } from 'node:child_process'

export type Host = 'orca' | 'wave' | 'herdr' | 'claude-desktop' | 'terminal'
export type Viewer = 'orca' | 'wave' | 'claude-desktop' | 'chrome' | 'playwright' | 'browser' | 'none'

export interface Choice {
  host: Host
  viewer: Viewer
  reason: string
  agentCall?: string
}

type Env = Record<string, string | undefined>

// The entrypoints Claude Code itself treats as the desktop app (claude 2.1.312).
const DESKTOP_ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent'])

const TERM_PROGRAMS: Record<string, Host> = { Orca: 'orca', waveterm: 'wave', herdr: 'herdr' }

// Innermost first (docs/adr/worktree-tooling.md). Claude desktop sets the entrypoint on
// the claude it starts. Herdr runs inside a terminal, never the other way round, and a
// Herdr server started from Orca or Wave hands their variables to every pane. Then
// TERM_PROGRAM, which names the innermost terminal, before the variables that leak inward.
export function detectHost(env: Env): Host {
  if (DESKTOP_ENTRYPOINTS.has(env.CLAUDE_CODE_ENTRYPOINT ?? '')) return 'claude-desktop'
  if (env.HERDR_ENV === '1') return 'herdr'
  const term = TERM_PROGRAMS[env.TERM_PROGRAM ?? '']
  if (term) return term
  if (env.ORCA_WORKTREE_ID) return 'orca'
  if (Object.keys(env).some((k) => k.startsWith('WAVETERM_'))) return 'wave'
  return 'terminal'
}

const AGENT_CALLS: Partial<Record<Viewer, string>> = { 'claude-desktop': 'preview_start', chrome: 'navigate' }
const SYSTEM_OPEN = process.platform === 'darwin' ? 'open' : 'xdg-open'

// Whether a viewer can be used in this session. Orca and Wave only from inside them
// (Orca's browser belongs to a worktree, Wave's blocks to a tab); Claude desktop only
// in its own sessions; Chrome is the agent's to know, so it counts when preferred, and
// so does Playwright: its CLI when on PATH, else its MCP.
function usable(viewer: Viewer, host: Host, has: (cmd: string) => boolean): boolean {
  switch (viewer) {
    case 'orca':
      return host === 'orca' && has('orca')
    case 'wave':
      return host === 'wave' && has('wsh')
    case 'claude-desktop':
      return host === 'claude-desktop'
    case 'chrome':
    case 'playwright':
      return true
    case 'browser':
      return has(SYSTEM_OPEN)
    default:
      return false
  }
}

const HOST_VIEWER: Partial<Record<Host, Viewer>> = { orca: 'orca', wave: 'wave', 'claude-desktop': 'claude-desktop' }

export function chooseViewer(options: { env: Env; preferences: Viewer[]; has: (cmd: string) => boolean }): Choice {
  const host = detectHost(options.env)
  const pick = (viewer: Viewer, reason: string): Choice => {
    const agentCall = viewer === 'playwright' && !options.has('playwright') ? 'browser_navigate' : AGENT_CALLS[viewer]
    return { host, viewer, reason, ...(agentCall ? { agentCall } : {}) }
  }
  for (const viewer of options.preferences) {
    if (usable(viewer, host, options.has)) return pick(viewer, `first available preference (workspace.viewers)`)
  }
  const own = HOST_VIEWER[host]
  if (own && usable(own, host, options.has)) return pick(own, `the session runs in ${host}`)
  if (usable('browser', host, options.has)) return pick('browser', 'no preference available; system browser')
  return pick('none', 'no viewer available: check with curl')
}

export function commandExists(cmd: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v "${cmd}"`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Opens `url` with a shell-reachable viewer; returns false when the choice is an agent
// call (or none), which the caller reports instead.
export function openWith(choice: Choice, url: string, worktree: string): boolean {
  const detached = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
  if (choice.agentCall) return false
  switch (choice.viewer) {
    case 'orca': {
      const orca = (args: string[]) =>
        execFileSync('orca', [...args, '--url', url, '--worktree', `path:${worktree}`, '--json'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      // goto needs a browser tab in the worktree (browser_no_tab otherwise): open one there.
      try {
        orca(['goto'])
      } catch (error) {
        const { stdout, stderr } = error as { stdout?: string; stderr?: string }
        if (!`${stdout}${stderr}`.includes('"browser_no_tab"')) throw error
        orca(['tab', 'create'])
      }
      return true
    }
    case 'wave':
      execFileSync('wsh', ['web', 'open', url], { stdio: 'ignore' })
      return true
    case 'playwright':
      detached('playwright', ['open', url])
      return true
    case 'browser':
      detached(SYSTEM_OPEN, [url])
      return true
    default:
      return false
  }
}
