// The apps a project runs locally, resolved for the current checkout. The main checkout
// uses each app's base port; every linked worktree gets a stable slot and runs on
// base + 10 × slot, so several worktrees can run the same app at once. Slots live in
// the git common dir, shared by every worktree, and a removed worktree frees its own.
//
// Plain logic: src/local/machine.ts reads git and the slots' file and writes the file back.

import { ConfigError } from './files.ts'

interface Command {
  run: string
  description?: string
}

interface App {
  description?: string
  port: number
  url: string
  readyPath?: string
  commands: Record<string, Command>
  env?: Record<string, string>
  signIn?: { test?: string; doc?: string }
  users?: Record<string, { login: string; role?: string }>
}

export interface LocalApp extends Omit<App, 'readyPath'> {
  name: string
  readyPath: string
}

const STEP = 10

// The slots' file, in the git common directory.
export const PORTS = ['lunette', 'ports.json'] as const

// The apps of local.apps, by name.
export function appsOf(data: Record<string, unknown>): Record<string, App> {
  return ((data.local as { apps?: Record<string, App> } | undefined)?.apps ?? {}) as Record<string, App>
}

// The app named, or a ConfigError naming those there are.
export function appOf(data: Record<string, unknown>, name: string): App {
  const apps = appsOf(data)
  const app = apps[name]
  if (app) return app
  const names = Object.keys(apps)
  throw new ConfigError(`no app ${name} in local.apps (${names.length > 0 ? names.join(', ') : 'none configured'})`)
}

// The worktrees `git worktree list --porcelain` names.
export function liveWorktrees(porcelain: string): Set<string> {
  return new Set(
    porcelain
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length)),
  )
}

// The slot of the worktree at `here`, from the slots the file kept: those of worktrees gone are
// freed, and a worktree with none takes the lowest free one from 1. `slots` is what the file
// holds next.
export function slotIn(
  known: Record<string, number>,
  live: Set<string>,
  here: string,
): { slot: number; slots: Record<string, number> } {
  const slots = Object.fromEntries(Object.entries(known).filter(([path]) => live.has(path)))
  if (slots[here] === undefined) {
    const taken = new Set(Object.values(slots))
    let slot = 1
    while (taken.has(slot)) slot++
    slots[here] = slot
  }
  return { slot: slots[here] as number, slots }
}

const fill = (text: string, port: number): string => text.replaceAll('{port}', String(port))

// The app on the port of `slot`, `{port}` filled in everywhere.
export function resolvedApp(name: string, app: App, slot: number): LocalApp {
  const port = app.port + STEP * slot
  const { readyPath = '/', ...rest } = app
  return {
    name,
    ...rest,
    port,
    url: fill(app.url, port),
    readyPath,
    commands: Object.fromEntries(
      Object.entries(app.commands).map(([key, command]) => [key, { ...command, run: fill(command.run, port) }]),
    ),
    ...(app.env ? { env: Object.fromEntries(Object.entries(app.env).map(([k, v]) => [k, fill(v, port)])) } : {}),
  }
}
