// Shared by the upstream tests (upstream-*.test.ts): lntt's adapters against the real
// Orca, Herdr, claude and opencode, which the Upstream tools workflow installs on a
// throwaway runner (.github/workflows/upstream.yml, docs/process/ci.md). Each file runs
// only when UPSTREAM_SMOKE names its tool.

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Runner } from '../src/worktree.ts'

export type Tool = 'orca' | 'herdr' | 'claude' | 'opencode'

// UPSTREAM_SMOKE is a comma-separated list of tools.
export function upstream(tool: Tool): boolean {
  return (process.env.UPSTREAM_SMOKE ?? '')
    .split(',')
    .map((name) => name.trim())
    .includes(tool)
}

// Records every call and answers from a table keyed by the command and its first
// arguments, so every path of an adapter runs without the tool's runtime. The longest
// key a call starts with wins: `orca worktree create --help` over `orca worktree create`.
export function recorder(answers: Record<string, string> = {}) {
  const calls: string[][] = []
  const runner: Runner = {
    run(command, args) {
      calls.push([command, ...args])
      const line = [command, ...args].join(' ')
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k))
        .sort((a, b) => b.length - a.length)[0]
      return key ? (answers[key] as string) : ''
    },
    shell() {},
    sleep() {},
  }
  return { calls, runner }
}

const FLAG = /^--?[A-Za-z][\w-]*$/

// The flags of an argument list: `--name` and `-n`, never their values.
export function flagsOf(args: string[]): string[] {
  return args.filter((arg) => FLAG.test(arg))
}

// The flags a tool's help defines, long and short: only from the lines that start with
// a flag at an option's indent (a description's wrapped lines sit deeper), up to the gap
// before the description, so a removed flag that another option's description still
// mentions counts as missing.
export function helpFlags(help: string): Set<string> {
  const flags = new Set<string>()
  for (const line of help.split('\n')) {
    const indent = line.length - line.trimStart().length
    const spec = line.trim().split(/\s{2,}/)[0] ?? ''
    if (indent > 8 || !spec.startsWith('-')) continue
    for (const flag of spec.match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? []) flags.add(flag)
  }
  return flags
}

// Each flag lntt passes that the tool's own description lacks, as one line per
// subcommand: what a failure names.
export function missingFlags(
  tool: string,
  used: Map<string, Set<string>>,
  known: (subcommand: string) => Set<string>,
): string[] {
  const lines: string[] = []
  for (const [subcommand, flags] of used) {
    const have = known(subcommand)
    // A description read as no flag at all is a format the parser no longer follows,
    // not every flag removed.
    if (flags.size && !have.size) {
      lines.push(`${tool} ${subcommand}: its description lists no flag; the format may have changed`)
      continue
    }
    const missing = [...flags].filter((flag) => !have.has(flag))
    if (missing.length) lines.push(`${tool} ${subcommand}: ${missing.join(', ')} not in its description`)
  }
  return lines
}

// A tool's own arguments: what follows `--` is the agent's (agentArgs), checked against
// the agent's help.
export function ownArgs(args: string[]): string[] {
  return args.includes('--') ? args.slice(0, args.indexOf('--')) : args
}

// Adds the flags of one call to its subcommand's set.
export function collect(used: Map<string, Set<string>>, subcommand: string, flags: string[]): void {
  const set = used.get(subcommand) ?? new Set<string>()
  for (const flag of flags) set.add(flag)
  used.set(subcommand, set)
}

// stdout of a call to a real tool; stderr goes with the error when it fails.
export function tool(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

// Polls until `probe` returns a value, or fails naming what it waited for.
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | null | false,
  ms = 60_000,
  // What the failure shows of the state it timed out in: a screen, a log.
  shown: () => string = () => '',
): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    let last: unknown
    try {
      const value = probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    if (Date.now() > until) {
      let state = ''
      try {
        state = shown()
      } catch {}
      throw new Error(
        `timed out after ${ms} ms waiting for ${what}${last ? `: ${last}` : ''}${state ? `\n${state}` : ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

// A HOME of its own, with a git identity, and a repository with one commit on main:
// what a tool's runtime writes stays out of the machine's.
export function throwawayHome(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), 'lntt-upstream-'))
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = lntt\n\temail = lntt@example.com\n[init]\n\tdefaultBranch = main\n',
  )
  const repo = join(home, 'repo')
  const env = { ...process.env, HOME: home }
  tool('git', ['init', '-q', repo], { env })
  tool('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env })
  return { home, repo }
}

// Points this process, and every tool it starts, at `home`: HOME, and none of the
// variables that lead the orca and herdr CLIs to a person's running instance (an Orca or
// Herdr terminal sets them). Returns what puts the environment back.
export function useHome(home: string): () => void {
  const saved = { ...process.env }
  for (const name of Object.keys(process.env)) {
    if (/^(ORCA_|HERDR_|XDG_)/.test(name)) delete process.env[name]
  }
  process.env.HOME = home
  return () => {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

// A long-running server in the background, its output in a log file the test reads.
export function background(command: string, args: string[], log: string): () => void {
  const fd = openSync(log, 'a')
  const child = spawn(command, args, { stdio: ['ignore', fd, fd], detached: true })
  closeSync(fd)
  // A server that cannot start (not on the PATH) says so in the log the test waits on.
  child.on('error', (error) => appendFileSync(log, `${command} did not start: ${error.message}\n`))
  child.unref()
  return () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}

// The brief on the screen of the agent a shell command started, once its interface has
// replaced the shell: the command line is no longer there.
export function drawn(screen: string, brief: string): boolean {
  return screen.includes(brief) && !screen.includes('OPENCODE_CONFIG_CONTENT')
}

export const readLog = (log: string): string => {
  try {
    return readFileSync(log, 'utf8')
  } catch {
    return ''
  }
}
