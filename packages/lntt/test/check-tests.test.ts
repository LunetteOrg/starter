import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Result } from '../src/check.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const FIXTURES = join(HERE, 'fixtures/tests')

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
}

function project(fixture: string): void {
  cpSync(join(FIXTURES, fixture), repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

function results(args: string[]): { status: number | null; results: Result[] } {
  const r = spawnSync(process.execPath, [BIN, ...args, '--json'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) },
  })
  return {
    status: r.status,
    results: r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result),
  }
}

function fails(list: Result[], check: string): string[] {
  return list
    .filter((r) => r.check === check && r.status === 'FAIL')
    .map((r) => `${r.path}:${r.line}`)
    .sort()
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-tests-check-')))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('lntt check tests levels', () => {
  test('passes on tests each at one level, and reports the pyramid as information', () => {
    project('clean')
    const r = results(['check', 'tests', 'levels'])
    assert.equal(r.status, 0)
    assert.deepEqual(
      r.results.filter((x) => x.status === 'PASS').map((x) => x.message),
      ['1 test files, each at exactly one level (unit, component, integration) and opening its harness'],
    )
    assert.deepEqual(
      r.results.filter((x) => x.status === 'INFO').map((x) => x.message),
      [
        'unit (node): 1 tests in 1 files',
        'component (jsdom): 0 tests in 0 files',
        'integration (node and a real Postgres): 0 tests in 0 files',
      ],
    )
  })

  test('fails a file at no level, a file at two, and a test that does not open its harness', () => {
    project('defects')
    const r = results(['check', 'tests', 'levels'])
    assert.equal(r.status, 1)
    assert.deepEqual(fails(r.results, 'levels'), [
      'test/integration/no-harness.test.ts:1',
      'test/misc/stray.test.ts:1',
      'test/ui/shared.test.tsx:1',
    ])
    const messages = r.results.map((x) => x.message).join('\n')
    assert.match(messages, /at no level \(unit, component, component-extra, integration\)/)
    assert.match(messages, /at 2 levels \(component, component-extra\)/)
    assert.match(messages, /does not open its harness \(tx, withTestDb\)/)
  })

  test('tests.ignore takes a file out; a jsdom test that stubs a Web API is listed, never failed', () => {
    project('defects')
    const r = results(['check', 'tests', 'levels'])
    assert.ok(!r.results.some((x) => x.path === 'test/misc/helper.test.ts'))
    const stub = r.results.find((x) => x.status === 'INFO' && x.path === 'test/ui/stub.test.tsx')
    assert.equal(stub?.line, 5)
    assert.match(stub?.message ?? '', /candidate: a component test that stubs a Web API/)
  })

  test('with --base the pyramid says what the diff adds to each level', () => {
    project('clean')
    writeFileSync(
      join(repo, 'test/unit/more.test.ts'),
      "import { test } from 'node:test'\ntest('a', () => {})\ntest('b', () => {})\n",
    )
    const r = results(['check', 'tests', 'levels', '--base', 'HEAD'])
    assert.ok(
      r.results.some((x) => x.message === 'unit (node): 3 tests in 2 files; the diff adds 2 tests in 1 files'),
      r.results.map((x) => x.message).join('\n'),
    )
  })

  test('without tests.levels it is NOT RUN, never a silent pass', () => {
    project('clean')
    writeFileSync(join(repo, '.agents/config.jsonc'), '{}\n')
    const r = results(['check', 'tests', 'levels'])
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.message}`),
      ['NOT RUN tests.levels is not configured'],
    )
  })
})

describe('lntt check tests focus', () => {
  test('passes on tests that run and assert', () => {
    project('clean')
    const r = results(['check', 'tests', 'focus'])
    assert.equal(r.status, 0)
    assert.equal(r.results[0]?.status, 'PASS')
  })

  test('finds a .only, a .skip, a todo and a test with no assertion, at their lines', () => {
    project('defects')
    const r = results(['check', 'tests', 'focus'])
    assert.equal(r.status, 1)
    assert.deepEqual(fails(r.results, 'focus'), [
      'test/unit/focus.test.ts:13',
      'test/unit/focus.test.ts:15',
      'test/unit/focus.test.ts:5',
      'test/unit/focus.test.ts:9',
    ])
    const at = (line: number) => r.results.find((x) => x.line === line)?.message
    assert.match(at(5) ?? '', /\.only/)
    assert.match(at(9) ?? '', /skipped/)
    assert.match(at(13) ?? '', /todo/)
    assert.match(at(15) ?? '', /no assertion/)
  })

  test("with --base a skip or a todo that was already there is not the diff's", () => {
    project('defects')
    writeFileSync(join(repo, 'test/unit/new.test.ts'), "import { test } from 'node:test'\ntest.skip('x', () => {})\n")
    const r = results(['check', 'tests', 'focus', '--base', 'HEAD'])
    // the file the diff touches only: new.test.ts, whose skip is new
    assert.deepEqual(fails(r.results, 'focus'), ['test/unit/new.test.ts:2'])
  })
})

describe('lntt check tests with --base', () => {
  test("a defect on a line the diff did not add is the diff's only when it is a .only", () => {
    project('defects')
    // touch focus.test.ts and mocks.test.ts without adding a defect
    for (const f of ['test/unit/focus.test.ts', 'test/unit/mocks.test.ts']) {
      writeFileSync(join(repo, f), `${readFileSync(join(repo, f), 'utf8')}// a comment\n`)
    }
    const focus = results(['check', 'tests', 'focus', '--base', 'HEAD'])
    assert.deepEqual(fails(focus.results, 'focus'), ['test/unit/focus.test.ts:5'])
    const rules = results(['check', 'tests', 'rules', '--base', 'HEAD'])
    assert.ok(!rules.results.some((x) => x.path === 'test/unit/mocks.test.ts'))
  })
})

describe('lntt check tests rules', () => {
  test('finds what a rule forbids, cites what the suite already asserts, fails a rule whose record is gone', () => {
    project('defects')
    const r = results(['check', 'tests', 'rules'])
    assert.equal(r.status, 1)
    assert.deepEqual(
      r.results.filter((x) => x.status === 'FAIL').map((x) => `${x.path}:${x.line}`),
      ['test/unit/mocks.test.ts:4', 'null:null'],
    )
    const mock = r.results.find((x) => x.path === 'test/unit/mocks.test.ts')
    assert.match(
      mock?.message ?? '',
      /rule module-mock \(docs\/adr\/test\.md#3-no-module-mocks\): no module-level vi\.mock/,
    )
    const cited = r.results.find((x) => x.status === 'INFO')
    assert.equal(cited?.path, 'test/unit/waits.arch.test.ts')
    assert.match(
      cited?.message ?? '',
      /rule bare-wait .* is asserted by test\/unit\/waits\.arch\.test\.ts: not checked again/,
    )
    // waiting.test.ts holds the pattern bare-wait forbids, and the rule is not run on it
    assert.ok(!r.results.some((x) => x.path === 'test/unit/waiting.test.ts'))
    assert.match(r.results.map((x) => x.message).join('\n'), /orphan-record .*the record behind the rule is not there/)
  })

  test('the heading of an anchor has to be in the record', () => {
    project('defects')
    writeFileSync(join(repo, 'docs/adr/test.md'), '# Tests\n\n## 4. Waits\n')
    const r = results(['check', 'tests', 'rules'])
    assert.match(
      r.results.map((x) => x.message).join('\n'),
      /module-mock .*the record has no heading #3-no-module-mocks/,
    )
  })
})

describe('lntt check tests touched', () => {
  const COVERAGE =
    'node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination={out}/lcov.info {files}'

  function mutateProject(): void {
    project('mutate')
    const config = JSON.stringify({
      tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', coverage: COVERAGE }] },
    })
    writeFileSync(join(repo, '.agents/config.jsonc'), config)
    git('commit', '-qam', 'coverage')
  }

  test('needs --base', () => {
    mutateProject()
    const r = results(['check', 'tests', 'touched'])
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.message}`),
      ['NOT RUN needs --base: the lines the diff changes'],
    )
  })

  test('says which tests run the changed lines, from coverage, and which lines no test runs', () => {
    mutateProject()
    writeFileSync(
      join(repo, 'src/price.ts'),
      `${'export const added = 1\n'}${(execFileSync('cat', [join(repo, 'src/price.ts')], { encoding: 'utf8' }) as string).replace('n + 1', 'n + 2')}`,
    )
    git('commit', '-qam', 'change')
    const r = results(['check', 'tests', 'touched', '--base', 'HEAD~1'])
    assert.equal(r.status, 0)
    const price = r.results.find((x) => x.path === 'src/price.ts')
    assert.equal(price?.status, 'INFO')
    // line 1 is module top-level code, run when the test imports the file; line 12 is
    // the body of next(), which no test calls
    assert.match(price?.message ?? '', /lines 1: test\/price\.test\.ts/)
    assert.match(price?.message ?? '', /lines 12: no test runs them/)
  })

  test('without a coverage command the tests come from imports and the message says so', () => {
    project('mutate')
    writeFileSync(
      join(repo, 'src/price.ts'),
      `// changed\n${execFileSync('cat', [join(repo, 'src/price.ts')], { encoding: 'utf8' })}`,
    )
    git('commit', '-qam', 'change')
    const r = results(['check', 'tests', 'touched', '--base', 'HEAD~1'])
    const price = r.results.find((x) => x.path === 'src/price.ts')
    assert.match(price?.message ?? '', /from imports \(no coverage for their level\): test\/price\.test\.ts/)
  })

  test('a changed file no test imports is reported as such', () => {
    project('mutate')
    writeFileSync(join(repo, 'src/orphan.ts'), 'export const flag = false\n')
    git('commit', '-qam', 'change')
    const r = results(['check', 'tests', 'touched', '--base', 'HEAD~1'])
    assert.match(r.results.find((x) => x.path === 'src/orphan.ts')?.message ?? '', /no test imports this file/)
  })
})

describe('lntt check tests', () => {
  test('an unknown check, or a file given to one that takes none, is a usage error', () => {
    project('clean')
    for (const args of [
      ['check', 'tests', 'nope'],
      ['check', 'tests', 'focus', 'a.ts'],
    ]) {
      assert.equal(spawnSync(process.execPath, [BIN, ...args], { cwd: repo }).status, 2)
    }
  })
})
