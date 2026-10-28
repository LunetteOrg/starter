// The command hooks lntt sync writes into .claude/settings.json
// (docs/adr/agent-layer.md#where-hooks-live): the settings hold a thin line, the logic is
// here. `format` formats the file just written; `typecheck` runs after the turn and wakes
// the agent only on a failure it has not seen.
//
// Which commands run, in order: `local.hooks.<name>` of .agents/config (one command or a
// list, for a project with more than one toolchain); else the package.json script of that
// name; else none, and the hook does nothing.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findConfig, loadConfig, NoConfigError } from './index.ts'

export type HookName = 'format' | 'typecheck'

// The project root: the configuration's, or the directory the hook runs in.
function projectRoot(cwd: string): string {
  try {
    return dirname(dirname(findConfig(cwd).path))
  } catch (e) {
    if (e instanceof NoConfigError) return cwd
    throw e
  }
}

function configured(root: string, name: HookName): string[] | undefined {
  if (!existsSync(join(root, '.agents'))) return undefined
  let data: { local?: { hooks?: Partial<Record<HookName, string | string[]>> } }
  try {
    data = loadConfig(root).data as typeof data
  } catch (e) {
    if (e instanceof NoConfigError) return undefined
    throw e
  }
  const value = data.local?.hooks?.[name]
  return value === undefined ? undefined : typeof value === 'string' ? [value] : value
}

function script(root: string, name: HookName): string[] {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return []
  let pkg: { scripts?: Record<string, unknown> }
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (typeof pkg.scripts?.[name] !== 'string') return []
  const npm = existsSync(join(root, 'package-lock.json')) && !existsSync(join(root, 'pnpm-lock.yaml'))
  return [npm ? `npm run ${name} --` : `pnpm run ${name}`]
}

export function hookCommands(cwd: string, name: HookName): string[] {
  const root = projectRoot(cwd)
  return configured(root, name) ?? script(root, name)
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
const sh = (command: string, cwd: string) =>
  spawnSync('/bin/sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// The path of the file the tool wrote, from the hook's input; null when there is none.
function writtenPath(input: string): string | null {
  try {
    const j = JSON.parse(input)
    const path = j?.tool_response?.filePath ?? j?.tool_input?.file_path
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

// Each command gets the path as its last argument. One that fails (a file type it does
// not handle, a command that takes no path) is skipped: the commit's own check is the gate.
export function runFormat(cwd: string, input: string): void {
  const path = writtenPath(input)
  if (path === null) return
  const root = projectRoot(cwd)
  for (const command of hookCommands(root, 'format')) sh(`${command} ${quote(path)}`, root)
}

// The terminal's colour sequences (ESC [ … m).
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

// Two outputs of one failure differ in colours, timings and trailing spaces.
export function normalise(output: string): string {
  return output
    .replace(COLOUR, '')
    .replace(/\b\d+(\.\d+)?\s*(ms|s)\b/g, 's')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

// The last failure seen, in the worktree's own git directory; null outside git.
function failureFile(root: string): string | null {
  try {
    const dir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return join(dir, 'lntt-typecheck-failure')
  } catch {
    return null
  }
}

// Every command runs. The output of the failing ones, when it is not the failure the last
// run reported; null when they pass (the kept failure is cleared) or the failure is the same.
export function runTypecheck(cwd: string): string | null {
  const root = projectRoot(cwd)
  const failed = hookCommands(root, 'typecheck').flatMap((command) => {
    const r = sh(command, root)
    return r.status === 0 ? [] : [`$ ${command}\n${r.stdout}${r.stderr}`]
  })
  const file = failureFile(root)
  if (failed.length === 0) {
    if (file !== null) rmSync(file, { force: true })
    return null
  }
  const output = failed.join('\n')
  const seen = normalise(output)
  if (file !== null) {
    if (existsSync(file) && readFileSync(file, 'utf8') === seen) return null
    writeFileSync(file, seen)
  }
  return output
}
