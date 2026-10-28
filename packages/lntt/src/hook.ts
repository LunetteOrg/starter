// The command hooks lntt sync writes into .claude/settings.json
// (docs/adr/agent-layer.md#where-hooks-live): the settings hold a thin line, the logic is
// here. `format` formats the file just written; `typecheck` runs after the turn and wakes
// the agent only on a failure it has not seen.
//
// Which commands run, in order: `local.hooks.<name>` of .agents/config (one command or a
// list, for a project with more than one toolchain); else the package.json script of that
// name, run with pnpm, or npm in a project with only a package-lock.json, as the install
// hook installs; else none, and the hook does nothing.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findConfig, loadConfig, NoConfigError } from './index.ts'

export type HookName = 'format' | 'typecheck'

// The project root: the configuration's, or the directory the hook runs in when none is
// found (reading it then says what is wrong).
function projectRoot(cwd: string): string {
  try {
    return dirname(dirname(findConfig(cwd).path))
  } catch {
    return cwd
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

// Each command is stopped after its limit, below the hook's own timeout in the settings
// (claude-settings.ts), so Claude Code never kills the hook with a command still running.
// A typecheck's output can be long.
export const COMMAND_LIMIT_S: Record<HookName, number> = { format: 30, typecheck: 300 }
function sh(command: string, cwd: string, name: HookName): { ok: boolean; output: string } {
  const r = spawnSync('/bin/sh', ['-c', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: COMMAND_LIMIT_S[name] * 1000,
  })
  const stopped = r.error ? `(lntt hook stopped it: ${r.error.message})\n` : ''
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}${stopped}` }
}

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

// The terminal's colour sequences (ESC [ … m).
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

// Two outputs of one failure differ in colours, timings (`1.2s`, `340ms`) and trailing
// spaces.
export function normalise(output: string): string {
  return output
    .replace(COLOUR, '')
    .replace(/(?<![\w.])\d+(\.\d+)?m?s(?!\.?\w)/g, 's')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

// What a hook last reported, in the worktree's own git directory; outside git, in the
// temporary directory, under a name of the project's path.
function stateFile(root: string, name: string): string {
  try {
    const dir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return join(dir, `lntt-${name}`)
  } catch {
    const key = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return join(tmpdir(), `lntt-${name}-${key}`)
  }
}

// The text when it differs from what the file holds (which it then holds), null when it
// is the same; no text clears the file.
function once(file: string, text: string | null): string | null {
  if (text === null) {
    rmSync(file, { force: true })
    return null
  }
  const seen = normalise(text)
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === seen) return null
    writeFileSync(file, seen)
  } catch {
    // A state lntt cannot keep: the text is said every time rather than never.
  }
  return text
}

const failure = (e: unknown) => `lntt: ${e instanceof Error ? e.message : String(e)}`

// Each command gets the path as its last argument. One that fails (a file type it does
// not handle, a command that takes no path) is skipped: the commit's own check is the gate.
// A configuration lntt cannot read is the notice returned, once until it changes.
export function runFormat(cwd: string, input: string): string | null {
  const path = writtenPath(input)
  if (path === null) return null
  const root = projectRoot(cwd)
  let commands: string[]
  try {
    commands = hookCommands(root, 'format')
  } catch (e) {
    return once(stateFile(root, 'format-notice'), `lntt hook format is off until this is fixed: ${failure(e)}`)
  }
  once(stateFile(root, 'format-notice'), null)
  for (const command of commands) sh(`${command} ${quote(path)}`, root, 'format')
  return null
}

// Every command runs. The output of the failing ones, or a configuration lntt cannot
// read, when it is not what the last run reported; null when they pass (what was kept is
// cleared) or the failure is the same.
export function runTypecheck(cwd: string): string | null {
  const root = projectRoot(cwd)
  let failed: string[]
  try {
    failed = hookCommands(root, 'typecheck').flatMap((command) => {
      const r = sh(command, root, 'typecheck')
      return r.ok ? [] : [`$ ${command}\n${r.output}`]
    })
  } catch (e) {
    failed = [failure(e)]
  }
  return once(stateFile(root, 'typecheck-failure'), failed.length === 0 ? null : failed.join('\n'))
}
