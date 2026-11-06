import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * A PDR cites `docs/` and `compliance/`, never `reference/`
 * (docs/adr/product-and-reference-spaces.md#the-rule-on-sources). The rule covers
 * the PDR's text, not its Storybook review page.
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

/**
 * A path into `reference/`: the directory named alone or after `./` and `../`
 * segments, as a link (`../../../reference/x`, `../../reference`) or in prose
 * (`reference/legacy/x.php`). Not a `reference/` segment inside another path
 * (`compliance/reference/x`, a URL), nor a word ending in reference.
 */
const REFERENCE_PATH = /(?<![\w./-])(?:(?:\.\.?\/)*reference\/|(?:\.\.?\/)+reference(?![\w-]))/gi

/** The lines of `source` that cite a path into `reference/`, each once, in order. */
function referenceCitationsIn(source: string): number[] {
  const lines = [...source.matchAll(REFERENCE_PATH)].map(
    (m) => source.slice(0, m.index).split('\n').length,
  )
  return [...new Set(lines)]
}

interface PdrSourcesReport {
  /** The PDRs held to the rule: every one but those waiting to be cleaned. */
  checked: string[]
  /** `path:line` of each citation of `reference/` in a checked PDR. */
  citations: string[]
  /** The entries of the cleanup list that are gone or no longer cite `reference/`. */
  clean: string[]
}

/**
 * Checks the PDR log under `root`: every markdown file in it, at any depth, the
 * template included — a new PDR starts as a copy of it, so the template citing
 * `reference/` would make every new PDR fail.
 */
function checkPdrSources(root: string, waitingForCleanup: string[]): PdrSourcesReport {
  const citing = (path: string) =>
    referenceCitationsIn(readFileSync(resolve(root, path), 'utf8')).map((line) => `${path}:${line}`)
  const pdrs = readdirSync(resolve(root, DECISIONS), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => `${DECISIONS}/${name.split('\\').join('/')}`)
    .sort()
  const checked = pdrs.filter((path) => !waitingForCleanup.includes(path))
  return {
    checked,
    citations: checked.flatMap(citing),
    clean: waitingForCleanup.filter(
      (path) => !existsSync(resolve(root, path)) || citing(path).length === 0,
    ),
  }
}

describe('a PDR cites docs/ and compliance/, never reference/', () => {
  const report = checkPdrSources(REPO_ROOT, WAITING_FOR_CLEANUP)

  it('checks the PDR log, its template included — otherwise the path stopped matching', () => {
    expect(report.checked).toContain(`${DECISIONS}/template.md`)
  })

  it('no PDR outside the cleanup list cites reference/', () => {
    expect(
      report.citations,
      `These PDRs cite reference/. Write the fact they need in the PDR, or cite ` +
        `docs/ or compliance/ instead (docs/adr/product-and-reference-spaces.md):\n` +
        report.citations.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([])
  })

  it('every PDR in the cleanup list exists and still cites reference/ — a clean one leaves the list', () => {
    expect(
      report.clean,
      `Remove these from WAITING_FOR_CLEANUP: they are gone or no longer cite reference/:\n` +
        report.clean.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([])
  })
})

describe('the check reports what it should, and only that', () => {
  let root = ''
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports a citing PDR at any depth with its line, skips other files and the cleanup list, and names a listed PDR that is clean or gone', () => {
    root = mkdtempSync(join(tmpdir(), 'pdr-sources-'))
    write(`${DECISIONS}/template.md`, '# Subject\n\nCite `docs/` and `compliance/`.\n')
    write(
      `${DECISIONS}/onboarding.md`,
      '# Onboarding\n\nSee [the dump](../../../reference/x.sql).\n',
    )
    write(`${DECISIONS}/billing/invoices.md`, '# Invoices\n\nFrom `reference/legacy/inv.php`.\n')
    write(`${DECISIONS}/notes.txt`, 'reference/legacy/x.php\n')
    write(`${DECISIONS}/legacy.md`, '# Legacy\n\n[old](../../../reference/old.php)\n')
    write(`${DECISIONS}/cleaned.md`, '# Cleaned\n\nNothing from there.\n')

    const report = checkPdrSources(root, [
      `${DECISIONS}/legacy.md`,
      `${DECISIONS}/cleaned.md`,
      `${DECISIONS}/gone.md`,
    ])

    expect(report.checked).toEqual([
      `${DECISIONS}/billing/invoices.md`,
      `${DECISIONS}/onboarding.md`,
      `${DECISIONS}/template.md`,
    ])
    expect(report.citations).toEqual([
      `${DECISIONS}/billing/invoices.md:3`,
      `${DECISIONS}/onboarding.md:3`,
    ])
    expect(report.clean).toEqual([`${DECISIONS}/cleaned.md`, `${DECISIONS}/gone.md`])
  })

  it('finds a relative link, a path in prose and the directory linked alone, each line once', () => {
    const source = [
      'line one',
      '[the dump](../../../reference/db-dumps/schema.sql) and [again](../../../reference/x)',
      'and `reference/legacy/x.php`',
      'the [folder](../../reference)',
      'and `./Reference/x`',
    ].join('\n')
    expect(referenceCitationsIn(source)).toEqual([2, 3, 4, 5])
  })

  it('does not take another path, a URL or a word ending in reference for a citation', () => {
    const source = [
      '[statute](../../../compliance/statute/x.md)',
      'cross-reference/ and myreference/ and compliance/reference/x',
      'https://example.com/docs/reference/api and the reference material',
    ].join('\n')
    expect(referenceCitationsIn(source)).toEqual([])
  })
})
