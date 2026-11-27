// `lntt check tests mutate`: apply one mutation a reviewer proposes to a line, run the
// tests that can run that line, and say whether one fails (killed) or none does
// (survived). The mutation lives in a scratch git worktree; the working tree is never
// written, whatever happens.
//
// On Effect (docs/adr/effect-in-lntt.md): the scratch worktree is a resource of the command's scope
// (acquireRelease), removed however the command ends; the mutated file is restored by a finalizer
// (Effect.ensuring); each test file runs through TestRunner, whose live layer starts it in a
// process group of its own that its timeout or an interrupt stops with SIGKILL. An interrupt
// (SIGINT, SIGTERM) runs those finalizers, then the command exits 130 (src/run-command.ts).
// src/check/mutate.spec.ts runs the logic on a FileSystem and a TestRunner in memory.

import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Stream from 'effect/Stream'
import { Git } from '../git/git.ts'
import { CheckFailed, readText } from './areas.ts'
import type { Result } from './results.ts'
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

// ---- running a test file ---------------------------------------------------------

export interface TestRun {
  // null when the run did not end on its own (its timeout).
  code: number | null
  // stdout and stderr, as they came.
  output: string
  timedOut: boolean
}

// One shell command in `cwd`, stopped past `timeout`.
export class TestRunner extends Context.Service<
  TestRunner,
  { readonly run: (command: string, cwd: string, timeout: Duration.Duration) => Effect.Effect<TestRun> }
>()('@lntt/lntt/check/mutate/TestRunner') {}

// The environment tests start in: the one lntt runs in, less what makes a nested
// `node --test` act as a child of the one that runs lntt.
export function testEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, FORCE_COLOR: '0', NO_COLOR: '1' }
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name]
  return env
}

// A command through the spawner, `sh -c`, in a process group of its own: its timeout interrupts
// it, and the spawner sends SIGKILL to the group, so nothing it started outlives it.
export const runShell = (
  command: string,
  cwd: string,
  timeout: Duration.Duration,
  env: Record<string, string | undefined>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make('sh', ['-c', command], {
            cwd,
            env: testEnv(env),
            extendEnv: false,
            stdin: 'ignore',
            killSignal: 'SIGKILL',
          }),
        )
        const [output, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(child.all)), child.exitCode], {
          concurrency: 'unbounded',
        })
        return { code: Number(code), output, timedOut: false } satisfies TestRun
      }),
    )
    const ended = yield* Effect.timeoutOption(run, timeout)
    return ended._tag === 'Some' ? ended.value : ({ code: null, output: '', timedOut: true } satisfies TestRun)
  }).pipe(
    // A shell that cannot start is a command that did not pass.
    Effect.catchTag('PlatformError', (error) => Effect.succeed({ code: 127, output: error.message, timedOut: false })),
  )

// The tests on the machine, with lntt's environment.
export const TestRunnerLive = Layer.effect(TestRunner)(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return TestRunner.of({
      run: (command, cwd, timeout) =>
        runShell(command, cwd, timeout, process.env).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    })
  }),
)

// ---- the scratch worktree --------------------------------------------------------

// A copy of the project at HEAD with the uncommitted changes laid over it, in a git worktree of its
// own under the system's temp folder, a resource of the current scope. The dependencies are shared
// with the project: a pnpm store is linked, the links into it (workspace packages included) are
// copied as they are, so that they point inside the scratch. `root` is the project's root inside it.
export const scratch = Effect.fnUntraced(function* (root: string) {
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const failed = (what: string) => (error: { message: string }) =>
    new CheckFailed({ message: `${what} failed in ${root}: ${error.message.split('\n')[0]}` })
  const top = yield* git
    .topOf(root)
    .pipe(Effect.flatMap(fs.realPath), Effect.mapError(failed('git rev-parse --show-toplevel')))
  // A run killed outright leaves its registration behind: clear those first.
  yield* git.pruneWorktrees(top).pipe(Effect.ignore)
  const prefix = path.relative(top, yield* fs.realPath(root))
  const acquire = Effect.gen(function* () {
    const dir = yield* fs.realPath(yield* fs.makeTempDirectory({ prefix: 'lntt-mutate-' }))
    return { dir, tree: path.join(dir, 'tree') }
  })
  const release = ({ dir, tree }: { dir: string; tree: string }) =>
    Effect.gen(function* () {
      yield* git.removeWorktree(top, tree).pipe(Effect.ignore)
      yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)
      yield* git.pruneWorktrees(top).pipe(Effect.ignore)
    })
  const { tree } = yield* Effect.acquireRelease(acquire, release)
  yield* git.addWorktree(top, tree).pipe(Effect.mapError(failed('git worktree add')))
  // Uncommitted work: modified and new files copied, deleted ones removed.
  const changed = new Set([
    ...(yield* git.changedFromHead(top).pipe(Effect.mapError(failed('git diff')))),
    ...(yield* git.listFiles(top, { others: true }).pipe(Effect.mapError(failed('git ls-files')))),
  ])
  for (const file of changed) {
    const source = path.join(top, file)
    const target = path.join(tree, file)
    if (yield* fs.exists(source)) {
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* copyEntry(source, target)
    } else yield* fs.remove(target, { force: true })
  }
  const ignored = yield* git.ignoredDirectories(top).pipe(Effect.mapError(failed('git ls-files')))
  for (const modules of ignored.filter((p) => /(^|\/)node_modules\/$/.test(p)).map((p) => p.slice(0, -1))) {
    yield* mirrorNodeModules(path.join(top, modules), path.join(tree, modules))
  }
  return { root: path.join(tree, prefix) }
})

// A file or a symbolic link copied as it is (a link keeps its target, relative or not), a
// directory with what it holds.
const copyEntry: (
  from: string,
  to: string,
) => Effect.Effect<void, import('effect/PlatformError').PlatformError, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (from: string, to: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const link = yield* fs.readLink(from).pipe(Effect.option)
    if (link._tag === 'Some') return yield* fs.symlink(link.value, to)
    const info = yield* fs.stat(from)
    if (info.type !== 'Directory') return yield* fs.copyFile(from, to)
    yield* fs.makeDirectory(to, { recursive: true })
    for (const entry of yield* fs.readDirectory(from)) yield* copyEntry(path.join(from, entry), path.join(to, entry))
  })

// A node_modules folder in the scratch: linked whole when it is no pnpm folder, else its entries
// copied as they are and its .pnpm store linked.
const mirrorNodeModules = Effect.fnUntraced(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(to), { recursive: true })
  if (!(yield* fs.exists(path.join(from, '.pnpm')))) return yield* fs.symlink(from, to)
  yield* fs.makeDirectory(to)
  for (const entry of yield* fs.readDirectory(from)) {
    const source = path.join(from, entry)
    if (entry === '.pnpm') yield* fs.symlink(source, path.join(to, entry))
    else yield* copyEntry(source, path.join(to, entry))
  }
})

// ---- the mutation ----------------------------------------------------------------

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

// A path the mutation may not follow: absolute, or leaving the project.
const outside = (path: string) => path === '' || path.startsWith('/') || path.split('/').includes('..')

// Why the mutation cannot apply to the file's text (null when there is no file), or null.
export function problem(mutation: Mutation, text: string | null): string | null {
  if (outside(mutation.path)) return `${mutation.path} is not a path inside the project`
  if (text === null) return `${mutation.path}: no such file`
  const lines = text.split('\n')
  if (mutation.line < 1 || mutation.line > lines.length) {
    return `${mutation.path}:${mutation.line}: the file has ${lines.length} lines`
  }
  const line = lines[mutation.line - 1] as string
  if (mutation.text === '') return 'the text to mutate is empty'
  if (mutation.text === mutation.to) return 'the mutated text is the text: nothing changes'
  if (!line.includes(mutation.text)) {
    return `${mutation.path}:${mutation.line} does not contain ${JSON.stringify(mutation.text)}; the line reads ${JSON.stringify(line.trim())}`
  }
  const count = line.split(mutation.text).length - 1
  if (count > 1) {
    return `${JSON.stringify(mutation.text)} is ${count} times on ${mutation.path}:${mutation.line}: give a longer text that is there once`
  }
  return null
}

// The text with the mutation applied: the mutated text is written as it is, never a pattern.
export function mutated(text: string, mutation: Mutation): string {
  const lines = text.split('\n')
  const index = mutation.line - 1
  lines[index] = (lines[index] as string).replace(mutation.text, () => mutation.to)
  return lines.join('\n')
}

// The test files the author names, grouped by level in the order of `tests.levels`; why not when
// one cannot run. `present`: the named files that are in the scratch.
export function groupTests(
  data: Record<string, unknown>,
  tests: string[],
  present: Set<string>,
): { groups: { level: Level; files: string[] }[] } | { reason: string } {
  const config = testsConfig(data)
  if (config.levels.length === 0) return { reason: 'tests.levels is not configured' }
  const found = new Map<Level, string[]>()
  for (const test of new Set(tests)) {
    if (outside(test) || !present.has(test)) return { reason: `--test ${test}: no such file in the project` }
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

const hangOf = (level: Level) => `did not finish in ${level.timeoutSeconds}s`

// The command of one test file, run a level's `repeat` times in a row, stopping at the first run
// that does not pass.
const runFile = Effect.fnUntraced(function* (level: Level, file: string, scratchRoot: string) {
  const runner = yield* TestRunner
  const path = yield* Path.Path
  const command = commandFor(path, level.run as string, level, [file])
  let last: TestRun = { code: 0, output: '', timedOut: false }
  for (let i = 0; i < level.repeat; i++) {
    last = yield* runner.run(command, path.join(scratchRoot, level.cwd), Duration.seconds(level.timeoutSeconds))
    if (last.code !== 0) return last
  }
  return last
})

// Every file of a level, one at a time; a file that fails ends the rest, a file that hangs does not.
const runFiles = Effect.fnUntraced(function* (level: Level, files: string[], scratchRoot: string) {
  const results: { file: string; run: TestRun }[] = []
  for (const file of files) {
    const run = yield* runFile(level, file, scratchRoot)
    results.push({ file, run })
    if (run.code !== 0 && !run.timedOut) break
  }
  return results
})

// Applies the mutation in the scratch whose project root is `scratchRoot`, runs the test files the
// author names, and restores the file whatever happens (a finalizer: an interrupt too).
export const mutate = Effect.fnUntraced(function* (
  scratchRoot: string,
  data: Record<string, unknown>,
  mutation: Mutation,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const original = outside(mutation.path) ? null : yield* readText(scratchRoot, mutation.path)
  const bad = problem(mutation, original)
  if (bad || original === null) return { outcome: 'not run', reason: bad ?? '' } satisfies Outcome as Outcome
  const present = new Set<string>()
  for (const test of mutation.tests) {
    if (!outside(test) && (yield* fs.exists(path.join(scratchRoot, test)))) present.add(test)
  }
  const grouped = groupTests(data, mutation.tests, present)
  if ('reason' in grouped) return { outcome: 'not run', reason: grouped.reason } satisfies Outcome as Outcome
  const { groups } = grouped
  const ran = groups.flatMap((g) => g.files)
  const target = path.join(scratchRoot, mutation.path)
  const restore = fs.writeFileString(target, original)

  const run = Effect.gen(function* () {
    yield* fs.writeFileString(target, mutated(original, mutation))
    for (const group of groups) {
      const results = yield* runFiles(group.level, group.files, scratchRoot)
      const failed = results.find((r) => r.run.code !== 0 && !r.run.timedOut)
      const hangs = results.filter((r) => r.run.timedOut)
      const suspect = failed ?? hangs[0]
      if (!suspect) continue
      // A failure or a hang counts only when the same file passes without the mutation.
      yield* restore
      const baseline = yield* runFile(group.level, suspect.file, scratchRoot)
      if (baseline.timedOut) {
        return {
          outcome: 'not run',
          reason: `${suspect.file} ${hangOf(group.level)}, with or without the mutation`,
        } satisfies Outcome
      }
      if (baseline.code !== 0) {
        const why = failureOf(baseline.output)
        return {
          outcome: 'not run',
          reason: `level ${group.level.name} fails without the mutation (${suspect.file}: ${why.test}: ${why.message})`,
        } satisfies Outcome
      }
      const found = failed
        ? failureOf(failed.run.output)
        : { test: suspect.file, message: `${hangOf(group.level)} (a hang)` }
      return { outcome: 'killed', ...found, ran } satisfies Outcome
    }
    return { outcome: 'survived', ran } satisfies Outcome
  })
  return (yield* run.pipe(Effect.ensuring(restore.pipe(Effect.ignore)))) as Outcome
})

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

// The result of a mutation.
export function mutationResult(mutation: Mutation, outcome: Outcome): Result {
  return {
    area: 'tests',
    check: 'mutate',
    path: mutation.path,
    line: mutation.line,
    ...describeOutcome(mutation, outcome),
  }
}

// The mutations of a `lntt check tests mutate` call as results, one scratch for all, removed when
// the scope closes.
export const mutateAll = Effect.fnUntraced(function* (
  root: string,
  data: Record<string, unknown>,
  mutations: Mutation[],
) {
  const { root: scratchRoot } = yield* scratch(root)
  const results: Result[] = []
  for (const m of mutations) results.push(mutationResult(m, yield* mutate(scratchRoot, data, m)))
  return results
}, Effect.scoped)
