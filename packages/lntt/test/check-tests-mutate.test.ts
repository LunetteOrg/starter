import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Result } from '../src/check.ts'
import { failureOf } from '../src/mutate.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const FIXTURE = join(HERE, 'fixtures/tests/mutate')

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
}

function project(): void {
  cpSync(FIXTURE, repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

// One mutation through the CLI: the result it prints and its exit status.
function mutate(anchor: string, text: string, to: string): { status: number | null; result: Result } {
  const r = spawnSync(
    process.execPath,
    [BIN, 'check', 'tests', 'mutate', anchor, `--text=${text}`, `--to=${to}`, '--json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) } },
  )
  return { status: r.status, result: JSON.parse(r.stdout.split('\n')[0] as string) as Result }
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-mutate-test-')))
  project()
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('lntt check tests mutate', () => {
  test('a mutation a test fails on is killed: PASS, with the failing test and its message', () => {
    const { status, result } = mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'")
    assert.equal(status, 0)
    assert.equal(result.status, 'PASS')
    assert.equal(result.path, 'src/price.ts')
    assert.equal(result.line, 7)
    assert.match(result.message, /killed by a small basket is small: .*(Expected values|small)/)
  })

  test('a mutation no test fails on survived: FAIL, naming the tests that still pass', () => {
    const { status, result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(status, 1)
    assert.equal(result.status, 'FAIL')
    assert.match(result.message, /survived: 1 test file still pass \(test\/price\.test\.ts\)/)
  })

  test('a line no test imports survives: no test runs it', () => {
    const { status, result } = mutate('src/orphan.ts:1', 'true', 'false')
    assert.equal(status, 1)
    assert.match(result.message, /survived: no test runs this line/)
  })

  test('uncommitted tests count: a new test file kills what the committed ones let live', () => {
    writeFileSync(
      join(repo, 'test/boundary.test.ts'),
      [
        "import assert from 'node:assert/strict'",
        "import { test } from 'node:test'",
        "import { label } from '../src/price.ts'",
        "test('one hundred is small', () => {",
        "  assert.equal(label(100), 'small')",
        '})',
        '',
      ].join('\n'),
    )
    const { status, result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(status, 0)
    assert.match(result.message, /killed by one hundred is small/)
  })

  test('the working tree is never left mutated: killed, survived or refused', () => {
    const before = readFileSync(join(repo, 'src/price.ts'), 'utf8')
    for (const [anchor, text, to] of [
      ['src/price.ts:7', "'big' : 'small'", "'small' : 'big'"],
      ['src/price.ts:7', 'total > 100', 'total >= 100'],
      ['src/price.ts:7', 'not on the line', 'x'],
    ] as const) {
      mutate(anchor, text, to)
      assert.equal(readFileSync(join(repo, 'src/price.ts'), 'utf8'), before)
      assert.equal(git('status', '--porcelain'), '')
      // the scratch worktree is gone too
      assert.equal(git('worktree', 'list').split('\n').length, 1)
    }
  })

  test('a text that is not on the line, or is on it twice, is NOT RUN, naming what the line reads', () => {
    const missing = mutate('src/price.ts:7', 'total < 100', 'x').result
    assert.equal(missing.status, 'NOT RUN')
    assert.match(
      missing.message,
      /does not contain "total < 100"; the line reads "return total > 100 \? 'big' : 'small'"/,
    )
    const twice = mutate('src/price.ts:3', 'total', 'n').result
    assert.equal(twice.status, 'NOT RUN')
    assert.match(twice.message, /is 2 times on src\/price\.ts:3/)
    assert.equal(mutate('src/price.ts:99', 'x', 'y').result.status, 'NOT RUN')
    assert.equal(mutate('src/nowhere.ts:1', 'x', 'y').result.status, 'NOT RUN')
  })

  test('tests that fail without the mutation prove nothing: NOT RUN, never killed', () => {
    writeFileSync(
      join(repo, 'test/price.test.ts'),
      readFileSync(join(repo, 'test/price.test.ts'), 'utf8').replace("label(50), 'small'", "label(50), 'tiny'"),
    )
    git('commit', '-qam', 'break a test')
    const { status, result } = mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'")
    // NOT RUN is not a FAIL: the exit status stays 0, as for every check
    assert.equal(status, 0)
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /level unit fails without the mutation/)
  })

  test('a path that leaves the project is refused, not followed', () => {
    for (const anchor of ['../outside.ts:1', '/etc/hosts:1', 'src/../../outside.ts:1']) {
      const { result } = mutate(anchor, 'x', 'y')
      assert.equal(result.status, 'NOT RUN', anchor)
      assert.match(result.message, /is not a path inside the project/)
    }
  })

  test('the mutated text is written as it is: $& and $1 are not replacement patterns', () => {
    const { result } = mutate('src/price.ts:15', "'a'", "'$&'")
    assert.equal(result.status, 'PASS', result.message)
    assert.match(result.message, /killed by a tag is a or b/)
  })

  test('a level repeats its run: a test that fails only the second time kills when repeat is 2', () => {
    writeFileSync(
      join(repo, 'test/flaky.test.ts'),
      [
        "import assert from 'node:assert/strict'",
        "import { appendFileSync, readFileSync } from 'node:fs'",
        "import { test } from 'node:test'",
        "import { next } from '../src/price.ts'",
        "test('fails on its second run only', () => {",
        "  appendFileSync('.runs', 'x')",
        "  assert.notEqual(readFileSync('.runs', 'utf8').length, 2)",
        '  next(1)',
        '})',
        '',
      ].join('\n'),
    )
    const level = (repeat: number) =>
      JSON.stringify({
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', repeat }] },
      })
    git('add', '-A')
    writeFileSync(join(repo, '.agents/config.jsonc'), level(1))
    assert.match(mutate('src/price.ts:11', 'n + 1', 'n - 1').result.message, /survived/)
    writeFileSync(join(repo, '.agents/config.jsonc'), level(2))
    const killed = mutate('src/price.ts:11', 'n + 1', 'n - 1').result
    assert.equal(killed.status, 'PASS', killed.message)
    assert.match(killed.message, /killed by fails on its second run only/)
  })

  test('tests that outlast timeoutSeconds are NOT RUN, never killed or survived', () => {
    const levels = [
      { name: 'unit', files: ['test/*.test.ts'], run: 'sleep 3 && node --test {files}', timeoutSeconds: 1 },
    ]
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ tests: { levels } }))
    const { result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /level unit did not finish in 1s/)
  })

  test('a project with no tests.levels cannot run a mutation', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{}\n')
    assert.match(mutate('src/price.ts:7', 'total > 100', 'x').result.message, /tests\.levels is not configured/)
  })

  test('usage errors: a mutation needs path:line, --text and --to', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, 'check', 'tests', 'mutate', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(run('src/price.ts').status, 2)
    assert.equal(run('src/price.ts:7', '--text=x').status, 2)
    assert.equal(run('--text=x', '--to=y').status, 2)
    assert.equal(spawnSync(process.execPath, [BIN, 'check', 'tests', 'focus', '--text=x'], { cwd: repo }).status, 2)
  })
})

describe('failureOf', () => {
  test('reads the first failing test and its message from node:test, vitest and tap output', () => {
    assert.deepEqual(failureOf('▶ suite\n  ✖ adds up (1.2ms)\n    AssertionError: Expected 3\n'), {
      test: 'adds up',
      message: 'AssertionError: Expected 3',
    })
    assert.deepEqual(failureOf(' FAIL  src/a.spec.ts > adds up\nAssertionError: expected 2 to be 3\n'), {
      test: 'src/a.spec.ts > adds up',
      message: 'AssertionError: expected 2 to be 3',
    })
    assert.deepEqual(failureOf('not ok 2 - adds up\n  ---\n  error: boom\n'), {
      test: 'adds up',
      message: 'error: boom',
    })
  })

  test('a duration after the test name, in or out of parentheses, is not part of it', () => {
    assert.equal(failureOf(' × adds up 3ms\n AssertionError: expected 2 to be 3\n').test, 'adds up')
    assert.equal(failureOf('  ✖ adds up (1.2ms)\n').test, 'adds up')
  })

  test('says so when the output names no test, with the last lines as the message', () => {
    const f = failureOf('starting\nexploded\n')
    assert.equal(f.test, '(not named in the output)')
    assert.equal(f.message, 'starting | exploded')
  })
})
