// `lntt check tests`: what can be computed about a change's tests without judgement.
// `levels` (each test file at exactly one level, opening what its level needs, and the
// pyramid), `focus` (.only, .skip, a new todo, a test with no assertion), `rules` (the
// patterns the project forbids), `touched` (the lines the diff changes and the tests
// that run them) and `mutate` (does a mutation a reviewer proposes make a test fail).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, matchesGlob } from 'node:path'
import { ANCHOR_LINE, CannotRunError, type CheckOptions, projectFiles, type Result } from './check.ts'
import { createScratch, mutateAll, runCommand } from './mutate.ts'
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

export const TESTS_CHECKS = ['levels', 'focus', 'rules', 'touched', 'mutate'] as const

function result(check: string, status: Result['status'], path: string | null, line: number | null, message: string) {
  return { area: 'tests', check, status, path, line, message } satisfies Result
}

// A test file as lines, and the lines (1-based) the check is about: all of them, or
// with a base only those the diff adds.
function read(root: string, file: string): string[] {
  return readFileSync(join(root, file), 'utf8').split('\n')
}

// The lines each file gains from `base` to the working tree.
export function addedLines(root: string, base: string): Map<string, Set<number>> {
  let diff: string
  try {
    diff = execFileSync('git', ['-C', root, 'diff', '-U0', '--no-renames', '--no-color', '--relative', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch {
    throw new CannotRunError(`git diff ${base} failed in ${root}: is ${base} a ref of this repository?`)
  }
  const out = new Map<string, Set<number>>()
  // A file not yet tracked is added whole.
  const untracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  for (const f of untracked) {
    try {
      const n = readFileSync(join(root, f), 'utf8').split('\n').length
      out.set(f, new Set(Array.from({ length: n }, (_, i) => i + 1)))
    } catch {}
  }
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

interface Scope {
  config: ReturnType<typeof testsConfig>
  files: string[]
  tests: string[]
  // The test files and lines a check looks at: the diff's with a base, every one without.
  touchedTests: string[]
  added: Map<string, Set<number>> | null
}

function scope(options: CheckOptions): Scope {
  const config = testsConfig(options.data)
  const files = projectFiles(options.root)
  const tests = testFiles(config, files)
  const added = options.base === undefined ? null : addedLines(options.root, options.base)
  return { config, files, tests, added, touchedTests: added ? tests.filter((t) => added.has(t)) : tests }
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

function levels(options: CheckOptions, s: Scope): Result[] {
  if (s.config.levels.length === 0) return [result('levels', 'NOT RUN', null, null, 'tests.levels is not configured')]
  const out: Result[] = []
  const names = s.config.levels.map((l) => l.name).join(', ')
  let problems = 0
  const perLevel = new Map<string, { files: number; tests: number; addedFiles: number; addedTests: number }>()
  for (const level of s.config.levels) perLevel.set(level.name, { files: 0, tests: 0, addedFiles: 0, addedTests: 0 })
  for (const file of s.tests) {
    const lines = read(options.root, file)
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

function comment(line: string): boolean {
  return /^\s*(?:\/\/|\*|\/\*)/.test(line)
}

function focus(options: CheckOptions, s: Scope): Result[] {
  const out: Result[] = []
  for (const file of s.touchedTests) {
    const lines = read(options.root, file)
    lines.forEach((line, i) => {
      if (comment(line)) return
      const n = i + 1
      const code = withoutStrings(line)
      if (ONLY.test(code)) {
        out.push(result('focus', 'FAIL', file, n, '.only: the rest of the file does not run'))
      } else if (SKIP.test(code) && isNew(s, file, n)) {
        out.push(
          result('focus', 'FAIL', file, n, 'a skipped test: fix it or delete it (a skipIf with a reason is fine)'),
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
          at:
            offset +
            (l.indexOf('(', l.search(/\b(?:it|test)\b/)) >= 0 ? l.indexOf('(', l.search(/\b(?:it|test)\b/)) : 0),
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

function rules(options: CheckOptions, s: Scope): Result[] {
  if (s.config.rules.length === 0) return [result('rules', 'NOT RUN', null, null, 'tests.rules is not configured')]
  const out: Result[] = []
  for (const rule of s.config.rules) out.push(...checkRule(options, s, rule))
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
export function recordMissing(root: string, anchor: string): string | null {
  const hash = anchor.indexOf('#')
  const path = hash < 0 ? anchor : anchor.slice(0, hash)
  const fragment = hash < 0 ? undefined : anchor.slice(hash + 1)
  const abs = join(root, path)
  if (!existsSync(abs) || !statSync(abs).isFile()) return 'the record behind the rule is not there'
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
  let fenced = false
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
    if (fenced || !/^#{1,6}\s/.test(line)) continue
    const base = slug(line.replace(/^#{1,6}\s+/, ''))
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs.has(wanted) ? null : `the record has no heading #${fragment}`
}

function checkRule(options: CheckOptions, s: Scope, rule: Rule): Result[] {
  const where = `rule ${rule.name} (${rule.anchor})`
  const missing = recordMissing(options.root, rule.anchor)
  if (missing) return [result('rules', 'FAIL', null, null, `${where}: ${missing}`)]
  if (rule.assertedBy !== null) {
    if (!existsSync(join(options.root, rule.assertedBy))) {
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
    read(options.root, file).forEach((line, i) => {
      if (comment(line) || !pattern.test(line) || !isNew(s, file, i + 1)) return
      found.push(result('rules', 'FAIL', file, i + 1, `${where}: ${rule.message ?? `matches ${rule.pattern}`}`))
    })
  }
  return found.length > 0 ? found : [result('rules', 'PASS', null, null, `${where}: ${files.length} files, no match`)]
}

// ---- touched ---------------------------------------------------------------------

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

// Lines run (count above zero) by file, from an lcov report, keyed by absolute path.
export function parseLcov(text: string, base: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let current: Set<number> | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3).trim()
      current = new Set()
      out.set(path.startsWith('/') ? path : join(base, path), current)
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

// The lines one test file runs, by coverage, or null when its level has none.
function coverageOf(
  level: Level,
  test: string,
  scratchRoot: string,
  out: string,
  cache: Map<string, Map<string, Set<number>> | null>,
): Map<string, Set<number>> | null {
  const hit = cache.get(test)
  if (hit !== undefined) return hit
  let lines: Map<string, Set<number>> | null = null
  if (level.coverage !== null) {
    const dir = mkdtempSync(join(out, 'cov-'))
    runCommand(commandFor(level.coverage, level, [test], dir), join(scratchRoot, level.cwd), level.timeoutSeconds)
    const lcov = join(dir, 'lcov.info')
    if (existsSync(lcov)) lines = parseLcov(readFileSync(lcov, 'utf8'), join(scratchRoot, level.cwd))
  }
  cache.set(test, lines)
  return lines
}

function touched(options: CheckOptions, s: Scope): Result[] {
  if (s.added === null) return [result('touched', 'NOT RUN', null, null, 'needs --base: the lines the diff changes')]
  if (s.config.levels.length === 0) return [result('touched', 'NOT RUN', null, null, 'tests.levels is not configured')]
  const changed = [...s.added.entries()].filter(
    ([f, lines]) => SOURCE.test(f) && lines.size > 0 && !s.tests.includes(f),
  )
  if (changed.length === 0) return [result('touched', 'PASS', null, null, 'the diff changes no source line')]
  const graph = new ImportGraph(options.root, new Set(s.files))
  const useCoverage = s.config.levels.some((l) => l.coverage !== null)
  const scratch = useCoverage ? createScratch(options.root) : null
  const out = scratch ? mkdtempSync(join(tmpdir(), 'lntt-cov-')) : ''
  const cache = new Map<string, Map<string, Set<number>> | null>()
  try {
    return changed.map(([file, lines]) => {
      if (!existsSync(join(options.root, file))) return result('touched', 'INFO', file, null, 'deleted')
      const groups: Candidate[] = candidates(options.root, s.config, s.files, file, graph)
      const all = groups.flatMap((g) => g.files)
      if (all.length === 0) {
        return result('touched', 'INFO', file, null, `lines ${ranges([...lines])}: no test imports this file`)
      }
      const hits = new Map<string, string[]>()
      let viaCoverage = true
      for (const g of groups) {
        for (const test of g.files) {
          const covered = scratch ? coverageOf(g.level, test, scratch.root, out, cache) : null
          if (covered === null) {
            viaCoverage = false
            continue
          }
          const run = [...covered.entries()].find(
            ([abs]) => abs.endsWith(`/${file}`) || abs === join(scratch?.root ?? '', file),
          )
          for (const n of lines) if (run?.[1].has(n)) hits.set(`${n}`, [...(hits.get(`${n}`) ?? []), test])
        }
      }
      if (!viaCoverage) {
        return result(
          'touched',
          'INFO',
          file,
          null,
          `lines ${ranges([...lines])}: tests that import it, from imports (no coverage for their level): ${all.join(', ')}`,
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
    })
  } finally {
    scratch?.dispose()
    if (out) rmSync(out, { recursive: true, force: true })
  }
}

// ---- mutate ----------------------------------------------------------------------

function mutateCheck(options: CheckOptions, s: Scope, args: string[]): Result[] {
  const [anchor, ...extra] = args
  const m = anchor === undefined ? null : ANCHOR_LINE.exec(anchor)
  const { mutation } = options
  if (!m || extra.length > 0 || !mutation) {
    throw new CannotRunError('mutate needs one path:line, --text <what is on the line> and --to <what it becomes>')
  }
  return mutateAll({ root: options.root, data: options.data, files: s.files }, [
    { path: m[1] as string, line: Number(m[2]), text: mutation.text, to: mutation.to },
  ]).results
}

export function runTests(check: string | undefined, args: string[], options: CheckOptions): Result[] {
  // A project that has not described its tests is not asked to: `lntt check` alone passes
  // over it (an explicit check still runs).
  if (check === undefined && options.data.tests === undefined) {
    return [result('levels', 'NOT RUN', null, null, 'the configuration has no tests section')]
  }
  const s = scope(options)
  if (check === 'mutate') return mutateCheck(options, s, args)
  const all: Record<string, () => Result[]> = {
    levels: () => levels(options, s),
    focus: () => focus(options, s),
    rules: () => rules(options, s),
    touched: () => touched(options, s),
  }
  if (check !== undefined) return (all[check] as () => Result[])()
  return Object.values(all).flatMap((run) => run())
}
