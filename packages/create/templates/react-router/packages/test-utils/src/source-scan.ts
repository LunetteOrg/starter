import { readFile } from 'node:fs/promises'
import { glob } from 'glob'
import { expect } from 'vitest'

/**
 * Generic source-text arch assertion: fails when a forbidden pattern appears in
 * a layer's source. Complements {@link assertLayerBoundaries} (which scans
 * *imports*) for rules that are about *code*, not dependencies — e.g. `throw new
 * Error()` (use `errore` typed errors instead) or `process.env` outside
 * `config/env.ts` (ADR-0002).
 *
 * These rules are also enforced by Biome (`noRestrictedGlobals`, a grit plugin),
 * so the same violation fails both lint and this test — two nets, mirroring the
 * import-boundary design. Like {@link getImports} it throws on an empty glob, so
 * a moved folder fails loudly instead of passing vacuously.
 *
 * Matches run against a copy of the source with comment and string-literal
 * contents blanked out (newlines preserved), so a rule name mentioned in a
 * comment or a message string is not a false positive.
 */

const DEFAULT_TEST_IGNORE = ['**/*.spec.ts', '**/*.test.ts']

export interface SourceRule {
  /** Pattern that must NOT appear in the layer's code. */
  regex: RegExp
  /** Explanation shown in the violation message. */
  message: string
}

export interface SourcePatternViolation {
  file: string
  line: number
  snippet: string
  message: string
}

export interface NoSourcePatternOptions {
  /** Absolute glob for the layer's source files. */
  pattern: string
  /** Layer name shown in violation messages. */
  layer: string
  /** Rules to enforce; a file matching any of them is a violation. */
  forbidden: SourceRule[]
  /** Extra ignore globs, merged with the default `*.spec.ts`/`*.test.ts` excludes. */
  ignore?: string[]
}

/**
 * Returns a copy of `source` with the *contents* of line/block comments and
 * string/template literals replaced by spaces (newlines kept, so line numbers
 * are preserved). Exported for testing.
 */
export function blankCommentsAndStrings(source: string): string {
  const out: string[] = []
  let inString: string | null = null
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    const next = source[i + 1]
    const keep = c === '\n' ? '\n' : ' '

    if (inLineComment) {
      if (c === '\n') inLineComment = false
      out.push(c === '\n' ? '\n' : ' ')
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        out.push('  ')
        i++
      } else {
        out.push(keep)
      }
      continue
    }
    if (inString) {
      if (c === '\\') {
        out.push('  ')
        i++
      } else if (c === inString) {
        inString = null
        out.push(c) // keep the closing quote as-is
      } else {
        out.push(keep)
      }
      continue
    }

    if (c === '/' && next === '/') {
      inLineComment = true
      out.push('  ')
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      out.push('  ')
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c
      out.push(c) // keep the opening quote as-is
      continue
    }
    out.push(c)
  }

  return out.join('')
}

/** Scans one file's source for forbidden patterns. Exported for testing. */
export function findSourceMatches(
  source: string,
  forbidden: SourceRule[],
): Omit<SourcePatternViolation, 'file'>[] {
  const scrubbed = blankCommentsAndStrings(source)
  const rawLines = source.split('\n')
  const scrubbedLines = scrubbed.split('\n')
  const violations: Omit<SourcePatternViolation, 'file'>[] = []

  for (const rule of forbidden) {
    scrubbedLines.forEach((line, idx) => {
      // Fresh regex per test to avoid lastIndex state on /g patterns.
      if (new RegExp(rule.regex.source, rule.regex.flags.replace('g', '')).test(line)) {
        violations.push({
          line: idx + 1,
          snippet: (rawLines[idx] ?? '').trim(),
          message: rule.message,
        })
      }
    })
  }
  return violations
}

/**
 * Auto-discovers a layer's source files and asserts none contains a forbidden
 * pattern.
 *
 * @example
 * ```ts
 * await assertNoSourcePattern({
 *   pattern: resolve(APP, '**\/*.{ts,tsx}'),
 *   layer: 'app',
 *   forbidden: [{ regex: /\bthrow\s+new\s+\w*Error\b/, message: 'Use errore typed errors.' }],
 *   ignore: ['config/env.ts'],
 * })
 * ```
 */
export async function assertNoSourcePattern(opts: NoSourcePatternOptions): Promise<void> {
  const ignore = [...DEFAULT_TEST_IGNORE, ...(opts.ignore ?? [])]
  const files = await glob(opts.pattern, { ignore })
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${opts.pattern}`)
  }

  const violations: SourcePatternViolation[] = []
  for (const file of files) {
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch (e) {
      throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
    for (const v of findSourceMatches(content, opts.forbidden)) {
      violations.push({ ...v, file })
    }
  }

  const message =
    `${opts.layer}: forbidden source pattern(s) found:\n` +
    violations.map((v) => `  - ${v.file}:${v.line}  ${v.snippet}\n    → ${v.message}`).join('\n')

  expect(violations, message).toEqual([])
}
