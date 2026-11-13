import { assert, describe, it } from '@effect/vitest'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { filesAt, fixture } from '../testing/fixtures.ts'
import {
  describeOutcome,
  failureOf,
  type Mutation,
  mutate,
  mutated,
  type Outcome,
  problem,
  type TestRun,
  TestRunner,
  testEnv,
} from './mutate.ts'

// The scratch worktree's project root, holding the mutate fixture.
const SCRATCH = '/scratch/tree'
const UNIT = { tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}' }] } }

const passes: TestRun = { code: 0, output: 'ok', timedOut: false }
const failsWith = (test: string, message: string): TestRun => ({
  code: 1,
  output: `▶ suite\n  ✖ ${test} (1.2ms)\n    ${message}\n`,
  timedOut: false,
})
const hangs: TestRun = { code: null, output: '', timedOut: true }

// A test file's run, given what a file of the scratch reads now.
type Behaviour = (read: (path: string) => string) => TestRun

// The mutate fixture in memory, `extra` laid over it, and a TestRunner that runs each test file as
// `behaviours` says (a file with none passes), recording each command and its working directory.
function world(extra: Record<string, string> = {}, behaviours: Record<string, Behaviour> = {}) {
  const { '.agents/config.jsonc': _, ...texts } = fixture('tests/mutate')
  const fs = filesAt(SCRATCH, { ...texts, ...extra })
  const ran: { command: string; cwd: string; timeout: number }[] = []
  const read = (path: string) => fs.files.get(`${SCRATCH}/${path}`)?.text ?? ''
  const runner = TestRunner.of({
    run: (command, cwd, timeout) =>
      Effect.sync(() => {
        ran.push({ command, cwd, timeout: Duration.toSeconds(timeout) })
        const file = /'([^']+)'/.exec(command)?.[1] ?? ''
        return (behaviours[file] ?? (() => passes))(read)
      }),
  })
  const layer = Layer.mergeAll(fs.layer, Path.layer, Layer.succeed(TestRunner)(runner))
  const run = (
    mutation: Partial<Mutation> & Pick<Mutation, 'path' | 'line' | 'text' | 'to'>,
    data: Record<string, unknown> = UNIT,
  ) => mutate(SCRATCH, data, { tests: ['test/price.test.ts'], ...mutation }).pipe(Effect.provide(layer))
  return { fs, ran, read, run, files: () => ran.map((r) => /'([^']+)'/.exec(r.command)?.[1]) }
}

// price.test.ts as the fixture's: it fails when the label of a big basket changes.
const priceTest: Behaviour = (read) =>
  read('src/price.ts').includes("'big' : 'small'")
    ? passes
    : failsWith('a small basket is small', "AssertionError: Expected values to be strictly equal: 'big' !== 'small'")

describe('a mutation', () => {
  it.effect('a test that fails on it kills it, with the failing test and its message; the file is restored', () =>
    Effect.gen(function* () {
      const w = world({}, { 'test/price.test.ts': priceTest })
      const before = w.read('src/price.ts')
      const outcome = yield* w.run({ path: 'src/price.ts', line: 7, text: "'big' : 'small'", to: "'small' : 'big'" })
      assert.deepStrictEqual(outcome, {
        outcome: 'killed',
        test: 'a small basket is small',
        message: "AssertionError: Expected values to be strictly equal: 'big' !== 'small'",
        ran: ['test/price.test.ts'],
      })
      assert.strictEqual(w.read('src/price.ts'), before)
      // With the mutation, then without it, to see that the file passes there.
      assert.deepStrictEqual(w.files(), ['test/price.test.ts', 'test/price.test.ts'])
    }),
  )

  it.effect('no test failing on it: it survived, naming the files that ran', () =>
    Effect.gen(function* () {
      const w = world({}, { 'test/price.test.ts': priceTest })
      assert.deepStrictEqual(yield* w.run({ path: 'src/price.ts', line: 7, text: 'total > 100', to: 'total >= 100' }), {
        outcome: 'survived',
        ran: ['test/price.test.ts'],
      })
    }),
  )

  it.effect('a line of a non-code file is killed by the test file the author names, and only that one runs', () =>
    Effect.gen(function* () {
      const w = world(
        {},
        {
          'test/skill.test.ts': (read) =>
            read('skills/review/SKILL.md').includes('Never merge')
              ? passes
              : failsWith('the review skill forbids merging', 'AssertionError: no'),
        },
      )
      const outcome = yield* w.run({
        path: 'skills/review/SKILL.md',
        line: 6,
        text: 'Never merge',
        to: 'Always merge',
        tests: ['test/skill.test.ts'],
      })
      assert.strictEqual(outcome.outcome, 'killed')
      assert.deepStrictEqual([...new Set(w.files())], ['test/skill.test.ts'])
    }),
  )

  it.effect('the mutated text is written as it is: $& and $1 are not replacement patterns', () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const w = world(
        {},
        {
          'test/price.test.ts': (read) => {
            seen.push(read('src/price.ts').split('\n')[14] ?? '')
            return passes
          },
        },
      )
      yield* w.run({ path: 'src/price.ts', line: 15, text: "'a'", to: "'$&$1'" })
      assert.match(seen[0] as string, /'\$&\$1'/)
    }),
  )
})

describe('what a mutation refuses', () => {
  const notRun = (outcome: Outcome) => (outcome.outcome === 'not run' ? outcome.reason : `${outcome.outcome}`)

  it.effect('a test file that is gone, outside the project, or in no level is NOT RUN, naming it', () =>
    Effect.gen(function* () {
      const w = world()
      const at = { path: 'src/price.ts', line: 7, text: 'total > 100', to: 'x' }
      assert.strictEqual(
        notRun(yield* w.run({ ...at, tests: ['test/gone.test.ts'] })),
        '--test test/gone.test.ts: no such file in the project',
      )
      for (const test of ['../outside.test.ts', '/etc/hosts', 'test/../src/price.ts']) {
        assert.match(notRun(yield* w.run({ ...at, tests: [test] })), /no such file in the project/, test)
      }
      assert.strictEqual(
        notRun(yield* w.run({ ...at, tests: ['src/orphan.ts'] })),
        '--test src/orphan.ts: no level of tests.levels has this file',
      )
      assert.deepStrictEqual(w.ran, [])
    }),
  )

  it.effect('a text that is not on the line, or is on it twice, a line or a file that is not there', () =>
    Effect.gen(function* () {
      const w = world()
      assert.strictEqual(
        notRun(yield* w.run({ path: 'src/price.ts', line: 7, text: 'total < 100', to: 'x' })),
        `src/price.ts:7 does not contain "total < 100"; the line reads "return total > 100 ? 'big' : 'small'"`,
      )
      assert.match(
        notRun(yield* w.run({ path: 'src/price.ts', line: 3, text: 'total', to: 'n' })),
        /is 2 times on src\/price\.ts:3/,
      )
      assert.match(
        notRun(yield* w.run({ path: 'src/price.ts', line: 99, text: 'x', to: 'y' })),
        /the file has \d+ lines/,
      )
      assert.strictEqual(
        notRun(yield* w.run({ path: 'src/nowhere.ts', line: 1, text: 'x', to: 'y' })),
        'src/nowhere.ts: no such file',
      )
      assert.deepStrictEqual(w.ran, [])
    }),
  )

  it.effect('a path that leaves the project is refused, not followed', () =>
    Effect.gen(function* () {
      const w = world()
      for (const path of ['../outside.ts', '/etc/hosts', 'src/../../outside.ts']) {
        assert.strictEqual(
          notRun(yield* w.run({ path, line: 1, text: 'x', to: 'y' })),
          `${path} is not a path inside the project`,
        )
      }
    }),
  )

  it.effect('no tests.levels, a level with no run, or a run with no {files}: NOT RUN', () =>
    Effect.gen(function* () {
      const w = world()
      const at = { path: 'src/price.ts', line: 7, text: 'total > 100', to: 'total >= 100' }
      assert.strictEqual(notRun(yield* w.run(at, {})), 'tests.levels is not configured')
      const level = (extra: Record<string, unknown>) => ({
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], ...extra }] },
      })
      assert.strictEqual(notRun(yield* w.run(at, level({}))), 'tests.levels unit has no run command')
      assert.strictEqual(
        notRun(yield* w.run(at, level({ run: 'node --test' }))),
        'tests.levels unit: run has no {files}, and mutate runs one test file at a time',
      )
      assert.deepStrictEqual(w.ran, [])
    }),
  )

  it.effect('tests that fail without the mutation prove nothing: NOT RUN, never killed', () =>
    Effect.gen(function* () {
      const w = world(
        {},
        { 'test/price.test.ts': () => failsWith('a small basket is small', "AssertionError: 'tiny'") },
      )
      assert.match(
        notRun(yield* w.run({ path: 'src/price.ts', line: 7, text: "'big' : 'small'", to: "'small' : 'big'" })),
        /^level unit fails without the mutation \(test\/price\.test\.ts: a small basket is small: AssertionError: 'tiny'\)$/,
      )
    }),
  )
})

describe('the test files a mutation runs', () => {
  const at = { path: 'src/price.ts', line: 7, text: 'total > 100', to: 'total >= 100' }
  const tests = {
    'test/first.test.ts': '',
    'test/second.test.ts': '',
    'test/fails.test.ts': '',
    'test/after.test.ts': '',
  }

  it.effect('the named files run in the order given, one at a time, each once, and no other file runs', () =>
    Effect.gen(function* () {
      const w = world(tests)
      const outcome = yield* w.run({
        ...at,
        tests: ['test/second.test.ts', 'test/first.test.ts', 'test/second.test.ts'],
      })
      assert.deepStrictEqual(outcome, { outcome: 'survived', ran: ['test/second.test.ts', 'test/first.test.ts'] })
      assert.deepStrictEqual(w.files(), ['test/second.test.ts', 'test/first.test.ts'])
    }),
  )

  it.effect('two levels run in the order of tests.levels, each with its command and its folder', () =>
    Effect.gen(function* () {
      const w = world(tests)
      const levels = {
        tests: {
          levels: [
            { name: 'a', files: ['test/first.test.ts'], run: 'node --test {files}', timeoutSeconds: 30 },
            { name: 'b', files: ['test/second.test.ts'], run: 'vitest run {files}', cwd: 'test' },
          ],
        },
      }
      const outcome = yield* w.run({ ...at, tests: ['test/second.test.ts', 'test/first.test.ts'] }, levels)
      assert.deepStrictEqual(outcome, { outcome: 'survived', ran: ['test/first.test.ts', 'test/second.test.ts'] })
      assert.deepStrictEqual(w.ran, [
        { command: "node --test 'test/first.test.ts'", cwd: SCRATCH, timeout: 30 },
        { command: "vitest run 'second.test.ts'", cwd: `${SCRATCH}/test`, timeout: 120 },
      ])
    }),
  )

  it.effect('the first file that fails ends the run: the files after it do not run', () =>
    Effect.gen(function* () {
      const w = world(tests, {
        'test/fails.test.ts': (read) =>
          read('src/price.ts').includes('total >= 100') ? failsWith('fails', 'Error: x') : passes,
      })
      const outcome = yield* w.run({ ...at, tests: ['test/fails.test.ts', 'test/after.test.ts'] })
      assert.strictEqual(outcome.outcome, 'killed')
      // `fails` ran twice: with the mutation, then again without it, to see that it passes.
      assert.deepStrictEqual(w.files(), ['test/fails.test.ts', 'test/fails.test.ts'])
    }),
  )

  it.effect('a level repeats its run: a test that fails only its second time kills when repeat is 2', () =>
    Effect.gen(function* () {
      const flaky = (repeat: number) => {
        let runs = 0
        const w = world(tests, {
          'test/first.test.ts': (read) =>
            read('src/price.ts').includes('total >= 100') && ++runs === 2
              ? failsWith('second run', 'Error: x')
              : passes,
        })
        return w.run(
          { ...at, tests: ['test/first.test.ts'] },
          { tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', repeat }] } },
        )
      }
      assert.strictEqual((yield* flaky(1)).outcome, 'survived')
      assert.strictEqual((yield* flaky(2)).outcome, 'killed')
    }),
  )

  it.effect('a hang the mutation causes is a kill, naming the file and its timeout; the other files still run', () =>
    Effect.gen(function* () {
      const w = world(tests, {
        'test/first.test.ts': (read) => (read('src/price.ts').includes('total >= 100') ? hangs : passes),
      })
      const level = {
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', timeoutSeconds: 2 }] },
      }
      const outcome = yield* w.run({ ...at, tests: ['test/first.test.ts', 'test/second.test.ts'] }, level)
      assert.deepStrictEqual(outcome, {
        outcome: 'killed',
        test: 'test/first.test.ts',
        message: 'did not finish in 2s (a hang)',
        ran: ['test/first.test.ts', 'test/second.test.ts'],
      })
      assert.deepStrictEqual(w.files(), ['test/first.test.ts', 'test/second.test.ts', 'test/first.test.ts'])
    }),
  )

  it.effect('a file that hangs without the mutation too is NOT RUN, naming the file', () =>
    Effect.gen(function* () {
      const w = world(tests, { 'test/first.test.ts': () => hangs })
      assert.deepStrictEqual(yield* w.run({ ...at, tests: ['test/first.test.ts'] }), {
        outcome: 'not run',
        reason: 'test/first.test.ts did not finish in 120s, with or without the mutation',
      })
    }),
  )

  it.effect('a file that fails and a file that hangs in one level: the failure is the result', () =>
    Effect.gen(function* () {
      const mutatedOnly = (run: TestRun) => (read: (path: string) => string) =>
        read('src/price.ts').includes('total >= 100') ? run : passes
      const w = world(tests, {
        'test/first.test.ts': mutatedOnly(hangs),
        'test/second.test.ts': mutatedOnly(failsWith('the mode is fast', 'AssertionError: slow')),
      })
      const outcome = yield* w.run({ ...at, tests: ['test/first.test.ts', 'test/second.test.ts'] })
      assert.strictEqual(outcome.outcome === 'killed' && outcome.test, 'the mode is fast')
    }),
  )

  it.effect('an interrupt while the tests run restores the file: the finalizer runs', () =>
    Effect.gen(function* () {
      const fs = filesAt(SCRATCH, { 'src/a.ts': 'export const a = 1\n', 'test/a.test.ts': '' })
      const runner = TestRunner.of({ run: () => Effect.never })
      const fiber = yield* mutate(SCRATCH, UNIT, {
        path: 'src/a.ts',
        line: 1,
        text: '= 1',
        to: '= 2',
        tests: ['test/a.test.ts'],
      }).pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer, Layer.succeed(TestRunner)(runner))), Effect.forkChild)
      yield* Effect.yieldNow
      assert.strictEqual(fs.files.get(`${SCRATCH}/src/a.ts`)?.text, 'export const a = 2\n')
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(fs.files.get(`${SCRATCH}/src/a.ts`)?.text, 'export const a = 1\n')
    }),
  )
})

describe('the pieces of a mutation', () => {
  it('problem says why a mutation cannot apply, null when it can', () => {
    const m = { path: 'a.ts', line: 1, text: 'x', to: 'y', tests: [] }
    assert.strictEqual(problem(m, 'const x = 1\n'), null)
    assert.strictEqual(problem({ ...m, text: '' }, 'const x = 1\n'), 'the text to mutate is empty')
    assert.strictEqual(problem({ ...m, to: 'x' }, 'const x = 1\n'), 'the mutated text is the text: nothing changes')
    assert.strictEqual(problem({ ...m, path: '' }, 'x'), ' is not a path inside the project')
  })

  it('mutated replaces the text on its line only', () => {
    assert.strictEqual(mutated('a\nx = x\nx\n', { path: 'f', line: 2, text: 'x', to: 'y', tests: [] }), 'a\ny = x\nx\n')
  })

  it('the tests start without what makes a nested node --test a child of the one that runs lntt', () => {
    assert.deepStrictEqual(testEnv({ PATH: '/bin', NODE_TEST_CONTEXT: 'child', NODE_TEST_X: '1' }), {
      PATH: '/bin',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    })
  })

  it('an outcome as a result: killed passes, survived fails, the rest is not run', () => {
    const m = { path: 'a.ts', line: 1, text: 'x', to: 'y', tests: [] }
    assert.deepStrictEqual(describeOutcome(m, { outcome: 'killed', test: 't', message: 'm', ran: ['a'] }), {
      status: 'PASS',
      message: '"x" → "y" killed by t: m',
    })
    assert.deepStrictEqual(describeOutcome(m, { outcome: 'survived', ran: ['a', 'b'] }), {
      status: 'FAIL',
      message: '"x" → "y" survived: 2 test files still pass (a, b)',
    })
    assert.deepStrictEqual(describeOutcome(m, { outcome: 'not run', reason: 'why' }), {
      status: 'NOT RUN',
      message: '"x" → "y": why',
    })
  })
})

describe('failureOf', () => {
  it('reads the first failing test and its message from node:test, vitest and tap output', () => {
    assert.deepStrictEqual(failureOf('▶ suite\n  ✖ adds up (1.2ms)\n    AssertionError: Expected 3\n'), {
      test: 'adds up',
      message: 'AssertionError: Expected 3',
    })
    assert.deepStrictEqual(failureOf(' FAIL  src/a.spec.ts > adds up\nAssertionError: expected 2 to be 3\n'), {
      test: 'src/a.spec.ts > adds up',
      message: 'AssertionError: expected 2 to be 3',
    })
    assert.deepStrictEqual(failureOf('not ok 2 - adds up\n  ---\n  error: boom\n'), {
      test: 'adds up',
      message: 'error: boom',
    })
  })

  it('a duration after the test name, in or out of parentheses, is not part of it', () => {
    assert.strictEqual(failureOf(' × adds up 3ms\n AssertionError: expected 2 to be 3\n').test, 'adds up')
    assert.strictEqual(failureOf('  ✖ adds up (1.2ms)\n').test, 'adds up')
  })

  it('says so when the output names no test, with the last lines as the message', () => {
    const f = failureOf('starting\nexploded\n')
    assert.strictEqual(f.test, '(not named in the output)')
    assert.strictEqual(f.message, 'starting | exploded')
  })
})
