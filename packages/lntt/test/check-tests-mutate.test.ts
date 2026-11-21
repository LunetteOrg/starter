import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Result } from '../src/check/results.ts'

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

  test('a usage error is exit 2, before anything runs', () => {
    const noTest = spawnSync(
      process.execPath,
      [BIN, 'check', 'tests', 'mutate', 'src/price.ts:7', '--text=total > 100', '--to=total >= 100'],
      { cwd: repo, encoding: 'utf8' },
    )
    assert.equal(noTest.status, 2)
    assert.match(noTest.stderr, /mutate needs --test <test file>/)
  })
})

// One lock per worktree, shared with lntt review (src/worktree/lock.ts): the review's side
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

  test('a lock left by a process that is gone does not block it', () => {
    writeFileSync(lock(), '999999 lntt review')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock(), old, old)
    assert.equal(mutate('src/price.ts:7', "'big' : 'small'", "'small' : 'big'").status, 0)
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
})

describe('lntt check tests mutate: what it refuses and what it cannot start', () => {
  const level = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        tests: { levels: [{ name: 'unit', files: ['test/*.test.ts'], run: 'node --test {files}', ...extra }] },
      }),
    )

  test('a command that cannot start is no pass: NOT RUN, never survived', () => {
    level({ cwd: 'nowhere' })
    const { result } = mutate('src/price.ts:7', 'total > 100', 'total >= 100')
    assert.equal(result.status, 'NOT RUN', result.message)
    assert.match(result.message, /level unit fails without the mutation/)
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

  // Every command on Effect exits 130 on an interrupt, whichever the signal (src/run-command.ts).
  for (const [signal, code] of [
    ['SIGTERM', 130],
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
