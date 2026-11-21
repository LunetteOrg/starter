import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { Git } from '../git/git.ts'
import { fixture as fixtureAt } from '../testing/fixtures.ts'
import { checkDecisions, decisionBoardRefs, decisionFigures, parseNameStatus } from './decisions.ts'
import type { Result } from './results.ts'
import { memoryTree } from './tree.ts'

const ROOT = '/repo'
const fixture = (name: string) => fixtureAt(`decisions/${name}`)

const ADR = { path: 'docs/adr', index: 'docs/adr/README.md', template: 'docs/adr/template.md' }
const PROCESS = { path: 'docs/process', index: 'docs/process/README.md' }
const CLEAN = { recording: { logs: { adr: ADR, process: PROCESS } } }
// The clean fixture's logs, its process log forbidding board references.
const STRICT = { recording: { logs: { adr: ADR, process: { ...PROCESS, boardReferences: false } } } }

// The repository's answers: `git diff --name-status` of a range, null when it does not resolve.
const git = (nameStatus: string | null = null) => Git.memory({ nameStatus: () => Effect.succeed(nameStatus) })

const provide = <A, E>(effect: Effect.Effect<A, E, Path.Path | Git>, diff: string | null = null) =>
  effect.pipe(Effect.provide(Layer.mergeAll(Path.layer, git(diff))))

// The structure check of `texts`, with `data` as the configuration.
const structure = (
  texts: Record<string, string>,
  data: Record<string, unknown> = CLEAN,
  base?: string,
  diff?: string,
) =>
  provide(
    checkDecisions({ root: ROOT, data, ...(base ? { base } : {}) }, memoryTree(ROOT, texts), { figures: true }),
    diff ?? null,
  )

const fails = (list: Result[]) =>
  list
    .filter((r) => r.status === 'FAIL')
    .map((r) => `${r.check} ${r.path}:${r.line}`)
    .sort()

describe('the structure of the decision logs', () => {
  it.effect('a log with no index is NOT RUN for the index check, never a silent pass', () =>
    Effect.gen(function* () {
      const results = yield* structure(fixture('clean'), { recording: { logs: { process: { path: 'docs/process' } } } })
      const index = results.filter((x) => x.check === 'index')
      assert.deepStrictEqual(
        index.map((x) => x.status),
        ['NOT RUN'],
      )
      assert.match((index[0] as Result).message, /recording\.logs\.process has no index/)
    }),
  )

  it.effect('a project with no recording section is NOT RUN', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        (yield* structure(fixture('clean'), {})).map((x) => [x.status, x.message]),
        [['NOT RUN', 'no recording section in the configuration']],
      )
    }),
  )

  it.effect("externalReferences: files citing another project's records are not resolved, a stale glob fails", () =>
    Effect.gen(function* () {
      const texts = { ...fixture('clean'), 'shared/rule.ts': '// The project that installs it: docs/adr/its-own.md\n' }
      assert.deepStrictEqual(fails(yield* structure(texts)), ['references shared/rule.ts:1'])
      const external = (references: Record<string, string>) => ({
        recording: { logs: { adr: ADR }, externalReferences: references },
      })
      const passing = yield* structure(
        texts,
        external({ 'shared/**': 'installed in every project, citing its records' }),
      )
      assert.deepStrictEqual(fails(passing), [])
      assert.match((passing.find((x) => x.check === 'references') as Result).message, /1 citing another project/)
      const stale = yield* structure(
        texts,
        external({ 'shared/**': 'installed in every project', 'gone/**': 'a package since removed' }),
      )
      assert.deepStrictEqual(
        stale.filter((x) => x.status === 'FAIL').map((x) => x.message),
        ['recording.externalReferences["gone/**"] matches no file: remove it'],
      )
    }),
  )

  it.effect('a sentence that ends on a log folder and goes on with a word is not a wrapped path', () =>
    Effect.gen(function* () {
      const notes = (text: string) => structure({ ...fixture('clean'), 'src/notes.ts': text })
      assert.deepStrictEqual(fails(yield* notes('// Records live in docs/adr/\n// and nowhere else.\nexport {}\n')), [])
      assert.deepStrictEqual(fails(yield* notes('// The record is docs/adr/\n// gone-now.md.\nexport {}\n')), [
        'references src/notes.ts:1',
      ])
    }),
  )

  it.effect('a cited folder of a log exists when a file is in it', () =>
    Effect.gen(function* () {
      const texts = {
        ...fixture('clean'),
        'docs/adr/images/flow.svg': '<svg/>',
        'src/notes.ts': '// See docs/adr/images and docs/adr/gone.\n',
      }
      assert.deepStrictEqual(fails(yield* structure(texts)), ['references src/notes.ts:1'])
      assert.match(
        ((yield* structure(texts)).find((x) => x.status === 'FAIL') as Result).message,
        /cites docs\/adr\/gone, which does not exist/,
      )
    }),
  )

  it.effect('status: only a template that lists the statuses says which the log allows', () =>
    Effect.gen(function* () {
      const names = (texts: Record<string, string>) =>
        Effect.map(structure(texts), (list) => list.filter((x) => x.check === 'names'))
      const clean = fixture('clean')
      // A record with no status, against a template that lists them, fails.
      const unstated = yield* names({ ...clean, 'docs/adr/api-shape.md': '# API shape\n' })
      assert.deepStrictEqual(fails(unstated), ['names docs/adr/api-shape.md:1'])
      assert.match((unstated[0] as Result).message, /no status in the frontmatter: one of proposed, accepted/)
      // A template with a status and no list, one with a single status, or none at all: no status
      // is checked, and the report says so.
      const { 'docs/adr/template.md': _, ...noTemplate } = clean
      for (const texts of [
        { ...clean, 'docs/adr/api-shape.md': '# API shape\n', 'docs/adr/template.md': '---\nstatus: proposed\n---\n' },
        {
          ...clean,
          'docs/adr/api-shape.md': '# API shape\n',
          'docs/adr/template.md': '---\nstatus: proposed # proposed\n---\n',
        },
        { ...noTemplate, 'docs/adr/api-shape.md': '# API shape\n' },
      ]) {
        const found = yield* names(texts)
        assert.deepStrictEqual(fails(found), [])
        assert.match((found[0] as Result).message, /no template listing two statuses or more/)
      }
    }),
  )

  it.effect(
    'a number with a mark before the subject, or ADR and a number, fails; a count, a version, a time are words',
    () =>
      Effect.gen(function* () {
        const clean = fixture('clean')
        const title = (t: string) =>
          Effect.map(
            structure({ ...clean, 'docs/adr/api-shape.md': `---\nstatus: proposed\n---\n\n# ${t}\n` }),
            (list) => fails(list).filter((f) => f.startsWith('names')),
          )
        for (const t of [
          '3 retries at most',
          '2.0 migration plan',
          '2.x release',
          '3.js intro',
          '7:30 standup',
          '1.2 Plan',
          '1.record decisions',
          '12 retries',
          '2024 review',
          '1.2.3 Plan',
          '0003 Old thing',
          '2–3 retries',
          '3-way merge',
          '2024-10 review',
          'LADR 5 notes',
          'adr 5 notes',
          `Why \`ADR ${5}\` was dropped`,
          'ADR process',
          '1)storage',
          '1:word',
        ])
          assert.deepStrictEqual(yield* title(t), [], t)
        for (const t of [
          '1. Record decisions',
          '1.Record decisions',
          '1.',
          '7: Caching',
          '7:Caching',
          '7 — Caching',
          '1) Storage',
          '12 — API shape',
          '7 - Caching',
          '7 – Caching',
          '0003—Old thing',
          '0003 — Old thing',
          `ADR ${12} API shape`,
          `PDR-${12} pricing`,
          `ADR#${3} storage`,
          `ADR${12} storage`,
          `Why ADR ${5} matters`,
        ])
          assert.deepStrictEqual(yield* title(t), ['names docs/adr/api-shape.md:5'], t)
        // A code span is not a reference; the rest of the title still is, and the message quotes the
        // title as written.
        const quoted = `Why \`ADR ${5}\` and ADR ${6}`
        assert.deepStrictEqual(yield* title(quoted), ['names docs/adr/api-shape.md:5'])
        const names = (yield* structure({
          ...clean,
          'docs/adr/api-shape.md': `---\nstatus: proposed\n---\n\n# ${quoted}\n`,
        })).filter((x) => x.check === 'names')
        assert.strictEqual((names[0] as Result).message, `the title carries a number: # ${quoted}`)
      }),
  )
})

describe('the decision logs against a base', () => {
  it.effect('the inventory names the records the diff touches, and the figures of those it keeps', () =>
    Effect.gen(function* () {
      const texts = {
        ...fixture('clean'),
        'docs/adr/api-shape.md': `${fixture('clean')['docs/adr/api-shape.md']}\nAbout 120 requests a second.\n`,
      }
      const results = yield* structure(
        texts,
        CLEAN,
        'main',
        'M\tdocs/adr/api-shape.md\nD\tdocs/process/review.md\nR100\tdocs/adr/old.md\tdocs/adr/storage.md\nM\tsrc/app.ts',
      )
      assert.deepStrictEqual(
        results.filter((x) => x.check === 'inventory').map((x) => `${x.path} ${x.message}`),
        [
          'docs/adr/api-shape.md adr record, modified',
          'docs/adr/old.md adr record, renamed from docs/adr/old.md: no longer at this path (now docs/adr/storage.md)',
          'docs/process/review.md process record, deleted: no longer at this path',
          'null 1 other files: src/app.ts',
        ],
      )
      assert.deepStrictEqual(
        results.filter((x) => x.check === 'figures').map((x) => `${x.path}:${x.line}`),
        ['docs/adr/api-shape.md:12', 'docs/adr/storage.md:22'],
      )
    }),
  )

  it.effect('a base whose diff does not run is NOT RUN, for the inventory and for numbers', () =>
    Effect.gen(function* () {
      const inventory = (yield* structure(fixture('clean'), CLEAN, 'nowhere')).find(
        (x) => x.check === 'inventory',
      ) as Result
      assert.strictEqual(inventory.status, 'NOT RUN')
      assert.match(inventory.message, /git diff nowhere\.\.\.HEAD does not run/)
      const numbers = yield* provide(
        decisionFigures({ root: ROOT, data: CLEAN, base: 'nowhere' }, memoryTree(ROOT, fixture('clean')), []),
      )
      assert.deepStrictEqual(
        numbers.map((x) => x.status),
        ['NOT RUN'],
      )
      assert.match((numbers[0] as Result).message, /does not resolve, or has no merge base/)
    }),
  )

  it('git diff --name-status reads as the status, the path, and the path it was renamed from', () => {
    assert.deepStrictEqual(parseNameStatus('A\tnew.md\nR087\ta.md\tb.md\n'), [
      { status: 'A', path: 'new.md', from: null },
      { status: 'R', path: 'b.md', from: 'a.md' },
    ])
  })
})

describe('board references', () => {
  const boardRefs = (texts: Record<string, string>, data: Record<string, unknown> = STRICT) =>
    Effect.map(structure(texts, data), (list) =>
      list.filter((x) => x.check === 'board-refs').map((x) => `${x.status} ${x.path}:${x.line} ${x.message}`),
    )

  it.effect('finds every form of board reference in a log that forbids them, with its line and the reference', () =>
    Effect.gen(function* () {
      const review = [
        '# Review',
        '',
        '- Issue: #168',
        '',
        'Whether a round is repeated is decided by #172.',
        '',
        'The open questions wait in **#244**, and the answer is due in (#241).',
        '',
        'See https://github.com/example/repo/issues/258 and https://github.com/example/repo/pull/301.',
        '',
        'Its diff is https://github.com/example/repo/pull/302.diff.',
        '',
      ].join('\n')
      const cites = (line: number, ref: string) =>
        `FAIL docs/process/review.md:${line} cites the board (${ref}): a record of process cites documents, not issues or pull requests`
      assert.deepStrictEqual(yield* boardRefs({ ...fixture('clean'), 'docs/process/review.md': review }), [
        cites(3, '#168'),
        cites(5, '#172'),
        cites(7, '#244'),
        cites(7, '#241'),
        cites(9, '/issues/258'),
        cites(9, '/pull/301'),
        cites(11, '/pull/302'),
      ])
    }),
  )

  it.effect('anchors, entities, path tails and code are not board references; a log that allows them is not read', () =>
    Effect.gen(function* () {
      const clean = fixture('clean')
      const review = [
        '# Review',
        '',
        '## 1. The boundaries',
        '',
        'Section [1](#1-the-boundaries) is linked by anchor, and so is',
        '[storage](../adr/storage.md#3-two-problems) and [a heading](#12). An entity like &#39; is',
        `not an issue, a color like \`#123456\` is code, and so is \`PDR #${8}\`.`,
        'Nor is #12abc, a bare anchor #1-scope, or a folder like docs/issues/12-notes.md and',
        'a file like docs/pull/7.md.',
        '',
        '```sh',
        'gh issue view #12',
        '```',
        '',
      ].join('\n')
      // The adr log allows them: its #12 is not read; nor is a folder beside the log's, or a file in
      // it that is not Markdown.
      const texts = {
        ...clean,
        'docs/process/review.md': review,
        'docs/adr/storage.md': `${clean['docs/adr/storage.md']}\nDecided in #12.\n`,
        'docs/process-old/notes.md': '# Notes\n\nSee #3.\n',
        'docs/process/owners.txt': 'See #3.\n',
      }
      assert.deepStrictEqual(yield* boardRefs(texts), [
        'PASS null:null no board reference in the 2 files of process (boardReferences: false)',
      ])
    }),
  )

  it.effect('a file below the log folder is read too, the index and .mdx included, its line counted past code', () =>
    Effect.gen(function* () {
      const clean = fixture('clean')
      const texts = {
        ...clean,
        'docs/process/guides/setup.md': '# Setup\n\n```sh\nmake\n```\n\n`a` then #3.\n',
        'docs/process/guides/page.mdx': '# Page\n\nSee #5.\n',
        'docs/process/README.md': `${clean['docs/process/README.md']}\nOpened in #4.\n`,
      }
      const results = yield* provide(decisionBoardRefs({ root: ROOT, data: STRICT }, memoryTree(ROOT, texts), []))
      assert.deepStrictEqual(fails(results), [
        'board-refs docs/process/README.md:7',
        'board-refs docs/process/guides/page.mdx:3',
        'board-refs docs/process/guides/setup.md:7',
      ])
    }),
  )

  it.effect('two logs that forbid them: each reference names its own log', () =>
    Effect.gen(function* () {
      const clean = fixture('clean')
      const both = {
        recording: { logs: { adr: { ...ADR, boardReferences: false }, process: STRICT.recording.logs.process } },
      }
      const texts = {
        ...clean,
        'docs/adr/storage.md': `${clean['docs/adr/storage.md']}\nDecided in #12.\n`,
        'docs/process/review.md': `${clean['docs/process/review.md']}\nSee #3.\n`,
      }
      const results = yield* provide(decisionBoardRefs({ root: ROOT, data: both }, memoryTree(ROOT, texts), []))
      assert.deepStrictEqual(
        results
          .filter((x) => x.status === 'FAIL')
          .map((x) => `${x.path} ${x.message}`)
          .sort(),
        [
          'docs/adr/storage.md cites the board (#12): a record of adr cites documents, not issues or pull requests',
          'docs/process/review.md cites the board (#3): a record of process cites documents, not issues or pull requests',
        ],
      )
    }),
  )

  it.effect('with files, only those of the project in a log that forbids them', () =>
    Effect.gen(function* () {
      const clean = fixture('clean')
      const texts = {
        ...clean,
        'docs/process/review.md': '# Review\n\nSee #3.\n',
        'docs/adr/storage.md': `${clean['docs/adr/storage.md']}\nDecided in #12.\n`,
      }
      const given = (files: string[]) =>
        provide(decisionBoardRefs({ root: ROOT, data: STRICT }, memoryTree(ROOT, texts), files))
      assert.deepStrictEqual(
        fails(yield* given(['docs/process/review.md', 'docs/adr/storage.md', 'gone.md', 'docs/process/gone.md'])),
        ['board-refs docs/process/review.md:3'],
      )
      assert.deepStrictEqual(
        (yield* given(['docs/adr/storage.md'])).map((x) => `${x.status} ${x.message}`),
        ['PASS no board reference in the files given: 0 of 1 in process (boardReferences: false)'],
      )
    }),
  )

  it.effect('no log forbids them: NOT RUN, never a silent pass', () =>
    Effect.gen(function* () {
      const clean = fixture('clean')
      assert.deepStrictEqual(yield* boardRefs({ ...clean, 'docs/process/review.md': 'See #3.\n' }, CLEAN), [
        'NOT RUN null:null no log of recording.logs sets boardReferences: false: no file is read for board references',
      ])
    }),
  )
})

describe('the figures of a record', () => {
  const numbers = (texts: Record<string, string>, paths: string[]) =>
    provide(decisionFigures({ root: ROOT, data: CLEAN }, memoryTree(ROOT, texts), paths))

  it.effect('issue numbers and dates are identifiers; "N of M" is a figure; the frontmatter is not read', () =>
    Effect.gen(function* () {
      const texts = {
        'docs/adr/api-shape.md':
          '---\nstatus: 12\n---\n# API shape\n\nSee #12, decided on 2026-10-01.\n\n3 of 4 calls read.\n',
      }
      assert.deepStrictEqual(
        (yield* numbers(texts, ['docs/adr/api-shape.md'])).map((x) => `${x.status} ${x.line} ${x.message}`),
        ['INFO 8 3 of 4 calls read.'],
      )
    }),
  )

  it.effect('a file that is not there, or a folder, fails', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(fails(yield* numbers(fixture('clean'), ['docs/adr/nope.md', 'docs/adr'])), [
        'figures docs/adr/nope.md:null',
        'figures docs/adr:null',
      ])
    }),
  )
})
