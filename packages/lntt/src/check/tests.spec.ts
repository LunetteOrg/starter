import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { Git } from '../git/git.ts'
import { filesAt, fixture } from '../testing/fixtures.ts'
import { TestRunner } from './mutate.ts'
import type { Result } from './results.ts'
import {
  addedLinesOf,
  focus,
  levels,
  parseLcov,
  recordMissing,
  rules,
  runTests,
  scopeOf,
  touched,
  touchedResult,
} from './tests.ts'
import { memoryTree, type Tree } from './tree.ts'

const ROOT = '/repo'

// No test runs and no scratch is made: a check that tried would die.
const NOTHING_RUNS = Layer.mergeAll(
  Git.memory({}),
  Layer.succeed(TestRunner)(TestRunner.of({ run: () => Effect.die('no test runs here') })),
)

// A fixture of test/fixtures/tests: its texts, less its configuration, and its configuration's data.
function project(name: string): { texts: Record<string, string>; data: Record<string, unknown> } {
  const { '.agents/config.jsonc': config, ...texts } = fixture(`tests/${name}`)
  return { texts, data: JSON.parse(config as string) }
}

// Every line of each file added, as for a file the diff adds whole.
const whole = (texts: Record<string, string>, files: string[]) =>
  new Map(files.map((f) => [f, new Set((texts[f] as string).split('\n').map((_, i) => i + 1))]))

const scope = (
  texts: Record<string, string>,
  data: Record<string, unknown>,
  added: Map<string, Set<number>> | null = null,
) => scopeOf(data, memoryTree(ROOT, texts), added)

const fails = (list: Result[], check: string) =>
  list
    .filter((r) => r.check === check && r.status === 'FAIL')
    .map((r) => `${r.path}:${r.line}`)
    .sort()

describe('lntt check tests levels', () => {
  it('passes on tests each at one level, and reports the pyramid as information', () => {
    const { texts, data } = project('clean')
    const results = levels(scope(texts, data))
    assert.deepStrictEqual(
      results.filter((x) => x.status === 'PASS').map((x) => x.message),
      ['1 test files, each at exactly one level (unit, component, integration) and opening its harness'],
    )
    assert.deepStrictEqual(
      results.filter((x) => x.status === 'INFO').map((x) => x.message),
      [
        'unit (node): 1 tests in 1 files',
        'component (jsdom): 0 tests in 0 files',
        'integration (node and a real Postgres): 0 tests in 0 files',
      ],
    )
  })

  it('fails a file at no level, a file at two, and a test that does not open its harness', () => {
    const { texts, data } = project('defects')
    const results = levels(scope(texts, data))
    assert.deepStrictEqual(fails(results, 'levels'), [
      'test/integration/no-harness.test.ts:1',
      'test/misc/stray.test.ts:1',
      'test/ui/shared.test.tsx:1',
    ])
    const messages = results.map((x) => x.message).join('\n')
    assert.match(messages, /at no level \(unit, component, component-extra, integration\)/)
    assert.match(messages, /at 2 levels \(component, component-extra\)/)
    assert.match(messages, /does not open its harness \(tx, withTestDb\)/)
  })

  it('tests.ignore takes a file out; a jsdom test that stubs a Web API is listed, never failed', () => {
    const { texts, data } = project('defects')
    const results = levels(scope(texts, data))
    assert.ok(!results.some((x) => x.path === 'test/misc/helper.test.ts'))
    const stub = results.find((x) => x.status === 'INFO' && x.path === 'test/ui/stub.test.tsx')
    assert.strictEqual(stub?.line, 5)
    assert.match(stub?.message ?? '', /candidate: a component test that stubs a Web API/)
  })

  it('with a base the pyramid says what the diff adds to each level', () => {
    const { texts, data } = project('clean')
    const more = {
      ...texts,
      'test/unit/more.test.ts': "import { test } from 'node:test'\ntest('a', () => {})\ntest('b', () => {})\n",
    }
    const results = levels(scope(more, data, whole(more, ['test/unit/more.test.ts'])))
    assert.ok(results.some((x) => x.message === 'unit (node): 3 tests in 2 files; the diff adds 2 tests in 1 files'))
  })

  it('without tests.levels it is NOT RUN, never a silent pass', () => {
    const { texts } = project('clean')
    assert.deepStrictEqual(
      levels(scope(texts, {})).map((x) => `${x.status} ${x.message}`),
      ['NOT RUN tests.levels is not configured'],
    )
  })
})

describe('lntt check tests focus', () => {
  it('passes on tests that run and assert', () => {
    const { texts, data } = project('clean')
    assert.strictEqual(focus(scope(texts, data))[0]?.status, 'PASS')
  })

  it('finds a .only, a .skip, a todo and a test with no assertion, at their lines', () => {
    const { texts, data } = project('defects')
    const results = focus(scope(texts, data))
    assert.deepStrictEqual(fails(results, 'focus'), [
      'test/unit/focus.test.ts:13',
      'test/unit/focus.test.ts:15',
      'test/unit/focus.test.ts:5',
      'test/unit/focus.test.ts:9',
    ])
    const at = (line: number) => results.find((x) => x.line === line)?.message
    assert.match(at(5) ?? '', /\.only/)
    assert.match(at(9) ?? '', /skipped/)
    assert.match(at(13) ?? '', /todo/)
    assert.match(at(15) ?? '', /no assertion/)
  })

  it('a run-time t.skip with a written reason passes, one without a reason fails', () => {
    const { texts, data } = project('clean')
    const run = (skip: string) =>
      fails(
        focus(
          scope(
            {
              ...texts,
              'test/unit/runtime.test.ts': `import assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('x', (t) => {\n  ${skip}\n  assert.ok(true)\n})\n`,
            },
            data,
          ),
        ),
        'focus',
      )
    assert.deepStrictEqual(run("t.skip('the free model is at its usage limit')"), [])
    assert.deepStrictEqual(run(`t.skip(\`the limit: \${reason}\`)`), [])
    assert.deepStrictEqual(run('t.skip()'), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run("t.skip('')"), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run("t.skip('  ')"), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run('t.skip(reason)'), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run(`t.skip(\`\${reason}\`)`), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run("t.skip('why'); t.skip()"), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run("t.skip('why'); test.skip('x', () => {})"), ['test/unit/runtime.test.ts:4'])
    assert.deepStrictEqual(run("t.skip('a'); t.skip('b')"), [])
    assert.deepStrictEqual(run("t.skip('skip: true, so say the notes')"), [])
  })

  it("with a base, a skip or a todo that was already there is not the diff's", () => {
    const { texts, data } = project('defects')
    const added = { ...texts, 'test/unit/new.test.ts': "import { test } from 'node:test'\ntest.skip('x', () => {})\n" }
    // the file the diff touches only: new.test.ts, whose skip is new
    assert.deepStrictEqual(fails(focus(scope(added, data, whole(added, ['test/unit/new.test.ts']))), 'focus'), [
      'test/unit/new.test.ts:2',
    ])
  })

  it("a defect on a line the diff did not add is the diff's only when it is a .only", () => {
    const { texts, data } = project('defects')
    const last = (f: string) => (texts[f] as string).split('\n').length
    const added = new Map([
      ['test/unit/focus.test.ts', new Set([last('test/unit/focus.test.ts')])],
      ['test/unit/mocks.test.ts', new Set([last('test/unit/mocks.test.ts')])],
    ])
    const s = scope(texts, data, added)
    assert.deepStrictEqual(fails(focus(s), 'focus'), ['test/unit/focus.test.ts:5'])
    assert.ok(!rules(s).some((x) => x.path === 'test/unit/mocks.test.ts'))
  })
})

describe('lntt check tests rules', () => {
  it('finds what a rule forbids, cites what the suite already asserts, fails a rule whose record is gone', () => {
    const { texts, data } = project('defects')
    const results = rules(scope(texts, data))
    assert.deepStrictEqual(
      results.filter((x) => x.status === 'FAIL').map((x) => `${x.path}:${x.line}`),
      ['test/unit/mocks.test.ts:4', 'null:null'],
    )
    const mock = results.find((x) => x.path === 'test/unit/mocks.test.ts')
    assert.match(
      mock?.message ?? '',
      /rule module-mock \(docs\/adr\/test\.md#3-no-module-mocks\): no module-level vi\.mock/,
    )
    const cited = results.find((x) => x.status === 'INFO')
    assert.strictEqual(cited?.path, 'test/unit/waits.arch.test.ts')
    assert.match(
      cited?.message ?? '',
      /rule bare-wait .* is asserted by test\/unit\/waits\.arch\.test\.ts: not checked again/,
    )
    // waiting.test.ts holds the pattern bare-wait forbids, and the rule is not run on it
    assert.ok(!results.some((x) => x.path === 'test/unit/waiting.test.ts'))
    assert.match(results.map((x) => x.message).join('\n'), /orphan-record .*the record behind the rule is not there/)
  })

  it('the heading of an anchor has to be in the record', () => {
    const { texts, data } = project('defects')
    const messages = (record: string) =>
      rules(scope({ ...texts, 'docs/adr/test.md': record }, data))
        .map((x) => x.message)
        .join('\n')
    assert.match(messages('# Tests\n\n## 4. Waits\n'), /module-mock .*the record has no heading #3-no-module-mocks/)
    assert.notMatch(messages('# Tests\n\n## 3. No module mocks\n\n## 4. Waits\n'), /no heading/)
  })

  it('an anchor is a file, or a file and a heading in any case, a repeat numbered, a fence no heading', () => {
    const record =
      '# Tests\n\n## 3. No module mocks\n\n## Waits\n\n## Waits\n\n```\n# Not a heading\n```\n\n## After a fence\n\n~~~\n# Tilde\n```\n# Mixed\n~~~\n\n````\n```\n# Long\n```js\n# Info\n````\n\n## A [link heading](http://x) ##\n\n## no_module_mocks\n\n  ## Indented\n\n```code``` is a paragraph\n\n## After a paragraph\n\n  ```\n# Indented fence\n  ```\n\n  ````\n  ```\n# Closes only on a long enough run\n  ```js\n# Info\n  ````\n\n## Last\n\n    ## Code block\n\n##\n\n##\n\n  ````\n    ```` \n# Four spaces do not close\n  ```` \n\n## Closed with trailing space\n\n## Before an open fence\n\n```\n# Never closed\n'
    const tree: Tree = memoryTree(ROOT, { 'docs/adr/test.md': record, 'docs/adr/other.md': '# Other\n' })
    const anchors: Record<string, boolean> = {
      'docs/adr/test.md': true,
      'docs/adr/test.md#': true,
      'docs/adr/test.md#3-No-Module-Mocks': true,
      'docs/adr/test.md#waits-1': true,
      'docs/adr/test.md#after-a-fence': true,
      'docs/adr/test.md#no_module_mocks': true,
      'docs/adr/test.md#tilde': false,
      'docs/adr/test.md#mixed': false,
      'docs/adr/test.md#long': false,
      'docs/adr/test.md#info': false,
      'docs/adr/test.md#before-an-open-fence': true,
      'docs/adr/test.md#never-closed': false,
      'docs/adr/test.md#indented': true,
      'docs/adr/test.md#after-a-paragraph': true,
      'docs/adr/test.md#indented-fence': false,
      'docs/adr/test.md#closes-only-on-a-long-enough-run': false,
      'docs/adr/test.md#last': true,
      'docs/adr/test.md#code-block': false,
      'docs/adr/test.md#-1': true,
      'docs/adr/test.md#four-spaces-do-not-close': false,
      'docs/adr/test.md#closed-with-trailing-space': true,
      'docs/adr/test.md#waits#1': false,
      'docs/adr/test.md#a-link-heading': true,
      'docs/adr/test.md#waits-2': false,
      'docs/adr/test.md#not-a-heading': false,
      'docs/adr/test.md#100%': false,
      'docs/adr': false,
    }
    for (const [anchor, ok] of Object.entries(anchors)) {
      assert.strictEqual(recordMissing(tree, anchor) === null, ok, anchor)
    }
    // A malformed escape in a fragment is a missing heading, never an exception.
    assert.match(recordMissing(tree, 'docs/adr/other.md#100%') ?? '', /no heading #100%/)
  })
})

describe('lntt check tests touched', () => {
  const COVERAGE = 'node --test --test-reporter=lcov --test-reporter-destination={out}/lcov.info {files}'
  const levelsWith = (coverage?: string) => ({
    tests: {
      levels: [
        { name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', ...(coverage ? { coverage } : {}) },
      ],
    },
  })
  // `touched` with no coverage, as a review round asks it, over the mutate fixture with `changed`
  // laid over it and the lines of `added`.
  const fromImports = (
    data: Record<string, unknown>,
    changed: Record<string, string>,
    added: Map<string, Set<number>>,
  ) => {
    const texts = { ...project('mutate').texts, ...changed }
    return touched({ root: ROOT, data, base: 'HEAD~1', coverage: false }, scope(texts, data, added)).pipe(
      Effect.provide(Layer.mergeAll(Path.layer, filesAt(ROOT, texts).layer, NOTHING_RUNS)),
    )
  }

  it.effect('needs a base', () =>
    Effect.gen(function* () {
      const results = yield* touched({ root: ROOT, data: levelsWith() }, scope({}, levelsWith())).pipe(
        Effect.provide(Layer.mergeAll(Path.layer, filesAt(ROOT, {}).layer, NOTHING_RUNS)),
      )
      assert.deepStrictEqual(
        results.map((x) => `${x.status} ${x.message}`),
        ['NOT RUN needs --base: the lines the diff changes'],
      )
    }),
  )

  it.effect('asked for no coverage, the tests come from imports and the message says which is the case', () =>
    Effect.gen(function* () {
      const added = new Map([['src/price.ts', new Set([1])]])
      const message = (data: Record<string, unknown>) =>
        Effect.map(fromImports(data, {}, added), (list) => list.find((x) => x.path === 'src/price.ts')?.message ?? '')
      assert.match(yield* message(levelsWith(COVERAGE)), /from imports \(coverage not run\): test\/price\.test\.ts/)
      assert.match(yield* message(levelsWith()), /from imports \(no coverage for their level\): test\/price\.test\.ts/)
    }),
  )

  it.effect('a changed file no test imports, a deleted one, and a diff with no source line', () =>
    Effect.gen(function* () {
      const added = new Map([
        ['src/new-orphan.ts', new Set([1])],
        ['src/gone.ts', new Set<number>()],
        ['src/removed.ts', new Set([1])],
        ['docs/note.md', new Set([1])],
      ])
      const results = yield* fromImports(levelsWith(), { 'src/new-orphan.ts': 'export const flag = false\n' }, added)
      assert.deepStrictEqual(
        results.map((x) => `${x.path} ${x.message}`),
        ['src/new-orphan.ts lines 1: no test imports this file', 'src/removed.ts deleted'],
      )
      const none = yield* fromImports(levelsWith(), {}, new Map([['docs/note.md', new Set([1])]]))
      assert.deepStrictEqual(
        none.map((x) => `${x.status} ${x.message}`),
        ['PASS the diff changes no source line'],
      )
    }),
  )

  it('from coverage: which tests run each changed line, and which lines no test runs', () => {
    const groups = [{ level: { name: 'unit' } as never, files: ['test/a.test.ts', 'test/b.test.ts'] }]
    const covered = (test: string) =>
      new Map([['/scratch/src/price.ts', new Set(test === 'test/a.test.ts' ? [1, 2] : [2])]])
    assert.strictEqual(
      touchedResult('src/price.ts', new Set([1, 2, 3, 4]), groups, covered, '/scratch', false).message,
      'lines 1: test/a.test.ts; lines 2: test/a.test.ts, test/b.test.ts; lines 3-4: no test runs them',
    )
  })
})

describe('what the checks read', () => {
  it('a diff with no context gives the lines each file gains; a new file is added whole', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@',
      '+x',
      '+y',
      '@@ -9,0 +11 @@',
      '+z',
      'diff --git a/gone.ts b/gone.ts',
      '+++ /dev/null',
    ].join('\n')
    assert.deepStrictEqual(
      [...addedLinesOf(diff, [['new.ts', 2]]).entries()].map(([f, lines]) => [f, [...lines]]),
      [
        ['new.ts', [1, 2]],
        ['src/a.ts', [3, 4, 11]],
      ],
    )
  })

  it('an lcov report gives the lines run of each file, a relative path read from the base', () => {
    const lcov = 'SF:/abs/a.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:src/b.ts\nDA:3,4\nend_of_record\n'
    const p = { join: (...parts: string[]) => parts.join('/') }
    assert.deepStrictEqual(
      [...parseLcov(p, lcov, '/base').entries()].map(([f, lines]) => [f, [...lines]]),
      [
        ['/abs/a.ts', [1]],
        ['/base/src/b.ts', [3]],
      ],
    )
  })

  it.effect('lntt check alone passes over a project with no tests section; a check named runs', () =>
    Effect.gen(function* () {
      const { texts } = project('clean')
      const run = (check: string | undefined) =>
        runTests(check, { root: ROOT, data: {} }, memoryTree(ROOT, texts)).pipe(
          Effect.provide(Layer.mergeAll(Path.layer, filesAt(ROOT, texts).layer, NOTHING_RUNS)),
        )
      assert.deepStrictEqual(
        (yield* run(undefined)).map((x) => `${x.status} ${x.message}`),
        ['NOT RUN the configuration has no tests section'],
      )
      assert.deepStrictEqual(
        (yield* run('levels')).map((x) => `${x.status} ${x.message}`),
        ['NOT RUN tests.levels is not configured'],
      )
    }),
  )
})
