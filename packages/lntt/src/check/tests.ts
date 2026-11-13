// `lntt check tests`: what can be computed about a change's tests without judgement.
// `levels` (each test file at exactly one level, opening what its level needs, and the
// pyramid), `focus` (.only, .skip, a new todo, a test with no assertion), `rules` (the
// patterns the project forbids), `touched` (the lines the diff changes and the tests
// that run them) and `mutate` (does a mutation make a test fail: a tool run by hand).

//
// On Effect: the checks read the project as read (Tree, src/check/tree.ts) and stay plain; the
// diff from a base comes from Git, and `touched`'s coverage runs each test file in the scratch
// worktree through TestRunner (src/check/mutate.ts). src/check/tests.spec.ts runs them in memory.

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { Git } from '../git/git.ts'
import { CheckFailed, readText } from './areas.ts'
import { matchesGlob } from './glob.ts'
import { scratch, TestRunner } from './mutate.ts'
import type { CheckOptions, Result } from './results.ts'
import {
  type Candidate,
  candidates,
  commandFor,
  ImportGraph,
  type Level,
  levelsOf,
  type Rule,
  testFiles,
  testsConfig,
} from './test-files.ts'
import type { Tree } from './tree.ts'

type Paths = Path.Path

export const TESTS_CHECKS = ['levels', 'focus', 'rules', 'touched', 'mutate'] as const

function result(check: string, status: Result['status'], path: string | null, line: number | null, message: string) {
  return { area: 'tests', check, status, path, line, message } satisfies Result
}

// A test file as lines.
function read(tree: Tree, file: string): string[] {
  return (tree.text(file) ?? '').split('\n')
}

// The lines each file gains, from the diff (`git diff -U0`) and the files not yet tracked, which
// are added whole: `untracked` gives each its number of lines.
export function addedLinesOf(diff: string, untracked: [string, number][]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const [f, n] of untracked) out.set(f, new Set(Array.from({ length: n }, (_, i) => i + 1)))
  let file: string | null = null
  for (const line of diff.split('\n')) {
    const header = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line)
    if (header) {
      file = header[1] ?? null
      if (file) out.set(file, new Set())
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && file) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let i = 0; i < count; i++) out.get(file)?.add(start + i)
    }
  }
  return out
}

// The lines each file gains from `base` to the working tree.
export const addedLines = Effect.fnUntraced(function* (root: string, base: string) {
  const git = yield* Git
  const diff = yield* git
    .addedFrom(root, base)
    .pipe(
      Effect.mapError(
        () => new CheckFailed({ message: `git diff ${base} failed in ${root}: is ${base} a ref of this repository?` }),
      ),
    )
  const untracked = yield* git
    .listFiles(root, { others: true })
    .pipe(Effect.mapError((error) => new CheckFailed({ message: error.message })))
  const counted: [string, number][] = []
  for (const f of untracked) {
    const text = yield* readText(root, f).pipe(Effect.orElseSucceed(() => null))
    if (text !== null) counted.push([f, text.split('\n').length])
  }
  return addedLinesOf(diff, counted)
})

export interface Scope {
  config: ReturnType<typeof testsConfig>
  tree: Tree
  files: string[]
  tests: string[]
  // The test files and lines a check looks at: the diff's with a base, every one without.
  touchedTests: string[]
  added: Map<string, Set<number>> | null
}

// What the checks look at; `added` is null without a base.
export function scopeOf(data: Record<string, unknown>, tree: Tree, added: Map<string, Set<number>> | null): Scope {
  const config = testsConfig(data)
  const files = tree.files
  const tests = testFiles(config, files)
  return { config, tree, files, tests, added, touchedTests: added ? tests.filter((t) => added.has(t)) : tests }
}

function isNew(s: Scope, file: string, line: number): boolean {
  return s.added === null || (s.added.get(file)?.has(line) ?? false)
}

const TEST_CALL = /^\s*(?:await\s+)?(?:it|test)(?:\.[A-Za-z]+(?:\([^)]*\))?)*\s*\(/

// ---- levels ----------------------------------------------------------------------

function words(names: string[]): RegExp {
  return new RegExp(`\\b(?:${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})\\b`)
}

// A jsdom test that stubs a Web API drives the stub: whether that is the lowest level
// that can fail for the right reason is the reviewer's call; this lists the candidates.
const STUBBED_API =
  /\bstubGlobal\b|\b(?:Intersection|Resize|Mutation)Observer\b|\bgetBoundingClientRect\b|\bscrollIntoView\b/

function countTests(lines: string[]): number {
  return lines.filter((l) => TEST_CALL.test(l)).length
}

export function levels(s: Scope): Result[] {
  if (s.config.levels.length === 0) return [result('levels', 'NOT RUN', null, null, 'tests.levels is not configured')]
  const out: Result[] = []
  const names = s.config.levels.map((l) => l.name).join(', ')
  let problems = 0
  const perLevel = new Map<string, { files: number; tests: number; addedFiles: number; addedTests: number }>()
  for (const level of s.config.levels) perLevel.set(level.name, { files: 0, tests: 0, addedFiles: 0, addedTests: 0 })
  for (const file of s.tests) {
    const lines = read(s.tree, file)
    const at = levelsOf(s.config, file)
    if (at.length !== 1) {
      problems++
      out.push(
        result(
          'levels',
          'FAIL',
          file,
          1,
          at.length === 0
            ? `a test file at no level (${names}): add it to a level's files`
            : `a test file at ${at.length} levels (${at.map((l) => l.name).join(', ')}): a level's exclude must take it out of all but one`,
        ),
      )
      continue
    }
    const level = at[0] as Level
    const text = lines.join('\n')
    if (level.harness.length > 0 && !words(level.harness).test(text)) {
      problems++
      out.push(
        result(
          'levels',
          'FAIL',
          file,
          1,
          `a ${level.name} test that does not open its harness (${level.harness.join(', ')}): it does not integrate; move it to a lower level or use the harness`,
        ),
      )
    }
    if (/jsdom|happy-dom/.test(level.environment ?? '') && STUBBED_API.test(text)) {
      const stubbed = lines.findIndex((l) => STUBBED_API.test(l)) + 1
      out.push(
        result(
          'levels',
          'INFO',
          file,
          stubbed,
          `candidate: a ${level.name} test that stubs a Web API: is the assertion on the code or on the stub?`,
        ),
      )
    }
    const tally = perLevel.get(level.name) as { files: number; tests: number; addedFiles: number; addedTests: number }
    tally.files++
    tally.tests += countTests(lines)
    if (s.added?.has(file)) {
      tally.addedFiles++
      tally.addedTests += lines.filter((l, i) => TEST_CALL.test(l) && isNew(s, file, i + 1)).length
    }
  }
  for (const level of s.config.levels) {
    const t = perLevel.get(level.name) as { files: number; tests: number; addedFiles: number; addedTests: number }
    const added = s.added ? `; the diff adds ${t.addedTests} tests in ${t.addedFiles} files` : ''
    out.push(
      result(
        'levels',
        'INFO',
        null,
        null,
        `${level.name}${level.environment ? ` (${level.environment})` : ''}: ${t.tests} tests in ${t.files} files${added}`,
      ),
    )
  }
  if (problems === 0) {
    out.push(
      result(
        'levels',
        'PASS',
        null,
        null,
        `${s.tests.length} test files, each at exactly one level (${names}) and opening its harness`,
      ),
    )
  }
  return out
}

// ---- focus -----------------------------------------------------------------------

const ONLY = /\b(?:describe|it|test|suite)\.only\b|\b(?:fit|fdescribe)\s*\(/
const SKIP = /\b(?:describe|it|test|suite)\.skip\b|\b(?:xit|xtest|xdescribe)\s*\(|\bt\.skip\s*\(|\bskip\s*:\s*true\b/
const TODO = /\b(?:describe|it|test|suite)\.todo\b|\bt\.todo\s*\(/
const ASSERTION =
  /\b(?:expect|assert)\w*\s*[.(]|\bassert\b|\bt\.\w*(?:assert|equal|ok|throws|rejects|snapshot|match)\w*\s*\(|\.should\b|\b\w*(?:assert|expect|verify|check)\w*\s*\(/i

// The text of the call opened at `from` (the index of its opening parenthesis), strings
// and comments left in: only the balance of the brackets matters to find its end.
function callBody(text: string, from: number): string {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < text.length; i++) {
    const c = text[i] as string
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(from, i + 1)
  }
  return text.slice(from)
}

// The line without the text of its string literals: a test named 'it.only is rejected'
// has no .only.
function withoutStrings(line: string): string {
  return line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '$1$1')
}

// A run-time `t.skip('reason')` decides in the test that this run proves nothing and says
// why (a provider's usage limit): the reason is a string literal with text in it. A bare
// `t.skip()`, a `t.skip(reason)` with a variable, an empty string or a template that
// opens with a placeholder is the skip the check rejects. Only the reasoned call is cut.
const REASONED_SKIP = /\bt\.skip\s*\(\s*(['"`])\s*(?!\$\{)[^\s'"`](?:\\.|(?!\1)[^\\])*\1/g

function comment(line: string): boolean {
  return /^\s*(?:\/\/|\*|\/\*)/.test(line)
}

export function focus(s: Scope): Result[] {
  const out: Result[] = []
  for (const file of s.touchedTests) {
    const lines = read(s.tree, file)
    lines.forEach((line, i) => {
      if (comment(line)) return
      const n = i + 1
      // A reasoned run-time skip is no new skip: its `t.skip(` is cut before the match.
      const code = withoutStrings(line.replace(REASONED_SKIP, '""'))
      if (ONLY.test(code)) {
        out.push(result('focus', 'FAIL', file, n, '.only: the rest of the file does not run'))
      } else if (SKIP.test(code) && isNew(s, file, n)) {
        out.push(
          result(
            'focus',
            'FAIL',
            file,
            n,
            "a skipped test: fix it or delete it (a skipIf, or a run-time t.skip('reason') with a written reason, is fine)",
          ),
        )
      } else if (TODO.test(code) && isNew(s, file, n)) {
        out.push(result('focus', 'FAIL', file, n, 'a todo test: a test that does not exist yet'))
      }
    })
    // A test call with no assertion in it.
    const extra =
      s.config.assertions.length > 0
        ? new RegExp(`\\b(?:${s.config.assertions.join('|').replace(/\$/g, '\\$')})\\s*\\(`)
        : null
    const text = lines.join('\n')
    const starts = [...lines.entries()]
      .filter(
        ([i, l]) =>
          TEST_CALL.test(l) &&
          !SKIP.test(withoutStrings(l)) &&
          !TODO.test(withoutStrings(l)) &&
          !ONLY.test(withoutStrings(l)) &&
          isNew(s, file, i + 1),
      )
      .map(([i, l]) => {
        const offset = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
        return {
          line: i + 1,
          at: offset + Math.max(l.indexOf('(', l.search(/\b(?:it|test)\b/)), 0),
        }
      })
    for (const start of starts) {
      const body = callBody(text, start.at)
      // a call carrying only a title (a table-driven title, a todo by another name) has no body
      if (!/=>|\bfunction\b/.test(body)) continue
      if (!ASSERTION.test(body) && !extra?.test(body)) {
        out.push(
          result('focus', 'FAIL', file, start.line, 'a test with no assertion: it passes whatever the code does'),
        )
      }
    }
  }
  if (!out.some((r) => r.status === 'FAIL')) {
    out.push(
      result(
        'focus',
        'PASS',
        null,
        null,
        `${s.touchedTests.length} test files: no .only, no new .skip or todo, every test asserts`,
      ),
    )
  }
  return out
}

// ---- rules -----------------------------------------------------------------------

export function rules(s: Scope): Result[] {
  if (s.config.rules.length === 0) return [result('rules', 'NOT RUN', null, null, 'tests.rules is not configured')]
  const out: Result[] = []
  for (const rule of s.config.rules) out.push(...checkRule(s, rule))
  return out
}

// How a heading becomes the fragment of a link to it.
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

// The record behind a rule: its file, and the heading its fragment names.
export function recordMissing(tree: Tree, anchor: string): string | null {
  const hash = anchor.indexOf('#')
  const path = hash < 0 ? anchor : anchor.slice(0, hash)
  const fragment = hash < 0 ? undefined : anchor.slice(hash + 1)
  const text = tree.text(path)
  if (text === null) return 'the record behind the rule is not there'
  if (fragment === undefined || fragment === '') return null
  let wanted: string
  try {
    wanted = decodeURIComponent(fragment).toLowerCase()
  } catch {
    wanted = fragment.toLowerCase()
  }
  // Slugs as GitHub makes them: a repeated heading takes -1, -2; fenced lines are no heading.
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  let fence: string | null = null
  for (const line of text.split('\n')) {
    // CommonMark: a fence opens on a run of three or more ` or ~ and closes on a bare
    // run of the same character at least as long.
    if (fence === null) {
      const open = /^ {0,3}(`{3,}(?!.*`)|~{3,})/.exec(line)?.[1]
      if (open) {
        fence = open
        continue
      }
    } else {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1]
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null
      continue
    }
    if (fence !== null || !/^ {0,3}#{1,6}(?:\s|$)/.test(line)) continue
    const base = slug(
      line
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
    )
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs.has(wanted) ? null : `the record has no heading #${fragment}`
}

function checkRule(s: Scope, rule: Rule): Result[] {
  const where = `rule ${rule.name} (${rule.anchor})`
  const missing = recordMissing(s.tree, rule.anchor)
  if (missing) return [result('rules', 'FAIL', null, null, `${where}: ${missing}`)]
  if (rule.assertedBy !== null) {
    const there = s.tree.isFile(rule.assertedBy) || s.files.some((f) => f.startsWith(`${rule.assertedBy}/`))
    if (!there) {
      return [result('rules', 'FAIL', rule.assertedBy, null, `${where}: the test that asserts it is not there`)]
    }
    return [
      result('rules', 'INFO', rule.assertedBy, null, `${where} is asserted by ${rule.assertedBy}: not checked again`),
    ]
  }
  let pattern: RegExp
  try {
    pattern = new RegExp(rule.pattern)
  } catch (error) {
    return [
      result(
        'rules',
        'FAIL',
        null,
        null,
        `${where}: the pattern is not a regular expression (${(error as Error).message})`,
      ),
    ]
  }
  const files = s.touchedTests.filter((f) => rule.files.length === 0 || rule.files.some((g) => matchesGlob(f, g)))
  const found: Result[] = []
  for (const file of files) {
    read(s.tree, file).forEach((line, i) => {
      if (comment(line) || !pattern.test(line) || !isNew(s, file, i + 1)) return
      found.push(result('rules', 'FAIL', file, i + 1, `${where}: ${rule.message ?? `matches ${rule.pattern}`}`))
    })
  }
  return found.length > 0 ? found : [result('rules', 'PASS', null, null, `${where}: ${files.length} files, no match`)]
}

// ---- touched ---------------------------------------------------------------------

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

// Lines run (count above zero) by file, from an lcov report, keyed by absolute path.
export function parseLcov(p: Pick<Paths, 'join'>, text: string, base: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let current: Set<number> | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim()
      current = new Set()
      out.set(path.startsWith('/') ? path : p.join(base, path), current)
    } else if (line.startsWith('DA:') && current) {
      const [n, hits] = line.slice(3).split(',')
      if (Number(hits) > 0) current.add(Number(n))
    } else if (line === 'end_of_record') current = null
  }
  return out
}

function ranges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (sorted[j + 1] === (sorted[j] as number) + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

// The lines one test file runs, by coverage, or null when its level has none: its level's coverage
// command run in the scratch, its lcov report read from a folder of its own under `out`.
const coverageOf = Effect.fnUntraced(function* (
  level: Level,
  test: string,
  scratchRoot: string,
  out: string,
  cache: Map<string, Map<string, Set<number>> | null>,
) {
  const hit = cache.get(test)
  if (hit !== undefined) return hit
  let lines: Map<string, Set<number>> | null = null
  if (level.coverage !== null) {
    const fs = yield* FileSystem.FileSystem
    const p = yield* Path.Path
    const dir = yield* fs.makeTempDirectory({ directory: out, prefix: 'cov-' })
    const cwd = p.join(scratchRoot, level.cwd)
    yield* (yield* TestRunner).run(
      commandFor(p, level.coverage, level, [test], dir),
      cwd,
      Duration.seconds(level.timeoutSeconds),
    )
    const lcov = yield* fs.readFileString(p.join(dir, 'lcov.info')).pipe(Effect.option)
    if (lcov._tag === 'Some') lines = parseLcov(p, lcov.value, cwd)
  }
  cache.set(test, lines)
  return lines
})

// What one changed file's lines are run by: the tests that import it, and (`covered`, per test)
// the lines each runs, null for a test whose level has no coverage or was not asked for it.
export function touchedResult(
  file: string,
  lines: Set<number>,
  groups: Candidate[],
  covered: ((test: string) => Map<string, Set<number>> | null) | null,
  scratchRoot: string,
  skipped: boolean,
): Result {
  const all = groups.flatMap((g) => g.files)
  if (all.length === 0) {
    return result('touched', 'INFO', file, null, `lines ${ranges([...lines])}: no test imports this file`)
  }
  const hits = new Map<string, string[]>()
  let viaCoverage = true
  for (const g of groups) {
    for (const test of g.files) {
      const run = covered ? covered(test) : null
      if (run === null) {
        viaCoverage = false
        continue
      }
      const hit = [...run.entries()].find(([abs]) => abs.endsWith(`/${file}`) || abs === `${scratchRoot}/${file}`)
      for (const n of lines) if (hit?.[1].has(n)) hits.set(`${n}`, [...(hits.get(`${n}`) ?? []), test])
    }
  }
  if (!viaCoverage) {
    return result(
      'touched',
      'INFO',
      file,
      null,
      `lines ${ranges([...lines])}: tests that import it, from imports (${skipped ? 'coverage not run' : 'no coverage for their level'}): ${all.join(', ')}`,
    )
  }
  const byTests = new Map<string, number[]>()
  const unreached: number[] = []
  for (const n of [...lines].sort((a, b) => a - b)) {
    const tests = hits.get(`${n}`)
    if (!tests) unreached.push(n)
    else byTests.set(tests.join(', '), [...(byTests.get(tests.join(', ')) ?? []), n])
  }
  const parts = [...byTests.entries()].map(([tests, ns]) => `lines ${ranges(ns)}: ${tests}`)
  if (unreached.length > 0) parts.push(`lines ${ranges(unreached)}: no test runs them`)
  return result('touched', 'INFO', file, null, parts.join('; '))
}

// The lines the diff changes and the tests that run them: from coverage in a scratch worktree when
// a level has it and the caller did not turn it off, else from imports.
export const touched = Effect.fnUntraced(function* (options: CheckOptions, s: Scope) {
  if (s.added === null) return [result('touched', 'NOT RUN', null, null, 'needs --base: the lines the diff changes')]
  if (s.config.levels.length === 0) return [result('touched', 'NOT RUN', null, null, 'tests.levels is not configured')]
  const changed = [...s.added.entries()].filter(
    ([f, lines]) => SOURCE.test(f) && lines.size > 0 && !s.tests.includes(f),
  )
  if (changed.length === 0) return [result('touched', 'PASS', null, null, 'the diff changes no source line')]
  const p = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const graph = new ImportGraph(p, s.tree)
  const useCoverage = options.coverage !== false && s.config.levels.some((l) => l.coverage !== null)
  // Coverage a level has and the caller did not ask for, as against a level without any.
  const skipped = (groups: Candidate[]) => !useCoverage && groups.some((g) => g.level.coverage !== null)
  const scratchRoot = useCoverage ? (yield* scratch(options.root)).root : null
  const out = scratchRoot === null ? '' : yield* fs.makeTempDirectoryScoped({ prefix: 'lntt-cov-' })
  const cache = new Map<string, Map<string, Set<number>> | null>()
  const results: Result[] = []
  for (const [file, lines] of changed) {
    if (!(yield* fs.exists(p.join(options.root, file)))) {
      results.push(result('touched', 'INFO', file, null, 'deleted'))
      continue
    }
    const groups = candidates(s.config, s.tree, file, graph)
    const runs = new Map<string, Map<string, Set<number>> | null>()
    if (scratchRoot !== null) {
      for (const g of groups) {
        for (const test of g.files) runs.set(test, yield* coverageOf(g.level, test, scratchRoot, out, cache))
      }
    }
    results.push(
      touchedResult(
        file,
        lines,
        groups,
        scratchRoot === null ? null : (test) => runs.get(test) ?? null,
        scratchRoot ?? '',
        skipped(groups),
      ),
    )
  }
  return results
}, Effect.scoped)

// ---- all of them -----------------------------------------------------------------

// `lntt check tests`, or one of its checks but `mutate`, over the project as read.
export const runTests = Effect.fnUntraced(function* (check: string | undefined, options: CheckOptions, tree: Tree) {
  // A project that has not described its tests is not asked to: `lntt check` alone passes
  // over it (an explicit check still runs).
  if (check === undefined && options.data.tests === undefined) {
    return [result('levels', 'NOT RUN', null, null, 'the configuration has no tests section')]
  }
  const added = options.base === undefined ? null : yield* addedLines(options.root, options.base)
  const s = scopeOf(options.data, tree, added)
  const plain: Record<string, () => Result[]> = {
    levels: () => levels(s),
    focus: () => focus(s),
    rules: () => rules(s),
  }
  if (check === 'touched') return yield* touched(options, s)
  if (check !== undefined) return (plain[check] as () => Result[])()
  return [...levels(s), ...focus(s), ...rules(s), ...(yield* touched(options, s))]
})
