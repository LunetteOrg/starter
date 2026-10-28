// The command hooks lntt sync writes into .claude/settings.json
// (docs/adr/agent-layer.md#where-hooks-live): the settings hold a thin line, the logic is
// here. `format` formats the file just written; `typecheck` runs after the turn and wakes
// the agent only on a failure it has not seen.
//
// Which commands run, in order: `local.hooks.<name>` of .agents/config (one command or a
// list, for a project with more than one toolchain); else the package.json script of that
// name, run with pnpm, or npm in a project with only a package-lock.json, as the install
// hook installs; else none, and the hook does nothing.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findConfig, loadConfig, NoConfigError } from './index.ts'

export type HookName = 'format' | 'typecheck'

// The project root: the configuration's, or the directory the hook runs in when there is
// none. Any other error of finding it is the caller's to report.
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

// The time a hook's commands have, all of them together, below the hook's own timeout in
// the settings (claude-settings.ts), so Claude Code never kills the hook with a command
// still running.
export const LIMIT_MS: Record<HookName, number> = { format: 60_000, typecheck: 600_000 }
// A typecheck's output can be long; past this it is cut.
const OUTPUT_LIMIT = 64 * 1024 * 1024

// A shell command in a process group of its own: past `ms` the whole group is stopped,
// the processes it started included (`pnpm run` starting `tsc`).
export function runLimited(
  command: string,
  cwd: string,
  ms: number,
): Promise<{ ok: boolean; output: string; stopped: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: string[] = []
    const err: string[] = []
    let size = 0
    const keep = (into: string[]) => (chunk: Buffer) => {
      if (size >= OUTPUT_LIMIT) return
      const text = chunk.toString('utf8')
      size += text.length
      into.push(text)
    }
    child.stdout.on('data', keep(out))
    child.stderr.on('data', keep(err))
    let stopped = false
    const group = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal)
      } catch {}
    }
    let kill: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      stopped = true
      group('SIGTERM')
      kill = setTimeout(() => group('SIGKILL'), 1000)
    }, ms)
    const end = (ok: boolean, extra = '') => {
      clearTimeout(timer)
      if (kill) clearTimeout(kill)
      const cut = size >= OUTPUT_LIMIT ? '(lntt hook: output cut at 64 MB)\n' : ''
      resolve({ ok, output: `${out.join('')}${err.join('')}${cut}${extra}`, stopped })
    }
    child.on('error', (e) => end(false, `${e.message}\n`))
    child.on('close', (code) => {
      // A process of the group may still hold nothing open but run: stop it with the rest.
      if (stopped) group('SIGKILL')
      end(code === 0 && !stopped)
    })
  })
}

// The commands in order, within one limit for all of them: the outcome of each.
async function runAll(commands: string[], root: string, ms: number, suffix = '') {
  const deadline = Date.now() + ms
  const secs = `${Math.round(ms / 100) / 10}`
  const results: { command: string; ok: boolean; output: string }[] = []
  for (const command of commands) {
    const left = deadline - Date.now()
    if (left <= 0) {
      results.push({ command, ok: false, output: `(not run: the limit of ${secs} s was reached)\n` })
      continue
    }
    const r = await runLimited(`${command}${suffix}`, root, left)
    const note = r.stopped ? `(lntt hook: stopped at the limit of ${secs} s for the hook's commands)\n` : ''
    results.push({ command, ok: r.ok, output: `${r.output}${note}` })
  }
  return results
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

// A state lntt cannot read or write: a defect of the hook, not a failure of the project.
export class StateError extends Error {}

// The text when it differs from what the file holds (which it then holds), null when it
// is the same; no text clears the file.
function once(file: string, text: string | null): string | null {
  try {
    if (text === null) {
      rmSync(file, { force: true })
      return null
    }
    const seen = normalise(text)
    if (existsSync(file) && readFileSync(file, 'utf8') === seen) return null
    writeFileSync(file, seen)
    return text
  } catch (e) {
    throw new StateError(`${file}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const failure = (e: unknown) => `lntt: ${e instanceof Error ? e.message : String(e)}`

// Each command gets the path as its last argument. One that fails (a file type it does
// not handle, a command that takes no path) is skipped: the commit's own check is the gate.
// A configuration lntt cannot read is the notice returned, once until it changes.
export async function runFormat(cwd: string, input: string, ms = LIMIT_MS.format): Promise<string | null> {
  const path = writtenPath(input)
  if (path === null) return null
  let root = cwd
  let commands: string[]
  try {
    root = projectRoot(cwd)
    commands = hookCommands(root, 'format')
  } catch (e) {
    return once(stateFile(root, 'format-notice'), `lntt hook format is off until this is fixed: ${failure(e)}`)
  }
  once(stateFile(root, 'format-notice'), null)
  await runAll(commands, root, ms, ` ${quote(path)}`)
  return null
}

// Every command runs, within the limit. The output of the failing ones, or a
// configuration lntt cannot read, when it is not what the last run reported; null when
// they pass (what was kept is cleared) or the failure is the same. A state lntt cannot
// keep throws StateError.
export async function runTypecheck(cwd: string, ms = LIMIT_MS.typecheck): Promise<string | null> {
  let root = cwd
  let failed: string[]
  try {
    root = projectRoot(cwd)
    const results = await runAll(hookCommands(root, 'typecheck'), root, ms)
    failed = results.filter((r) => !r.ok).map((r) => `$ ${r.command}\n${r.output}`)
  } catch (e) {
    failed = [failure(e)]
  }
  return once(stateFile(root, 'typecheck-failure'), failed.length === 0 ? null : failed.join('\n'))
}
