import { readFile } from 'node:fs/promises'
import { glob } from 'glob'
import { expect } from 'vitest'

/**
 * Guards against over-serialization of React Router 7 loader/action returns.
 *
 * Why this exists (ADR-0002 — loader/action serialization boundary): in RR7 the
 * value a loader/action returns is serialized *whole* (turbo-stream) and shipped
 * to the browser — inline in the SSR HTML and again in every `.data` request. A
 * field is in the payload even if no component reads it, so checking client-side
 * consumption protects nothing. The footgun is `return { ...entity }`: it flattens
 * every column of a domain/DB row (passwordHash, tokens, internal flags, another
 * user's data pulled in by a join) into the wire payload. TypeScript does not help
 * at runtime — annotating the return type does not strip excess keys (the
 * excess-property check only fires on object literals); only a runtime projection
 * (an explicit read-view/DTO literal, or a schema `.parse()`) actually removes them.
 *
 * This scanner is the arch-test net for that rule. Routes already cannot import
 * `#app/domain` / `#app/lib/db` (import boundaries), so a domain/DB type cannot be
 * named directly in a route; the residual leak is *structural* — spreading a value
 * whose inferred type is an entity into the returned object. This flags exactly
 * that: an object-literal spread (`{ ...x }`, `{ a, ...x }`, `{ user: { ...x } }`)
 * anywhere inside a `return` expression.
 *
 * Like {@link getImports}, it is a pragmatic text scan, not a TS-AST walk: it
 * tracks strings/comments and bracket nesting so it distinguishes an object spread
 * from an array spread (`[...arr]`) or a call spread (`f(...args)`), and only looks
 * inside `return` expressions so a header merge (`{ ...init.headers }`) outside a
 * return is not flagged.
 *
 * Known limit — it is a syntactic early-warning, not a proof: hoisting the spread
 * out of the return (`const dto = { ...user }; return dto`) evades it. The per-route
 * golden test is the airtight net (it pins the actual payload's key set regardless
 * of how the object was built). Escalate to an AST/dataflow walk only if this
 * syntactic net proves insufficient — not to relax the rule.
 */

const DEFAULT_TEST_IGNORE = ['**/*.spec.ts', '**/*.test.ts']

export interface ReturnSpreadViolation {
  /** Absolute path of the offending file. */
  file: string
  /** 1-based line of the `return` that carries the spread. */
  line: number
  /** The offending source line, trimmed, for the failure message. */
  snippet: string
}

export interface NoReturnSpreadOptions {
  /**
   * Absolute glob for the layer's source files
   * (e.g. `resolve(__dirname, 'routes/**\/*.{ts,tsx}')`).
   */
  pattern: string
  /** Layer name shown in violation messages (e.g. `'routes'`). */
  layer?: string
  /** Extra ignore globs, merged with the default `*.spec.ts`/`*.test.ts` excludes. */
  ignore?: string[]
}

const IDENT = /[A-Za-z0-9_$]/

/**
 * Scans one file's source and returns every object-literal spread that sits
 * inside a `return` expression. Exported for unit testing; prefer
 * {@link assertNoEntitySpreadInReturn} in arch specs.
 *
 * Single linear pass: it tracks strings and `//` / `/* *\/` comments so the
 * `return` keyword is only recognised as real code (not, say, the word inside a
 * "non-return" comment), and tracks bracket nesting so a spread is only flagged
 * when its nearest enclosing bracket — opened *within* the return expression —
 * is an object literal `{`.
 */
export function findReturnSpreads(source: string): ReturnSpreadViolation[] {
  const violations: ReturnSpreadViolation[] = []
  const lines = source.split('\n')

  const stack: string[] = []
  let inString: string | null = null // "'" | '"' | '`'
  let inLineComment = false
  let inBlockComment = false
  let line = 1

  // Return-tracking state: while `inReturn`, watch for a property-position
  // spread until the statement ends (a `;` at the return's base depth, or a
  // closing bracket that pops the stack below it).
  let inReturn = false
  let returnLine = 0
  let returnBaseDepth = 0
  let prevCode = '' // last non-comment, non-string code char (for the word boundary)

  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    const next = source[i + 1]
    if (c === '\n') line++

    if (inLineComment) {
      if (c === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      if (c === '\\')
        i++ // skip the escaped char
      else if (c === inString) inString = null
      continue
    }

    if (c === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c
      prevCode = c
      continue
    }

    // Recognise the `return` keyword only in code, at a real word boundary.
    if (
      c === 'r' &&
      source.startsWith('return', i) &&
      !IDENT.test(prevCode) &&
      prevCode !== '.' &&
      !IDENT.test(source[i + 6] ?? '')
    ) {
      inReturn = true
      returnLine = line
      returnBaseDepth = stack.length
      i += 5 // consume the rest of "return"; the loop's i++ lands past it
      prevCode = 'n'
      continue
    }

    if (c === '{' || c === '(' || c === '[') {
      stack.push(c)
      prevCode = c
      continue
    }
    if (c === '}' || c === ')' || c === ']') {
      stack.pop()
      if (inReturn && stack.length < returnBaseDepth) inReturn = false
      prevCode = c
      continue
    }
    if (c === ';' && inReturn && stack.length === returnBaseDepth) {
      inReturn = false
      prevCode = c
      continue
    }

    // A spread whose nearest enclosing bracket is an object literal `{` opened
    // inside the return expression is the over-serialization footgun.
    if (c === '.' && next === '.' && source[i + 2] === '.') {
      if (inReturn && stack.length > returnBaseDepth && stack[stack.length - 1] === '{') {
        violations.push({
          file: '',
          line: returnLine,
          snippet: (lines[returnLine - 1] ?? '').trim(),
        })
        inReturn = false // one hit per return is enough to fail the file
      }
      i += 2
      prevCode = '.'
      continue
    }

    if (!/\s/.test(c)) prevCode = c
  }

  return violations
}

/**
 * Auto-discovers a layer's source files and asserts none spread a value into a
 * returned object literal (the `return { ...entity }` over-serialization footgun,
 * ADR-0002 — loader/action serialization boundary). Mirrors
 * {@link assertLayerBoundaries}: it throws when the glob matches no files, so a
 * moved folder fails loudly instead of passing vacuously.
 *
 * @example
 * ```ts
 * await assertNoEntitySpreadInReturn({
 *   pattern: resolve(APP, 'routes/**\/*.{ts,tsx}'),
 *   layer: 'routes',
 * })
 * ```
 */
export async function assertNoEntitySpreadInReturn(opts: NoReturnSpreadOptions): Promise<void> {
  const ignore = [...DEFAULT_TEST_IGNORE, ...(opts.ignore ?? [])]
  const files = await glob(opts.pattern, { ignore })
  if (files.length === 0) {
    throw new Error(`No files matched pattern: ${opts.pattern}`)
  }
  const layer = opts.layer ?? 'routes'

  const violations: ReturnSpreadViolation[] = []
  for (const file of files) {
    let content: string
    try {
      content = await readFile(file, 'utf-8')
    } catch (e) {
      throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
    for (const v of findReturnSpreads(content)) {
      violations.push({ ...v, file })
    }
  }

  const message =
    `${layer}: object-literal spread found in a loader/action return — this over-serializes ` +
    `the whole entity to the browser (ADR-0002 — loader/action serialization boundary). ` +
    `Return an explicit, flat read-view/DTO literal instead of \`return { ...entity }\`:\n` +
    violations.map((v) => `  - ${v.file}:${v.line}  ${v.snippet}`).join('\n')

  expect(violations, message).toEqual([])
}
