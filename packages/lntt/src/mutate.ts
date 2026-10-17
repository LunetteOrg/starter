// `lntt check tests mutate`: apply one mutation a reviewer proposes to a line, run the
// tests that can run that line, and say whether one fails (killed) or none does
// (survived). The mutation lives in a scratch git worktree; the working tree is never
// written, whatever happens.

import { execFileSync, spawnSync } from 'node:child_process'
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
import { type Candidate, candidates, commandFor, ImportGraph, type Level, testsConfig } from './test-files.ts'

export interface Mutation {
  path: string
  line: number
  // What is on the line, and what it becomes.
  text: string
  to: string
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
  // An interrupt removes the worktree too; lntt leaves with the signal unless another
  // handler (a review round stopping its agents) is there to do it.
  const onSignal = (signal: NodeJS.Signals) => {
    dispose()
    if (process.listenerCount(signal) === 1) process.exit(130)
  }
  process.once('exit', onExit)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  return {
    root: join(worktree, prefix),
    dispose() {
      process.off('exit', onExit)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
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

function runLevel(level: Level, files: string[], scratch: string, coverageOut?: string): Run {
  const cwd = join(scratch, level.cwd)
  const template = coverageOut === undefined ? level.run : level.coverage
  if (template === null) return { code: null, output: `level ${level.name} has no run command`, timedOut: false }
  const command = commandFor(template, level, files, coverageOut)
  let last: Run = { code: 0, output: '', timedOut: false }
  const times = coverageOut === undefined ? level.repeat : 1
  for (let i = 0; i < times; i++) {
    last = runCommand(command, cwd, level.timeoutSeconds)
    if (last.code !== 0) return last
  }
  return last
}

// Applies the mutation, runs the tests of each level that can run the line, restores.
export function mutate(context: MutateContext, mutation: Mutation): Outcome {
  const bad = problem(mutation, context.scratch.root)
  if (bad) return { outcome: 'not run', reason: bad }
  const config = testsConfig(context.data)
  if (config.levels.length === 0) return { outcome: 'not run', reason: 'tests.levels is not configured' }
  const graph = new ImportGraph(context.root, new Set(context.files))
  const groups: Candidate[] = candidates(context.root, config, context.files, mutation.path, graph)
  const noRun = groups.find((g) => g.level.run === null)
  if (noRun) return { outcome: 'not run', reason: `tests.levels ${noRun.level.name} has no run command` }
  const ran = groups.flatMap((g) => g.files)
  if (groups.length === 0) return { outcome: 'survived', ran }

  const target = join(context.scratch.root, mutation.path)
  const original = readFileSync(target, 'utf8')
  const lines = original.split('\n')
  const index = mutation.line - 1
  lines[index] = (lines[index] as string).replace(mutation.text, () => mutation.to)
  try {
    writeFileSync(target, lines.join('\n'))
    for (const group of groups) {
      const run = runLevel(group.level, group.files, context.scratch.root)
      if (run.code === 0) continue
      if (run.timedOut) {
        return {
          outcome: 'not run',
          reason: `level ${group.level.name} did not finish in ${group.level.timeoutSeconds}s`,
        }
      }
      // A failure counts only when the same tests pass without the mutation.
      writeFileSync(target, original)
      const baseline = runLevel(group.level, group.files, context.scratch.root)
      if (baseline.code !== 0) {
        const why = failureOf(baseline.output)
        return {
          outcome: 'not run',
          reason: `level ${group.level.name} fails without the mutation (${why.test}: ${why.message})`,
        }
      }
      return { outcome: 'killed', ...failureOf(run.output), ran }
    }
    return { outcome: 'survived', ran }
  } finally {
    writeFileSync(target, original)
  }
}

export function describeOutcome(mutation: Mutation, outcome: Outcome): Pick<Result, 'status' | 'message'> {
  const what = `${JSON.stringify(mutation.text)} → ${JSON.stringify(mutation.to)}`
  if (outcome.outcome === 'killed') {
    return { status: 'PASS', message: `${what} killed by ${outcome.test}: ${outcome.message}` }
  }
  if (outcome.outcome === 'survived') {
    return {
      status: 'FAIL',
      message:
        outcome.ran.length === 0
          ? `${what} survived: no test runs this line`
          : `${what} survived: ${outcome.ran.length} test file${outcome.ran.length === 1 ? '' : 's'} still pass (${outcome.ran.join(', ')})`,
    }
  }
  return { status: 'NOT RUN', message: `${what}: ${outcome.reason}` }
}

// The mutations of a `lntt check tests mutate` call as results, one scratch for all.
export function mutateAll(
  base: Omit<MutateContext, 'scratch'>,
  mutations: Mutation[],
): { results: Result[]; outcomes: Outcome[] } {
  const scratch = createScratch(base.root)
  try {
    const outcomes = mutations.map((m) => mutate({ ...base, scratch }, m))
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
