// Where to show a page to the operator, decided without asking the agent to reason
// about it: detect the app the session runs in, then take the first of the operator's
// preferred viewers (workspace.viewers) that is available here. Viewers reachable from
// a shell are opened directly; the others are tool calls only the agent can make, so
// the script names the call instead.
//
// Plain logic: src/local/machine.ts finds which commands are on the PATH and opens the page.

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

// What opens a URL in the system browser on `platform` (Node's process.platform).
export const systemOpen = (platform: string): string => (platform === 'darwin' ? 'open' : 'xdg-open')

// Every command whose presence on the PATH the choice may read.
export const viewerCommands = (platform: string): string[] => ['orca', 'wsh', 'playwright', systemOpen(platform)]

// Whether a viewer can be used in this session. Orca and Wave only from inside them
// (Orca's browser belongs to a worktree, Wave's blocks to a tab); Claude desktop only
// in its own sessions; Chrome is the agent's to know, so it counts when preferred, and
// so does Playwright: its CLI when on PATH, else its MCP.
function usable(viewer: Viewer, host: Host, has: (cmd: string) => boolean, platform: string): boolean {
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
      return has(systemOpen(platform))
    default:
      return false
  }
}

const HOST_VIEWER: Partial<Record<Host, Viewer>> = { orca: 'orca', wave: 'wave', 'claude-desktop': 'claude-desktop' }

export function chooseViewer(options: {
  env: Env
  preferences: Viewer[]
  has: (cmd: string) => boolean
  platform: string
}): Choice {
  const host = detectHost(options.env)
  const can = (viewer: Viewer) => usable(viewer, host, options.has, options.platform)
  const pick = (viewer: Viewer, reason: string): Choice => {
    const agentCall = viewer === 'playwright' && !options.has('playwright') ? 'browser_navigate' : AGENT_CALLS[viewer]
    return { host, viewer, reason, ...(agentCall ? { agentCall } : {}) }
  }
  for (const viewer of options.preferences) {
    if (can(viewer)) return pick(viewer, `first available preference (workspace.viewers)`)
  }
  const own = HOST_VIEWER[host]
  if (own && can(own)) return pick(own, `the session runs in ${host}`)
  if (can('browser')) return pick('browser', 'no preference available; system browser')
  return pick('none', 'no viewer available: check with curl')
}

// How a page is opened with a shell-reachable viewer: Orca's goto in the worktree, and a tab
// created on the page when the worktree has none (goto fails with browser_no_tab); a command run to
// its end (Wave); a command started detached, which outlives lntt (Playwright, the system browser).
// Null when the choice is an agent call (or none), which the caller reports instead.
export type Opening =
  | { kind: 'orca'; goto: string[]; tab: string[] }
  | { kind: 'run'; command: string; args: string[] }
  | { kind: 'detached'; command: string; args: string[] }

export function openingOf(choice: Choice, url: string, worktree: string, platform: string): Opening | null {
  if (choice.agentCall) return null
  const orca = (args: string[]) => [...args, '--url', url, '--worktree', `path:${worktree}`, '--json']
  switch (choice.viewer) {
    case 'orca':
      return { kind: 'orca', goto: orca(['goto']), tab: orca(['tab', 'create']) }
    case 'wave':
      return { kind: 'run', command: 'wsh', args: ['web', 'open', url] }
    case 'playwright':
      return { kind: 'detached', command: 'playwright', args: ['open', url] }
    case 'browser':
      return { kind: 'detached', command: systemOpen(platform), args: [url] }
    default:
      return null
  }
}

// What a viewer that cannot be opened from a shell prints: the agent's call, the page.
export function agentAction(choice: Choice, url: string): Record<string, string> {
  return { viewer: choice.viewer, ...(choice.agentCall ? { call: choice.agentCall } : {}), url }
}

// Orca's goto said the worktree has no browser tab.
export const noTab = (output: string): boolean => output.includes('"browser_no_tab"')
