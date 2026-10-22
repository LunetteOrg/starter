// Shared by the upstream tests (upstream-*.test.ts): lntt's adapters against the real
// Orca, Herdr, claude and opencode, which the Upstream tools workflow installs on a
// throwaway runner (.github/workflows/upstream.yml, docs/process/ci.md). Each file runs
// only when UPSTREAM_SMOKE names its tool.

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
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
// arguments, so every path of an adapter runs without the tool's runtime.
export function recorder(answers: Record<string, string> = {}) {
  const calls: string[][] = []
  const runner: Runner = {
    run(command, args) {
      calls.push([command, ...args])
      const line = [command, ...args].join(' ')
      const key = Object.keys(answers).find((k) => line.startsWith(k))
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

// The flags a tool's help names, long and short.
export function helpFlags(help: string): Set<string> {
  return new Set(help.match(/(?<![\w-])--?[A-Za-z][\w-]*/g) ?? [])
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
    const missing = [...flags].filter((flag) => !have.has(flag))
    if (missing.length) lines.push(`${tool} ${subcommand}: ${missing.join(', ')} not in its description`)
  }
  return lines
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

// A long-running server in the background, its output in a log file the test reads.
export function background(command: string, args: string[], log: string): () => void {
  const fd = openSync(log, 'a')
  const child = spawn(command, args, { stdio: ['ignore', fd, fd], detached: true })
  closeSync(fd)
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
