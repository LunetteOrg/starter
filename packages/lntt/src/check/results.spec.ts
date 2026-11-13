import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { citeResult, citeTarget, citeText, failed, formatJson, formatText, type Result } from './results.ts'

const paths = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const ROOT = '/repo'

describe('cite', () => {
  it('reads a heading anchor, a line range, a column, a list and a leading ./ as the line they name', () => {
    for (const [anchor, line] of [
      ['./src/app.ts', 3],
      ['src/app.ts:3-4', null],
      ['src/app.ts:3:7', null],
      ['src/app.ts:3–4', null],
      ['src/app.ts:3,1', null],
    ] as const) {
      assert.deepStrictEqual(citeTarget(paths, ROOT, anchor, line), { file: '/repo/src/app.ts', at: 3 }, anchor)
    }
    assert.deepStrictEqual(citeTarget(paths, ROOT, 'docs/adr/storage.md#decision', null), {
      file: '/repo/docs/adr/storage.md',
      at: null,
    })
    assert.deepStrictEqual(citeTarget(paths, ROOT, '/repo/src/app.ts', 1), { file: '/repo/src/app.ts', at: 1 })
    assert.deepStrictEqual(citeTarget(paths, ROOT, '../outside.ts', 1), { file: null, at: 1 })
    assert.deepStrictEqual(citeTarget(paths, ROOT, '/tmp/outside.ts', 1), { file: null, at: 1 })
  })

  it('what a line reads, trimmed; a line past the end, or no file, is missing; a path alone has no text', () => {
    const text = '// one\n  export const answer = 42\n'
    assert.deepStrictEqual(citeText(text, 2), { text: 'export const answer = 42' })
    assert.deepStrictEqual(citeText(text, null), { text: null })
    assert.deepStrictEqual(citeText(text, 9), { missing: 'no line 9: the file has 2 lines', what: 'line' })
    assert.deepStrictEqual(citeText('one', 0), { missing: 'no line 0: the file has 1 line', what: 'line' })
    assert.deepStrictEqual(citeText(null, 1), { missing: 'no such file', what: 'file' })
    assert.deepStrictEqual(citeResult('a.ts', 9, citeText(null, 9)), {
      area: 'cite',
      check: 'line',
      status: 'FAIL',
      path: 'a.ts',
      line: 9,
      message: 'no such file',
    })
  })
})

describe('the reports', () => {
  const results: Result[] = [
    { area: 'decisions', check: 'index', status: 'PASS', path: null, line: null, message: 'ok' },
    { area: 'decisions', check: 'names', status: 'FAIL', path: 'docs/adr/a.md', line: 1, message: 'bad' },
    { area: 'tests', check: 'touched', status: 'NOT RUN', path: null, line: null, message: 'needs --base' },
    { area: 'tests', check: 'levels', status: 'INFO', path: 'a.test.ts', line: null, message: 'figures' },
  ]

  it('the text lists what needs someone first, then the counts', () => {
    assert.strictEqual(
      formatText(results),
      [
        'FAIL     decisions/names  docs/adr/a.md:1 — bad',
        'NOT RUN  tests/touched — needs --base',
        'INFO     tests/levels  a.test.ts — figures',
        'PASS     decisions/index — ok',
        'lntt check: 1 PASS, 1 FAIL, 1 NOT RUN',
        '',
      ].join('\n'),
    )
    assert.ok(failed(results))
    assert.ok(!failed(results.filter((r) => r.status !== 'FAIL')))
  })

  it('the JSON is one result per line, in the order of the checks', () => {
    assert.deepStrictEqual(
      formatJson(results)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
      results,
    )
  })
})
