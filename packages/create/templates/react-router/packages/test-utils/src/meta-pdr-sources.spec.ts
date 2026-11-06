import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A PDR cites `docs/` and `compliance/`, never `reference/`
 * (docs/adr/product-and-reference-spaces.md — the rule on sources).
 *
 * `reference/` holds raw and intermediate material that gets new versions or goes
 * stale; a decision that links it ages with it, and its reader has to open the
 * working document to understand it. A fact a PDR needs from there is written in
 * the PDR, in words.
 *
 * The rule covers the PDR's text, not its Storybook review page, which embeds the
 * prototype and the legacy "before" from `reference/`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// packages/test-utils/src → repo root
const REPO_ROOT = resolve(__dirname, '../../..')
const DECISIONS = 'docs/product/decisions'

/**
 * The PDRs written before the rule that still cite `reference/`, waiting to be
 * cleaned. The list only shrinks: a file leaves it the day its last citation of
 * `reference/` goes, and a new PDR never enters it. Empty in a new project.
 */
const WAITING_FOR_CLEANUP: string[] = []

/** A path into `reference/`, as a relative link (`../../../reference/…`) or in prose. */
const REFERENCE_PATH = /(?<![\w-])reference\//g

/** The lines of `source` that cite a path into `reference/`. */
function referenceCitationsIn(source: string): number[] {
  return [...source.matchAll(REFERENCE_PATH)].map(
    (m) => source.slice(0, m.index).split('\n').length,
  )
}

/**
 * Every markdown file in the PDR log, the template included: a new PDR starts as a
 * copy of it, so the template citing `reference/` would make every new PDR fail.
 */
function pdrs(): string[] {
  return readdirSync(resolve(REPO_ROOT, DECISIONS))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${DECISIONS}/${name}`)
    .sort()
}

/** The PDRs held to the rule: every one but those waiting to be cleaned. */
function checked(): string[] {
  return pdrs().filter((path) => !WAITING_FOR_CLEANUP.includes(path))
}

function citations(path: string): string[] {
  return referenceCitationsIn(readFileSync(resolve(REPO_ROOT, path), 'utf8')).map(
    (line) => `${path}:${line}`,
  )
}

describe('a PDR cites docs/ and compliance/, never reference/', () => {
  it('checks the PDR log, its template included — otherwise the path stopped matching', () => {
    expect(checked()).toContain(`${DECISIONS}/template.md`)
  })

  it('no PDR outside the cleanup list cites reference/', () => {
    const found = checked().flatMap(citations)
    expect(
      found,
      `These PDRs cite reference/. Write the fact they need in the PDR, or cite ` +
        `docs/ or compliance/ instead (docs/adr/product-and-reference-spaces.md):\n` +
        found.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([])
  })

  it('every PDR in the cleanup list exists and still cites reference/ — a clean one leaves the list', () => {
    const clean = WAITING_FOR_CLEANUP.filter(
      (path) => !existsSync(resolve(REPO_ROOT, path)) || citations(path).length === 0,
    )
    expect(
      clean,
      `Remove these from WAITING_FOR_CLEANUP: they are gone or no longer cite reference/:\n` +
        clean.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([])
  })
})

describe('the citation finder reports what it should, and only that', () => {
  it('finds a relative link and a path in prose, with their lines', () => {
    const source =
      'line one\n[the dump](../../../reference/db-dumps/schema.sql)\nand `reference/legacy/x.php`\n'
    expect(referenceCitationsIn(source)).toEqual([2, 3])
  })

  it('does not take compliance/ or a word ending in reference for a citation', () => {
    const source =
      '[statute](../../../compliance/statute/x.md)\ncross-reference/ and myreference/\n'
    expect(referenceCitationsIn(source)).toEqual([])
  })
})
