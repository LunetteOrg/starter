import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
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
function mutate(
  anchor: string,
  text: string,
  to: string,
  tests: string[] = ['test/price.test.ts'],
): { status: number | null; result: Result } {
  const r = spawnSync(
    process.execPath,
    [
      BIN,
      'check',
      'tests',
      'mutate',
      anchor,
      `--text=${text}`,
      `--to=${to}`,
      ...tests.map((t) => `--test=${t}`),
      '--json',
    ],
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

  test('a line of a non-code file is killed by the test file the author names', () => {
    const { status, result } = mutate('skills/review/SKILL.md:6', 'Never merge', 'Always merge', ['test/skill.test.ts'])
    assert.equal(status, 0)
    assert.equal(result.status, 'PASS')
    assert.match(result.message, /killed by the review skill forbids merging/)
    assert.equal(result.message.includes('test/price.test.ts'), false, 'only the named file ran')
  })

  test('a named test that still passes survives, listing the files that ran', () => {
    const { status, result } = mutate('docs/pinned.md:2', 'does not check', 'checks', ['test/pinned.test.ts'])
    assert.equal(status, 1)
    assert.match(result.message, /survived: 1 test file still pass \(test\/pinned\.test\.ts\)/)
  })

  test('a test file that is gone, outside the project, or in no level is NOT RUN, naming it', () => {
    rmSync(join(repo, 'test/skill.test.ts'))
    const gone = mutate('src/price.ts:7', 'total > 100', 'x', ['test/skill.test.ts']).result
    assert.equal(gone.status, 'NOT RUN')
    assert.match(gone.message, /--test test\/skill\.test\.ts: no such file in the project/)
    for (const test of ['../outside.test.ts', '/etc/hosts']) {
      const outside = mutate('src/price.ts:7', 'total > 100', 'x', [test]).result
      assert.equal(outside.status, 'NOT RUN', test)
      assert.match(outside.message, /no such file in the project/)
    }
    const unleveled = mutate('src/price.ts:7', 'total > 100', 'x', ['src/orphan.ts']).result
    assert.equal(unleveled.status, 'NOT RUN')
    assert.match(unleveled.message, /--test src\/orphan\.ts: no level of tests\.levels has this file/)
  })

  test('test files of two levels each run with the command of their level', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        tests: {
          levels: [
            { name: 'a', files: ['test/other.test.ts'], run: 'node --test {files}' },
            { name: 'b', files: ['test/skill.test.ts'], run: 'exit 7 # {files}' },
          ],
        },
      }),
    )
    writeFileSync(join(repo, 'test/other.test.ts'), '// names skills/review/SKILL.md\n')
    git('add', '-A')
    const { result } = mutate('skills/review/SKILL.md:6', 'Never merge', 'Always merge', [
      'test/other.test.ts',
      'test/skill.test.ts',
    ])
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /level b fails without the mutation/)
  })

  test('a file that no test file imports survives when the named test passes: the author chose it', () => {
    const { status, result } = mutate('src/orphan.ts:1', 'true', 'false')
    assert.equal(status, 1)
    assert.match(result.message, /survived: 1 test file still pass \(test\/price\.test\.ts\)$/)
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
    const { status, result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100', ['test/boundary.test.ts'])
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

  test('uncommitted work is run: a new file, and a line past the end of the committed one', () => {
    writeFileSync(join(repo, 'src/fresh.ts'), 'export const a = 1\nexport const b = 2\n')
    writeFileSync(
      join(repo, 'test/fresh.test.ts'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { b } from '../src/fresh.ts'\ntest('b is two', () => {\n  assert.equal(b, 2)\n})\n",
    )
    const fresh = mutate('src/fresh.ts:2', '= 2', '= 3', ['test/fresh.test.ts']).result
    assert.equal(fresh.status, 'PASS', fresh.message)
    const price = `${readFileSync(join(repo, 'src/price.ts'), 'utf8')}\nexport const late = 'x'\n`
    writeFileSync(join(repo, 'src/price.ts'), price)
    writeFileSync(
      join(repo, 'test/late.test.ts'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { late } from '../src/price.ts'\ntest('late is x', () => {\n  assert.equal(late, 'x')\n})\n",
    )
    const line = price.trimEnd().split('\n').length
    const late = mutate(`src/price.ts:${line}`, "'x'", "'y'", ['test/late.test.ts']).result
    assert.equal(late.status, 'PASS', late.message)
  })

  test('a file git ignores is not in the scratch: NOT RUN, not a crash', () => {
    writeFileSync(join(repo, '.gitignore'), 'src/ignored.ts\n')
    git('add', '-A')
    git('commit', '-qm', 'ignore')
    writeFileSync(join(repo, 'src/ignored.ts'), 'export const z = 1\n')
    const { status, result } = mutate('src/ignored.ts:1', '= 1', '= 2')
    assert.equal(status, 0)
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /src\/ignored\.ts: no such file/)
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
    assert.match(mutate('src/price.ts:11', 'n + 1', 'n - 1', ['test/flaky.test.ts']).result.message, /survived/)
    writeFileSync(join(repo, '.agents/config.jsonc'), level(2))
    const killed = mutate('src/price.ts:11', 'n + 1', 'n - 1', ['test/flaky.test.ts']).result
    assert.equal(killed.status, 'PASS', killed.message)
    assert.match(killed.message, /killed by fails on its second run only/)
  })

  test('a test file that outlasts timeoutSeconds with and without the mutation is NOT RUN, naming the file', () => {
    const levels = [
      { name: 'unit', files: ['test/*.test.ts'], run: 'sleep 3 && node --test {files}', timeoutSeconds: 1 },
    ]
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ tests: { levels } }))
    const { result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /test\/price\.test\.ts did not finish in 1s, with or without the mutation/)
  })

  test('a project with no tests.levels cannot run a mutation', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{}\n')
    assert.match(mutate('src/price.ts:7', 'total > 100', 'x').result.message, /tests\.levels is not configured/)
  })

  test('usage errors: a mutation needs path:line, --text, --to and at least one --test', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, 'check', 'tests', 'mutate', ...args], { cwd: repo, encoding: 'utf8' })
    const test = '--test=test/price.test.ts'
    assert.equal(run('src/price.ts', '--text=x', '--to=y', test).status, 2)
    assert.equal(run('src/price.ts:7', '--text=x', test).status, 2)
    assert.equal(run('--text=x', '--to=y', test).status, 2)
    const noTest = run('src/price.ts:7', '--text=total > 100', '--to=total >= 100')
    assert.equal(noTest.status, 2)
    assert.match(noTest.stderr, /mutate needs --test <test file>/)
    assert.equal(run('src/price.ts:7', '--text=x', '--to=y', '--test=').status, 2)
    for (const flag of ['--text=x', '--test=test/price.test.ts']) {
      assert.equal(spawnSync(process.execPath, [BIN, 'check', 'tests', 'focus', flag], { cwd: repo }).status, 2, flag)
    }
  })
})

// One lock per worktree, shared with lntt review (src/worktree-lock.ts): the review's side
// of each order is in review-cli.test.ts.
describe('lntt check tests mutate and the lock of the worktree', () => {
  const lock = () => join(repo, '.git/lntt-review.lock')
  const args = [
    'check',
    'tests',
    'mutate',
    'src/price.ts:7',
    "--text='big' : 'small'",
    "--to='small' : 'big'",
    '--test=test/price.test.ts',
  ]
  const holder = () => {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' })
    return child
  }

  test('is refused while a round of lntt review holds the lock, naming the round and its pid', () => {
    const round = holder()
    try {
      writeFileSync(lock(), `${round.pid} lntt review`)
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8' })
      assert.equal(r.status, 1)
      assert.match(
        r.stderr,
        new RegExp(`^lntt: error: lntt review is already running in this worktree \\(pid ${round.pid}\\)$`, 'm'),
      )
      assert.equal(r.stdout, '', 'nothing was mutated or run')
      assert.equal(readFileSync(lock(), 'utf8'), `${round.pid} lntt review`, 'the round keeps its lock')
    } finally {
      round.kill('SIGKILL')
    }
  })

  test('gives the lock back when it ends', () => {
    assert.equal(mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'").status, 0)
    assert.equal(existsSync(lock()), false, 'the lock goes with the command')
  })

  test('outside a git repository it cannot run, and says so', () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true })
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) },
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lntt: error: .* has no git directory: a mutation needs one$/m)
    assert.equal(existsSync(lock()), false, 'no lock is left behind')
  })

  test('a lock left by a process that is gone does not block it', () => {
    writeFileSync(lock(), '999999 lntt review')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock(), old, old)
    assert.equal(mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'").status, 0)
  })
})

// The author names the test files: only those run, one at a time, the first failure ends the rest.
describe('lntt check tests mutate: the test files the author names', () => {
  const marker = () => join(repo, '..', `${repo.split('/').pop()}.order`)
  afterEach(() => rmSync(marker(), { force: true }))
  const mark = (name: string, body: string) =>
    writeFileSync(
      join(repo, `test/${name}.test.ts`),
      `import assert from 'node:assert/strict'\nimport { appendFileSync } from 'node:fs'\nimport { test } from 'node:test'\nimport { label } from '../src/price.ts'\ntest('${name}', () => {\n  appendFileSync(${JSON.stringify(marker())}, '${name} ')\n  ${body}\n})\n`,
    )

  test('the named files run in the order given, one at a time, and no other file runs', () => {
    mark('first', "assert.equal(label(50), 'small')")
    mark('second', "assert.equal(label(50), 'small')")
    const { result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100', [
      'test/second.test.ts',
      'test/first.test.ts',
    ])
    assert.equal(result.status, 'FAIL', result.message)
    assert.match(result.message, /survived: 2 test files still pass \(test\/second\.test\.ts, test\/first\.test\.ts\)/)
    assert.equal(readFileSync(marker(), 'utf8'), 'second first ', 'in order, price.test.ts and the others not run')
  })

  test('the first file that fails ends the run: the files after it do not run', () => {
    mark('fails', "assert.equal(label(500), 'big')")
    mark('after', "assert.equal(label(500), 'big')")
    const { status, result } = mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'", [
      'test/fails.test.ts',
      'test/after.test.ts',
    ])
    assert.equal(status, 0)
    assert.match(result.message, /killed by fails/)
    // `fails` ran twice: with the mutation, then again without it, to see that it passes
    assert.equal(readFileSync(marker(), 'utf8'), 'fails fails ', 'the file after the failure never ran')
  })
})

// A hang is a result of the file that hangs: the other files of the level still run.
describe('lntt check tests mutate: one timeout per test file', () => {
  const marker = () => join(repo, '..', `${repo.split('/').pop()}.marker`)

  function hangProject(timeoutSeconds: number): void {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', timeoutSeconds }] },
      }),
    )
    writeFileSync(
      join(repo, 'src/spin.ts'),
      [
        'export function spin(n: number): number {',
        '  while (n < 3) n += 1',
        '  return n',
        '}',
        "export const NAME = 'spin'",
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(repo, 'test/spin.test.ts'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { spin } from '../src/spin.ts'\ntest('spin counts to three', () => {\n  assert.equal(spin(0), 3)\n})\n",
    )
    writeFileSync(
      join(repo, 'test/spin-name.test.ts'),
      `import assert from 'node:assert/strict'\nimport { appendFileSync } from 'node:fs'\nimport { test } from 'node:test'\nimport { NAME } from '../src/spin.ts'\ntest('spin has a name', () => {\n  appendFileSync(${JSON.stringify(marker())}, 'ran')\n  assert.equal(NAME, 'spin')\n})\n`,
    )
    git('add', '-A')
    git('commit', '-qm', 'a loop')
  }

  afterEach(() => rmSync(marker(), { force: true }))

  test('a mutation that makes one test file hang is caught by the hang, naming the file and its timeout', () => {
    hangProject(2)
    const { status, result } = mutate('src/spin.ts:2', 'n += 1', 'n -= 1', [
      'test/spin.test.ts',
      'test/spin-name.test.ts',
    ])
    assert.equal(status, 0)
    assert.equal(result.status, 'PASS', result.message)
    assert.match(result.message, /killed by test\/spin\.test\.ts: did not finish in 2s/)
    assert.equal(readFileSync(marker(), 'utf8'), 'ran', 'the other file ran to its end')
  })

  test('a file that hangs without the mutation too is NOT RUN, naming the file', () => {
    hangProject(2)
    writeFileSync(
      join(repo, 'src/spin.ts'),
      readFileSync(join(repo, 'src/spin.ts'), 'utf8').replace('n += 1', 'n -= 1'),
    )
    git('commit', '-qam', 'break it')
    const { result } = mutate('src/spin.ts:3', 'return n', 'return n + 0', ['test/spin.test.ts'])
    assert.equal(result.status, 'NOT RUN', result.message)
    assert.match(result.message, /test\/spin\.test\.ts did not finish in 2s, with or without the mutation/)
  })
})

describe('lntt check tests mutate: what it refuses and what it cannot start', () => {
  const level = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', ...extra }] },
      }),
    )

  test('a level whose command has no {files} is NOT RUN: it would run the whole suite for every file', () => {
    level({ run: 'node --test' })
    const { status, result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(status, 0)
    assert.equal(result.status, 'NOT RUN')
    assert.match(result.message, /tests\.levels unit: run has no \{files\}/)
  })

  test('a command that cannot start is no pass: NOT RUN, never survived', () => {
    level({ cwd: 'nowhere' })
    const { result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(result.status, 'NOT RUN', result.message)
    assert.match(result.message, /level unit fails without the mutation/)
  })

  test('a file that fails and a file that hangs in one level: the failure is the result', () => {
    level({ timeoutSeconds: 2 })
    writeFileSync(join(repo, 'src/mode.ts'), "export const MODE = 'fast'\n")
    writeFileSync(
      join(repo, 'test/mode-hang.test.ts'),
      "import { test } from 'node:test'\nimport { MODE } from '../src/mode.ts'\ntest('slow mode waits', async () => {\n  if (MODE === 'slow') await new Promise(() => setInterval(() => {}, 1000))\n})\n",
    )
    writeFileSync(
      join(repo, 'test/mode-fail.test.ts'),
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { MODE } from '../src/mode.ts'\ntest('the mode is fast', () => {\n  assert.equal(MODE, 'fast')\n})\n",
    )
    const { status, result } = mutate('src/mode.ts:1', "'fast'", "'slow'", [
      'test/mode-hang.test.ts',
      'test/mode-fail.test.ts',
    ])
    assert.equal(status, 0)
    assert.match(result.message, /killed by the mode is fast/)
    assert.doesNotMatch(result.message, /did not finish/)
  })
})

// An interrupt gives everything back: the scratch worktree, the lock, the tests it started.
describe('lntt check tests mutate: a signal', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
    assert.ok(ok(), what)
  }

  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const) {
    test(`${signal} stops the run: exit ${code}, no scratch worktree, no lock, no test left running`, async () => {
      const pidfile = join(tmpdir(), `lntt-pid-${process.pid}-${signal}`)
      rmSync(pidfile, { force: true })
      writeFileSync(
        join(repo, '.agents/config.jsonc'),
        JSON.stringify({
          tests: {
            levels: [
              { name: 'unit', files: ['test/*.test.ts'], run: `echo $$ > '${pidfile}'; exec sleep 60 # {files}` },
            ],
          },
        }),
      )
      const child = spawn(
        process.execPath,
        [
          BIN,
          'check',
          'tests',
          'mutate',
          'src/price.ts:7',
          '--text=total > 100',
          '--to=total >= 100',
          '--test=test/price.test.ts',
        ],
        { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) } },
      )
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
      await until('the tests started', () => existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() !== '')
      const tests = Number(readFileSync(pidfile, 'utf8').trim())
      const scratch = git('worktree', 'list', '--porcelain')
        .split('\n')
        .find((l) => l.startsWith('worktree ') && l.endsWith('/tree'))
        ?.slice('worktree '.length)
      assert.ok(scratch, 'the scratch worktree is registered while the tests run')
      child.kill(signal)
      assert.equal(await closed, code)
      assert.equal(git('worktree', 'list').split('\n').length, 1, 'no scratch worktree is left registered')
      assert.equal(existsSync(dirname(scratch as string)), false, 'the scratch folder is gone')
      assert.equal(existsSync(join(repo, '.git/lntt-review.lock')), false, 'the lock is given back')
      await until('the tests are stopped', () => !alive(tests))
      rmSync(pidfile, { force: true })
    })
  }

  test('a scratch worktree an earlier run left registered is gone after the next run', () => {
    const stale = join(realpathSync(tmpdir()), `lntt-mutate-stale-${process.pid}`)
    git('worktree', 'add', '--detach', '-q', join(stale, 'tree'), 'HEAD')
    rmSync(stale, { recursive: true, force: true })
    assert.equal(git('worktree', 'list').split('\n').length, 2, 'registered, its folder gone')
    assert.equal(mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'").status, 0)
    assert.equal(git('worktree', 'list').split('\n').length, 1)
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
