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

export function detectHost(env: Env): Host {
  if (env.TERM_PROGRAM === 'Orca' || env.ORCA_WORKTREE_ID) return 'orca'
  if (env.TERM_PROGRAM === 'waveterm' || Object.keys(env).some((k) => k.startsWith('WAVETERM_'))) return 'wave'
  if (env.HERDR_ENV === '1') return 'herdr'
  if (/desktop/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? '')) return 'claude-desktop'
  return 'terminal'
}

const AGENT_CALLS: Partial<Record<Viewer, string>> = { 'claude-desktop': 'preview_start', chrome: 'navigate' }
const SYSTEM_OPEN = process.platform === 'darwin' ? 'open' : 'xdg-open'

// Whether a viewer can be used in this session. Orca and Wave only from inside them
// (Orca's browser belongs to a worktree, Wave's blocks to a tab); Claude desktop only
// in its own sessions; Chrome is the agent's to know, so it counts when preferred.
function usable(viewer: Viewer, host: Host, has: (cmd: string) => boolean): boolean {
  switch (viewer) {
    case 'orca':
      return host === 'orca' && has('orca')
    case 'wave':
      return host === 'wave' && has('wsh')
    case 'claude-desktop':
      return host === 'claude-desktop'
    case 'chrome':
      return true
    case 'playwright':
      return has('playwright')
    case 'browser':
      return has(SYSTEM_OPEN)
    default:
      return false
  }
}

const HOST_VIEWER: Partial<Record<Host, Viewer>> = { orca: 'orca', wave: 'wave', 'claude-desktop': 'claude-desktop' }

export function chooseViewer(options: { env: Env; preferences: Viewer[]; has: (cmd: string) => boolean }): Choice {
  const host = detectHost(options.env)
  const pick = (viewer: Viewer, reason: string): Choice => ({
    host,
    viewer,
    reason,
    ...(AGENT_CALLS[viewer] ? { agentCall: AGENT_CALLS[viewer] } : {}),
  })
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
  switch (choice.viewer) {
    case 'orca':
      execFileSync('orca', ['goto', '--url', url, '--worktree', `path:${worktree}`], { stdio: 'ignore' })
      return true
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
