// How an agent drives a browser on the worktree's app, so it never has to work out
// which browser it has or how to call it. The driver is chosen like the viewer: the
// first of the operator's preferred browsers (workspace.browsers) usable in this
// session, else the host's own, else Playwright through npx. Each driver answers the
// same operations, as shell commands or as tool calls only the agent can make; this
// module describes them and runs none.

import { join } from 'node:path'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
import type { LocalApp } from './local.ts'
import { detectHost, type Host } from './viewer.ts'

export type Driver = 'orca' | 'claude-desktop' | 'chrome' | 'playwright'

export const BROWSER_OPERATIONS = [
  'open',
  'read',
  'click',
  'type',
  'screenshot',
  'console',
  'requests',
  'close',
] as const
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number]

export interface DriverChoice {
  host: Host
  driver: Driver
  reason: string
}

export interface ToolCall {
  tool: string
  input: Record<string, unknown>
}

export type Step = ({ command: string } | { call: ToolCall } | { lacks: string }) & { note?: string }

export interface BrowserPlan extends DriverChoice {
  url: string
  app: string
  kind: 'shell' | 'agent'
  setup?: Step[]
  operations: Record<BrowserOperation, Step>
}

type Env = Record<string, string | undefined>

// Orca's browser belongs to a worktree, so only from inside Orca; Claude desktop only in
// its own sessions; Chrome is the agent's to know (no variable tells a shell it has the
// tools); Playwright always, through npx. Wave and Herdr have no browser an agent drives.
function usable(driver: Driver, host: Host, has: (cmd: string) => boolean): boolean {
  switch (driver) {
    case 'orca':
      return host === 'orca' && has('orca')
    case 'claude-desktop':
      return host === 'claude-desktop'
    case 'chrome':
    case 'playwright':
      return true
  }
}

const HOST_DRIVER: Partial<Record<Host, Driver>> = { orca: 'orca', 'claude-desktop': 'claude-desktop' }

export function chooseDriver(options: {
  env: Env
  preferences: Driver[]
  has: (cmd: string) => boolean
}): DriverChoice {
  const host = detectHost(options.env)
  for (const driver of options.preferences) {
    if (!usable(driver, host, options.has)) continue
    const assumed = driver === 'chrome' ? '; assumed, no shell can tell whether this session has its tools' : ''
    return { host, driver, reason: `first usable preference (workspace.browsers)${assumed}` }
  }
  const own = HOST_DRIVER[host]
  if (own && usable(own, host, options.has)) return { host, driver: own, reason: `the session runs in ${host}` }
  const why = own ? `${own} is not on PATH` : `${host} has no browser an agent can drive`
  return { host, driver: 'playwright', reason: `${why}; playwright through npx` }
}

// The app to drive: the one named, or the only one local.apps has.
export function browserApp(cwd: string, name?: string): string {
  if (name) return name
  const names = Object.keys(
    ((loadConfig(cwd).data.local as { apps?: Record<string, unknown> } | undefined)?.apps ?? {}) as object,
  )
  if (names.length === 1) return names[0] as string
  throw new ConfigError(
    `name the app: lntt browser <app> (local.apps: ${names.length > 0 ? names.join(', ') : 'none configured'})`,
  )
}

const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`)

function orca(url: string, worktree: string): Pick<BrowserPlan, 'setup' | 'operations'> {
  const o = (args: string) => ({ command: `orca ${args} --worktree ${quote(`path:${worktree}`)} --json` })
  return {
    setup: [
      {
        ...o('tab create --url about:blank'),
        note: 'once per session: the worktree needs a tab, goto fails with browser_no_tab',
      },
      { ...o('capture start'), note: 'before open, so requests from the page load are recorded' },
    ],
    operations: {
      open: o(`goto --url ${quote(url)}`),
      read: o('snapshot'),
      click: { ...o('click --element @<ref>'), note: 'a browser_error about keyboard focus: run it again' },
      type: o("fill --element @<ref> --value '<text>'"),
      screenshot: { ...o(`exec --command 'screenshot "<file>"'`), note: '<file> is an absolute path' },
      console: o('console --limit 50'),
      requests: { ...o('network --limit 100'), note: 'no failure filter: keep status >= 400 or no status' },
      close: {
        ...o('tab close --page <browserPageId>'),
        note: `browserPageId from tab create; then ${o('capture stop').command}`,
      },
    },
  }
}

const PLAYWRIGHT_CLI = '@playwright/cli@0.1.22'

// playwright-cli writes snapshots and logs under .playwright-cli/ in its cwd unless
// PLAYWRIGHT_MCP_OUTPUT_DIR names another folder; the session name keeps parallel
// worktrees on separate browsers.
function playwright(app: LocalApp, tmp: string): Pick<BrowserPlan, 'setup' | 'operations'> {
  const session = `lntt-${app.name.replaceAll(/[^\w.-]+/g, '-')}-${app.port}`
  const pw = (args: string) => ({
    command: `PLAYWRIGHT_MCP_OUTPUT_DIR=${quote(join(tmp, session))} npx -y ${PLAYWRIGHT_CLI} -s=${session} ${args}`,
  })
  const signIn = app.signIn?.test
    ? `; to sign in, run "${pw('state-load <file>').command}" next, with <file> a storage state saved by ${app.signIn.test}`
    : ''
  return {
    setup: [{ ...pw('open'), note: `starts a headless browser for this worktree${signIn}` }],
    operations: {
      open: pw(`goto ${quote(app.url)}`),
      read: pw('snapshot'),
      click: pw('click <ref>'),
      type: pw("fill <ref> '<text>'"),
      screenshot: pw("screenshot --filename='<file>'"),
      console: pw('console error'),
      requests: {
        ...pw('requests --static'),
        note: 'lists every request with its status: read the 4xx and 5xx',
      },
      close: pw('close'),
    },
  }
}

const CHROME = 'mcp__claude-in-chrome__'
const CHROME_TOOLS = [
  'tabs_context_mcp',
  'navigate',
  'read_page',
  'computer',
  'form_input',
  'read_console_messages',
  'read_network_requests',
  'tabs_close_mcp',
]

function chrome(url: string): Pick<BrowserPlan, 'setup' | 'operations'> {
  const c = (tool: string, input: Record<string, unknown> = {}) => ({
    call: { tool: `${CHROME}${tool}`, input: { ...input, tabId: '<tabId>' } },
  })
  return {
    setup: [
      {
        call: {
          tool: 'ToolSearch',
          input: { query: `select:${CHROME_TOOLS.map((t) => CHROME + t).join(',')}`, max_results: CHROME_TOOLS.length },
        },
        note: 'loads every tool below in one call',
      },
      {
        call: { tool: `${CHROME}tabs_context_mcp`, input: { createIfEmpty: true } },
        note: '<tabId> in every call below is the number in its result',
      },
      {
        ...c('read_network_requests'),
        note: 'before open: requests are recorded only from the first call',
      },
    ],
    operations: {
      open: c('navigate', { url }),
      read: c('read_page', { filter: 'all' }),
      click: c('computer', { action: 'left_click', ref: '<ref>' }),
      type: c('form_input', { ref: '<ref>', value: '<text>' }),
      screenshot: {
        ...c('computer', { action: 'screenshot', save_to_disk: true }),
        note: 'the tool picks the path and returns it',
      },
      console: c('read_console_messages', { onlyErrors: true }),
      requests: { ...c('read_network_requests'), note: 'no failure filter: read the 4xx and 5xx' },
      close: c('tabs_close_mcp'),
    },
  }
}

// From the built-in-browser skill, not tried here: tabId defaults to the active tab. The
// skill says the pane may not reach a localhost server the agent started. The console
// and network readers are named after Chrome's: the skill does not name them.
function claudeDesktop(url: string): Pick<BrowserPlan, 'setup' | 'operations'> {
  const c = (tool: string, input: Record<string, unknown> = {}) => ({
    call: { tool: `mcp__Claude_Browser__${tool}`, input },
  })
  return {
    setup: [
      {
        call: { tool: 'ToolSearch', input: { query: 'mcp__Claude_Browser__', max_results: 64 } },
        note: 'loads the tools; untried: the names below follow the built-in-browser skill and Chrome',
      },
    ],
    operations: {
      open: c('preview_start', { url }),
      read: c('read_page'),
      click: c('computer', { action: 'left_click', ref: '<ref>' }),
      type: c('form_input', { ref: '<ref>', value: '<text>' }),
      screenshot: c('computer', { action: 'screenshot' }),
      console: c('read_console_messages', { onlyErrors: true }),
      requests: { ...c('read_network_requests'), note: 'no failure filter: read the 4xx and 5xx' },
      close: { lacks: 'the pane keeps its tabs' },
    },
  }
}

export function browserPlan(options: {
  app: LocalApp
  choice: DriverChoice
  worktree: string
  tmp: string
}): BrowserPlan {
  const { app, choice } = options
  const steps =
    choice.driver === 'orca'
      ? orca(app.url, options.worktree)
      : choice.driver === 'playwright'
        ? playwright(app, options.tmp)
        : choice.driver === 'chrome'
          ? chrome(app.url)
          : claudeDesktop(app.url)
  const kind = choice.driver === 'orca' || choice.driver === 'playwright' ? 'shell' : 'agent'
  return { ...choice, url: app.url, app: app.name, kind, ...steps }
}

function line(name: string, step: Step): string[] {
  const what =
    'command' in step
      ? step.command
      : 'call' in step
        ? `${step.call.tool} ${JSON.stringify(step.call.input)}`
        : `(cannot: ${step.lacks})`
  return [`${name.padEnd(12)}${what}`, ...(step.note ? [`${' '.repeat(12)}# ${step.note}`] : [])]
}

// The plan as a document an agent follows with no other instruction.
export function formatPlan(plan: BrowserPlan): string {
  const how =
    plan.kind === 'shell'
      ? 'Each line is a shell command: run it from this worktree, copied whole (a prefix kept in a shell variable is not split by zsh).'
      : 'Each line is a tool call only you, the agent, can make (no shell can): the tool and its input as JSON. ' +
        'Load the tools first with the setup call.'
  return [
    `Driver ${plan.driver}, on host ${plan.host} (${plan.reason}), for app ${plan.app} at ${plan.url}`,
    how,
    'Placeholders: <ref> an element ref as read prints it, such as e3 (read again after each click or navigation: refs go stale), ' +
      `<text> the text to type, <file> an absolute path for the screenshot; ${
        plan.kind === 'shell'
          ? `they sit between single quotes, so write a ' in them as '\\''.`
          : 'they are JSON strings.'
      }`,
    'Run setup once, then the operations in any order; close when done.',
    '',
    ...(plan.setup ?? []).flatMap((step, i) => line(i === 0 ? 'setup' : '', step)),
    ...BROWSER_OPERATIONS.flatMap((op) => line(op, plan.operations[op])),
    '',
  ].join('\n')
}
