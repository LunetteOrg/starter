// The project's tests as `tests.levels` describes them: which files are tests, the level
// each sits at, and which tests run a given source file (from imports; coverage refines
// that in check-tests.ts). Shared by `lntt check tests` and by `mutate`.

import { existsSync, readFileSync } from 'node:fs'
import { join, matchesGlob, posix } from 'node:path'

export interface Level {
  name: string
  files: string[]
  exclude: string[]
  environment: string | null
  harness: string[]
  run: string | null
  coverage: string | null
  cwd: string
  repeat: number
  timeoutSeconds: number
}

export interface Rule {
  name: string
  pattern: string
  files: string[]
  message: string | null
  anchor: string
  assertedBy: string | null
}

export interface TestsConfig {
  levels: Level[]
  rules: Rule[]
  ignore: string[]
  assertions: string[]
}

type Raw = Partial<Record<string, unknown>>

// The `tests` section, with its defaults; no section is no levels and no rules.
export function testsConfig(data: Record<string, unknown>): TestsConfig {
  const tests = (data.tests ?? {}) as { levels?: Raw[]; rules?: Raw[]; ignore?: string[]; assertions?: string[] }
  return {
    ignore: tests.ignore ?? [],
    assertions: tests.assertions ?? [],
    levels: (tests.levels ?? []).map((l) => ({
      name: l.name as string,
      files: l.files as string[],
      exclude: (l.exclude as string[] | undefined) ?? [],
      environment: (l.environment as string | undefined) ?? null,
      harness: (l.harness as string[] | undefined) ?? [],
      run: (l.run as string | undefined) ?? null,
      coverage: (l.coverage as string | undefined) ?? null,
      cwd: (l.cwd as string | undefined) ?? '.',
      repeat: (l.repeat as number | undefined) ?? 1,
      timeoutSeconds: (l.timeoutSeconds as number | undefined) ?? 600,
    })),
    rules: (tests.rules ?? []).map((r) => ({
      name: r.name as string,
      pattern: r.pattern as string,
      files: (r.files as string[] | undefined) ?? [],
      message: (r.message as string | undefined) ?? null,
      anchor: r.anchor as string,
      assertedBy: (r.assertedBy as string | undefined) ?? null,
    })),
  }
}

export function inLevel(level: Level, file: string): boolean {
  return level.files.some((g) => matchesGlob(file, g)) && !level.exclude.some((g) => matchesGlob(file, g))
}

// What names a test file whatever the levels say, so a test no level takes is found.
const TEST_NAME = ['**/*.test.*', '**/*.spec.*']

export function isTestFile(config: TestsConfig, file: string): boolean {
  if (config.ignore.some((g) => matchesGlob(file, g))) return false
  return TEST_NAME.some((g) => matchesGlob(file, g)) || config.levels.some((l) => inLevel(l, file))
}

// The levels a test file sits at: exactly one is right.
export function levelsOf(config: TestsConfig, file: string): Level[] {
  return config.levels.filter((l) => inLevel(l, file))
}

// Files that cannot hold a test: data a test file's name may sit in.
const NOT_CODE = /\.(md|json|jsonc|ya?ml|txt|snap|png|svg|css)$/

export function testFiles(config: TestsConfig, files: string[]): string[] {
  return files.filter((f) => !NOT_CODE.test(f) && isTestFile(config, f))
}

const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

// A relative specifier resolved to a file of the project, as TypeScript run directly
// writes it (`./x.ts`) or as a bundler does (`./x`, `./x.js` for x.ts).
function resolveSpecifier(from: string, specifier: string, known: Set<string>): string | null {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier))
  const stem = base.replace(/\.(m|c)?js$/, '')
  for (const candidate of [
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => stem + e),
    ...EXTENSIONS.map((e) => `${base}/index${e}`),
  ]) {
    if (known.has(candidate)) return candidate
  }
  return null
}

// Every relative path a file names in a string: an import, a dynamic import, a require,
// or the path a test hands to the process it spawns (`resolve(HERE, '../bin/x.ts')`).
const SPECIFIER = /['"`](\.{1,2}\/[^'"`\s]+)['"`]/g

export function importsOf(root: string, file: string, known: Set<string>): string[] {
  let text: string
  try {
    text = readFileSync(join(root, file), 'utf8')
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const m of text.matchAll(SPECIFIER)) {
    const target = resolveSpecifier(file, m[1] as string, known)
    if (target && target !== file) out.add(target)
  }
  return [...out]
}

// For each file of the project, the files it reaches through those references.
export class ImportGraph {
  private readonly edges = new Map<string, string[]>()
  private readonly closures = new Map<string, Set<string>>()
  private readonly root: string
  private readonly known: Set<string>

  constructor(root: string, known: Set<string>) {
    this.root = root
    this.known = known
  }

  closure(file: string): Set<string> {
    const cached = this.closures.get(file)
    if (cached) return cached
    const seen = new Set<string>([file])
    const queue = [file]
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      let out = this.edges.get(next)
      if (!out) {
        out = importsOf(this.root, next, this.known)
        this.edges.set(next, out)
      }
      for (const target of out) {
        if (!seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
    }
    this.closures.set(file, seen)
    return seen
  }
}

export interface Candidate {
  level: Level
  files: string[]
}

// The tests that can run `file`, grouped by level: the test files whose imports reach
// it. A test file is its own candidate.
export function candidates(
  root: string,
  config: TestsConfig,
  projectFiles: string[],
  file: string,
  graph = new ImportGraph(root, new Set(projectFiles)),
): Candidate[] {
  const tests = testFiles(config, projectFiles).filter((t) => existsSync(join(root, t)))
  const out: Candidate[] = []
  for (const level of config.levels) {
    const files = tests.filter((t) => levelsOf(config, t)[0] === level && graph.closure(t).has(file))
    if (files.length > 0) out.push({ level, files })
  }
  return out
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// A level's command for these files, which `cwd` makes relative.
export function commandFor(template: string, level: Level, files: string[], out?: string): string {
  const relative = files.map((f) => (level.cwd === '.' ? f : posix.relative(level.cwd, f)))
  return template
    .replaceAll('{files}', relative.map(shellQuote).join(' '))
    .replaceAll('{out}', out === undefined ? '' : shellQuote(out))
}
