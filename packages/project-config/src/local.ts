// The apps a project runs locally, resolved for the current checkout. The main checkout
// uses each app's base port; every linked worktree gets a stable slot and runs on
// base + 10 × slot, so several worktrees can run the same app at once. Slots live in
// the git common dir, shared by every worktree, and a removed worktree frees its own.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function slotFor(cwd: string): number {
  const gitDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir')
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (gitDir === common) return 0
  const here = git(cwd, 'rev-parse', '--show-toplevel')
  const live = new Set(
    git(cwd, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length)),
  )
  const file = join(common, 'lunette', 'ports.json')
  const known: Record<string, number> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const slots = Object.fromEntries(Object.entries(known).filter(([path]) => live.has(path)))
  if (slots[here] === undefined) {
    const taken = new Set(Object.values(slots))
    let slot = 1
    while (taken.has(slot)) slot++
    slots[here] = slot
  }
  mkdirSync(join(common, 'lunette'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(slots, null, 2)}\n`)
  return slots[here]
}

const fill = (text: string, port: number): string => text.replaceAll('{port}', String(port))

export function localApp(cwd: string, name: string): LocalApp {
  const apps = ((loadConfig(cwd).data.local as { apps?: Record<string, App> } | undefined)?.apps ?? {}) as Record<
    string,
    App
  >
  const app = apps[name]
  if (!app) {
    const names = Object.keys(apps)
    throw new ConfigError(`no app ${name} in local.apps (${names.length > 0 ? names.join(', ') : 'none configured'})`)
  }
  const port = app.port + STEP * slotFor(cwd)
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
