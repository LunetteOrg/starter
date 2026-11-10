// `lntt check tests mutate`: apply one mutation a reviewer proposes to a line, run the
// tests that can run that line, and say whether one fails (killed) or none does
// (survived). The mutation lives in a scratch git worktree; the working tree is never
// written, whatever happens.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { CannotRunError, type Result } from './check.ts'
import { exit } from './exit.ts'
import { commandFor, type Level, levelsOf, testsConfig } from './test-files.ts'

export interface Mutation {
  path: string
  line: number
  // What is on the line, and what it becomes.
  text: string
  to: string
  // The test files the author names: the ones that run.
  tests: string[]
}

export type Outcome =
  | { outcome: 'killed'; test: string; message: string; ran: string[] }
  | { outcome: 'survived'; ran: string[] }
  | { outcome: 'not run'; reason: string }

function git(root: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (error) {
    throw new CannotRunError(`git ${args.join(' ')} failed in ${root}: ${(error as Error).message.split('\n')[0]}`)
  }
}

// A copy of the project at HEAD with the uncommitted changes laid over it, in a git
// worktree of its own under the system's temp folder. The dependencies are shared with
// the project: a pnpm store is linked, the links into it (workspace packages included)
// are copied so that they point inside the scratch.
export interface Scratch {
  // The project's root inside the scratch.
  root: string
  dispose(): void
}

function nodeModulesDirs(top: string): string[] {
  return git(top, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
    .split('\0')
    .filter((p) => /(^|\/)node_modules\/$/.test(p))
    .map((p) => p.slice(0, -1))
}

function mirrorNodeModules(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true })
  if (!existsSync(join(from, '.pnpm'))) {
    symlinkSync(from, to, 'dir')
    return
  }
  mkdirSync(to)
  for (const entry of readdirNames(from)) {
    const source = join(from, entry)
    if (entry === '.pnpm') symlinkSync(source, join(to, entry), 'dir')
    else cpSync(source, join(to, entry), { recursive: true, verbatimSymlinks: true })
  }
}

function readdirNames(dir: string): string[] {
  return execFileSync('ls', ['-A', dir], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

export function createScratch(root: string): Scratch {
  const top = realpathSync(git(root, 'rev-parse', '--show-toplevel').trim())
  // A run killed outright leaves its registration behind: clear those first.
  try {
    execFileSync('git', ['-C', top, 'worktree', 'prune'], { stdio: 'ignore' })
  } catch {}
  const prefix = relative(top, realpathSync(root))
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-mutate-')))
  const worktree = join(dir, 'tree')
  const dispose = () => {
    try {
      execFileSync('git', ['-C', top, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' })
    } catch {}
    rmSync(dir, { recursive: true, force: true })
    try {
      execFileSync('git', ['-C', top, 'worktree', 'prune'], { stdio: 'ignore' })
    } catch {}
  }
  try {
    git(top, 'worktree', 'add', '--detach', '--quiet', worktree, 'HEAD')
    // Uncommitted work: modified and new files copied, deleted ones removed.
    const changed = [
      ...new Set([
        // tracked files against the head, staged or not, deletions included
        ...git(top, 'diff', '-z', '--name-only', '--no-renames', 'HEAD').split('\0'),
        ...git(top, 'ls-files', '-z', '--others', '--exclude-standard').split('\0'),
      ]),
    ].filter(Boolean)
    for (const file of changed) {
      const source = join(top, file)
      if (existsSync(source)) {
        mkdirSync(dirname(join(worktree, file)), { recursive: true })
        cpSync(source, join(worktree, file), { verbatimSymlinks: true })
      } else rmSync(join(worktree, file), { force: true })
    }
    for (const modules of nodeModulesDirs(top)) mirrorNodeModules(join(top, modules), join(worktree, modules))
  } catch (error) {
    dispose()
    throw error
  }
  const onExit = () => dispose()
  process.once('exit', onExit)
  return {
    root: join(worktree, prefix),
    dispose() {
      process.off('exit', onExit)
      dispose()
    },
  }
}

export interface Run {
  code: number | null
  output: string
  timedOut: boolean
}

// The environment tests start in: the one lntt runs in, less what makes a nested
// `node --test` act as a child of the one that runs lntt.
export function testEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FORCE_COLOR: '0', NO_COLOR: '1' }
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name]
  return env
}

export function runCommand(command: string, cwd: string, timeoutSeconds: number): Run {
  const r = spawnSync('sh', ['-c', command], {
    cwd,
    encoding: 'utf8',
    env: testEnv(),
    timeout: timeoutSeconds * 1000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { code: timedOut ? null : r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut }
}

// The shells of the test files that run, each in a process group of its own: a timeout or an
// interrupt stops the file and whatever it started, and nothing outlives lntt.
const groups = new Set<number>()
process.on('exit', () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
})

export interface FileRun extends Run {
  // Stopped before it ended, because another file already failed or lntt was interrupted.
  cancelled: boolean
}

// One command, stopped with its whole group past `timeoutSeconds` or when `signal` aborts.
export function runGroup(command: string, cwd: string, timeoutSeconds: number, signal?: AbortSignal): Promise<FileRun> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, output: '', timedOut: false, cancelled: true })
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: testEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const pid = child.pid
    if (pid) groups.add(pid)
    const stop = () => {
      if (!pid) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
    }
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += chunk))
    let timedOut = false
    let cancelled = false
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutSeconds * 1000)
    const onAbort = () => {
      cancelled = true
      stop()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const done = (code: number | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (pid) groups.delete(pid)
      resolve({ code: timedOut || cancelled ? null : code, output, timedOut, cancelled })
    }
    child.on('error', () => done(127))
    child.on('close', (code) => done(code))
  })
}

const FAILED_TEST = /^\s*(?:✖|✘|×|FAIL\b|not ok \d+ -?)\s*(.+?)(?:\s+\(?\d[\d.]*m?s\)?)?\s*$/
const MESSAGE =
  /^\s*(?:AssertionError|Error|TypeError|ReferenceError|SyntaxError|expected|Expected|error:|message:|\+ actual)\b.*$/i

// The first failing test of a run, and the line that says why, as test runners print
// them (node:test's spec and tap, vitest, playwright): never more than what is there.
export function failureOf(output: string): { test: string; message: string } {
  const lines = output.split('\n')
  const at = lines.findIndex((l) => FAILED_TEST.test(l) && !/^\s*(?:✖|×)\s*failing tests:?\s*$/i.test(l))
  const test = at >= 0 ? ((FAILED_TEST.exec(lines[at] as string)?.[1] as string) ?? '').trim() : ''
  const rest = at >= 0 ? lines.slice(at + 1) : lines
  const message = rest.find((l) => MESSAGE.test(l))?.trim()
  const tail = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
  return { test: test || '(not named in the output)', message: (message ?? tail).slice(0, 300) }
}

export interface MutateContext {
  root: string
  data: Record<string, unknown>
  // The files of the project (tracked or new, not ignored), relative to root.
  files: string[]
  scratch: Scratch
}

function problem(mutation: Mutation, root: string): string | null {
  if (mutation.path === '' || isAbsolute(mutation.path) || mutation.path.split('/').includes('..')) {
    return `${mutation.path} is not a path inside the project`
  }
  const abs = join(root, mutation.path)
  if (!existsSync(abs)) return `${mutation.path}: no such file`
  const lines = readFileSync(abs, 'utf8').split('\n')
  if (mutation.line < 1 || mutation.line > lines.length) {
    return `${mutation.path}:${mutation.line}: the file has ${lines.length} lines`
  }
  const text = lines[mutation.line - 1] as string
  if (mutation.text === '') return 'the text to mutate is empty'
  if (mutation.text === mutation.to) return 'the mutated text is the text: nothing changes'
  if (!text.includes(mutation.text)) {
    return `${mutation.path}:${mutation.line} does not contain ${JSON.stringify(mutation.text)}; the line reads ${JSON.stringify(text.trim())}`
  }
  const count = text.split(mutation.text).length - 1
  if (count > 1) {
    return `${JSON.stringify(mutation.text)} is ${count} times on ${mutation.path}:${mutation.line}: give a longer text that is there once`
  }
  return null
}

// The command of one test file, run a level's `repeat` times in a row, stopping at the first
// run that does not pass.
async function runFile(level: Level, file: string, scratch: string, signal?: AbortSignal): Promise<FileRun> {
  const cwd = join(scratch, level.cwd)
  if (level.run === null)
    return { code: null, output: `level ${level.name} has no run command`, timedOut: false, cancelled: false }
  const command = commandFor(level.run, level, [file])
  let last: FileRun = { code: 0, output: '', timedOut: false, cancelled: false }
  for (let i = 0; i < level.repeat; i++) {
    last = await runGroup(command, cwd, level.timeoutSeconds, signal)
    if (last.code !== 0) return last
  }
  return last
}

// Every file of a level, one at a time; a file that fails ends the rest, a file that hangs does not.
async function runFiles(
  level: Level,
  files: string[],
  scratch: string,
  signal?: AbortSignal,
): Promise<{ file: string; run: FileRun }[]> {
  const results: { file: string; run: FileRun }[] = []
  for (const file of files) {
    if (signal?.aborted) break
    const run = await runFile(level, file, scratch, signal)
    results.push({ file, run })
    if (run.code !== 0 && !run.timedOut && !run.cancelled) break
  }
  return results
}

// "path: why" for a test file that did not pass, as the output of its run says.
const hangOf = (level: Level) => `did not finish in ${level.timeoutSeconds}s`

// The test files the author names, grouped by level in the order of `tests.levels`; why not
// when one cannot run.
function groupTests(
  context: MutateContext,
  tests: string[],
): { groups: { level: Level; files: string[] }[] } | { reason: string } {
  const config = testsConfig(context.data)
  if (config.levels.length === 0) return { reason: 'tests.levels is not configured' }
  const found = new Map<Level, string[]>()
  for (const test of new Set(tests)) {
    if (isAbsolute(test) || test.split('/').includes('..') || !existsSync(join(context.scratch.root, test))) {
      return { reason: `--test ${test}: no such file in the project` }
    }
    const level = levelsOf(config, test)[0]
    if (!level) return { reason: `--test ${test}: no level of tests.levels has this file` }
    if (level.run === null) return { reason: `tests.levels ${level.name} has no run command` }
    // A command without {files} would run the whole suite once for every test file.
    if (!level.run.includes('{files}')) {
      return { reason: `tests.levels ${level.name}: run has no {files}, and mutate runs one test file at a time` }
    }
    found.set(level, [...(found.get(level) ?? []), test])
  }
  return {
    groups: config.levels.flatMap((level) => (found.has(level) ? [{ level, files: found.get(level) ?? [] }] : [])),
  }
}

// Applies the mutation, runs the test files the author names, restores.
export async function mutate(context: MutateContext, mutation: Mutation, signal?: AbortSignal): Promise<Outcome> {
  const bad = problem(mutation, context.scratch.root)
  if (bad) return { outcome: 'not run', reason: bad }
  const grouped = groupTests(context, mutation.tests)
  if ('reason' in grouped) return { outcome: 'not run', reason: grouped.reason }
  const { groups } = grouped
  const ran = groups.flatMap((g) => g.files)

  const target = join(context.scratch.root, mutation.path)
  const original = readFileSync(target, 'utf8')
  const lines = original.split('\n')
  const index = mutation.line - 1
  lines[index] = (lines[index] as string).replace(mutation.text, () => mutation.to)
  try {
    writeFileSync(target, lines.join('\n'))
    for (const group of groups) {
      const results = await runFiles(group.level, group.files, context.scratch.root, signal)
      if (signal?.aborted) return { outcome: 'not run', reason: 'interrupted' }
      const failed = results.find((r) => r.run.code !== 0 && !r.run.timedOut && !r.run.cancelled)
      const hangs = results.filter((r) => r.run.timedOut)
      const suspect = failed ?? hangs[0]
      if (!suspect) continue
      // A failure or a hang counts only when the same file passes without the mutation.
      writeFileSync(target, original)
      const baseline = await runFile(group.level, suspect.file, context.scratch.root, signal)
      if (signal?.aborted) return { outcome: 'not run', reason: 'interrupted' }
      if (baseline.timedOut) {
        return {
          outcome: 'not run',
          reason: `${suspect.file} ${hangOf(group.level)}, with or without the mutation`,
        }
      }
      if (baseline.code !== 0) {
        const why = failureOf(baseline.output)
        return {
          outcome: 'not run',
          reason: `level ${group.level.name} fails without the mutation (${suspect.file}: ${why.test}: ${why.message})`,
        }
      }
      const found = failed
        ? failureOf(failed.run.output)
        : { test: suspect.file, message: `${hangOf(group.level)} (a hang)` }
      return { outcome: 'killed', ...found, ran }
    }
    return { outcome: 'survived', ran }
  } finally {
    writeFileSync(target, original)
  }
}

export function describeOutcome(mutation: Mutation, outcome: Outcome): Pick<Result, 'status' | 'message'> {
  const what = `${JSON.stringify(mutation.text)} → ${JSON.stringify(mutation.to)}`
  if (outcome.outcome === 'killed') {
    return {
      status: 'PASS',
      message: `${what} killed by ${outcome.test}: ${outcome.message}`,
    }
  }
  if (outcome.outcome === 'survived') {
    return {
      status: 'FAIL',
      message: `${what} survived: ${outcome.ran.length} test file${outcome.ran.length === 1 ? '' : 's'} still pass (${outcome.ran.join(', ')})`,
    }
  }
  return { status: 'NOT RUN', message: `${what}: ${outcome.reason}` }
}

// The signals that stop a mutation run, with the code lntt exits with (128 plus the number).
const SIGNALS = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const

// The mutations of a `lntt check tests mutate` call as results, one scratch for all. Past
// `signal` (an interrupt) the run stops, the scratch is removed and what was not run says so.
export async function mutateAll(
  base: Omit<MutateContext, 'scratch'>,
  mutations: Mutation[],
  signal?: AbortSignal,
): Promise<{ results: Result[]; outcomes: Outcome[] }> {
  const scratch = createScratch(base.root)
  try {
    const outcomes: Outcome[] = []
    for (const m of mutations) {
      outcomes.push(
        signal?.aborted ? { outcome: 'not run', reason: 'interrupted' } : await mutate({ ...base, scratch }, m, signal),
      )
    }
    return {
      outcomes,
      results: mutations.map((m, i) => ({
        area: 'tests',
        check: 'mutate',
        path: m.path,
        line: m.line,
        ...describeOutcome(m, outcomes[i] as Outcome),
      })),
    }
  } finally {
    scratch.dispose()
  }
}

// `mutateAll` for the command line: SIGINT and SIGTERM stop the test files, remove the scratch
// worktree and exit 128 plus the signal's number, as every interrupted lntt command does.
export async function mutateAllUntilInterrupted(
  base: Omit<MutateContext, 'scratch'>,
  mutations: Mutation[],
): Promise<{ results: Result[]; outcomes: Outcome[] }> {
  const interrupt = new AbortController()
  let code = 0
  const handlers = SIGNALS.map(([name, exitCode]) => {
    const handler = () => {
      code = exitCode
      interrupt.abort()
    }
    process.on(name, handler)
    return [name, handler] as const
  })
  try {
    const done = await mutateAll(base, mutations, interrupt.signal)
    if (code !== 0) exit(code)
    return done
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler)
  }
}
