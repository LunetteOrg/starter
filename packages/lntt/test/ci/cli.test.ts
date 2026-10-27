import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ciConfig } from '../../src/ci/config.ts'
import { git, repo, write } from './helpers.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/lntt.ts')

const CI = `
on:
  pull_request:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: echo lint >> "$RUNNER_LOG"
      - run: test -f must-exist
`

const RELEASE = `
on: [pull_request]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo published >> "$RUNNER_LOG"
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`

let root: string
// The ci:local run under test may still be writing its lock or its guard when a test
// removes a folder: the removal tries again before it fails.
const RETRY = { maxRetries: 10, retryDelay: 50 } as const
afterEach(() => rmSync(root, { recursive: true, force: true, ...RETRY }))

// The lock lives in the test repository, never in the machine's cache.
const env = () => ({
  ...process.env,
  RUNNER_LOG: join(root, '.git', 'runner.log'),
  LNTT_CI_LOCK_DIR: join(root, '.git', 'locks'),
  LNTT_CI_LOCK_POLL_MS: '100',
})

function ci(...args: string[]) {
  return spawnSync(process.execPath, [BIN, 'ci', ...args], { cwd: root, encoding: 'utf8', env: env() })
}

// A run in the background: its output so far, and its exit code and output once it ends.
function background(...args: string[]) {
  return backgroundWith({}, ...args)
}

function backgroundWith(extra: Record<string, string>, ...args: string[]) {
  const child = spawn(process.execPath, [BIN, 'ci', ...args], { cwd: root, env: { ...env(), ...extra } })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => {
    out.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    out.stderr += chunk
  })
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on('close', (status) => resolve({ status, ...out })),
  )
  return { child, out, done }
}

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) assert.fail('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('lntt ci local', () => {
  test('--list shows each job, what the cloud runs and what runs locally', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    const out = ci('local', '--list')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /pull request feat\/x → main/)
    assert.match(out.stdout, /ci\.yml\/ci .* runs locally/)
    assert.match(out.stdout, /uses: actions\/checkout@v7\n\s+→ no-op: the working tree is the checkout/)
  })

  test('refuses a dirty working tree', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    writeFileSync(join(root, 'dirty'), 'x')
    const out = ci('local')
    assert.equal(out.status, 1)
    assert.match(out.stderr, /uncommitted changes/)
  })

  test('a red step fails the run, and the report says which', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    const out = ci('local')
    assert.equal(out.status, 1)
    assert.match(out.stdout, /✖ ci\.yml\/ci/)
    assert.match(out.stdout, /✖ run: test -f must-exist/)
  })

  test('green, with an undeclared secret reported as not run; --strict fails on it; cloud-only passes', () => {
    root = repo({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE, 'must-exist': '' })
    let out = ci('local')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /⚠ run: echo published .*secrets\.NPM_TOKEN/)
    assert.equal(ci('local', '--strict').status, 1)

    write(root, {
      '.agents/config.jsonc': JSON.stringify({ ci: { local: { cloudOnly: { 'release.yml': 'publishes to npm' } } } }),
    })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'config')
    out = ci('local', '--strict')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /☁ release\.yml\/release {2}cloud-only: publishes to npm/)
  })

  test('--job runs one job; an unknown one is a usage error', () => {
    root = repo({ '.github/workflows/ci.yml': CI, 'must-exist': '' })
    assert.equal(ci('local', '--job', 'ci.yml/ci').status, 0)
    const out = ci('local', '--job', 'nope')
    assert.equal(out.status, 2)
    assert.match(out.stderr, /no job nope \(ci\.yml\/ci\)/)
  })

  test('a usage error exits 2', () => {
    root = repo({})
    assert.equal(ci('nothing').status, 2)
    assert.equal(ci('local', '--event', 'release').status, 2)
  })
})

describe('the ci:local lock', () => {
  // With HOLD set, the step holds until the test creates the go file (30 s at most).
  const SLOW = `
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo start >> "$RUNNER_LOG"
          i=0; while [ -n "$HOLD" ] && [ ! -f "$RUNNER_LOG.go" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done
          echo end >> "$RUNNER_LOG"
`
  const lock = () => join(root, '.git', 'locks', 'ci-local.lock')
  const go = () => writeFileSync(join(root, '.git', 'runner.log.go'), '')

  test('two runs at once queue: the second says whom it waits for, then runs', async () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const first = backgroundWith({ HOLD: '1' }, 'local')
    await until(() => existsSync(lock()))
    const holder = JSON.parse(readFileSync(lock(), 'utf8'))
    assert.equal(holder.worktree, root)
    const second = background('local')
    await until(() => /waiting/.test(second.out.stderr))
    go()
    const [a, b] = await Promise.all([first.done, second.done])
    assert.equal(a.status, 0, a.stdout + a.stderr)
    assert.equal(b.status, 0, b.stdout + b.stderr)
    assert.match(b.stderr, new RegExp(`waiting for the ci:local lock held by ${root} \\(pid ${holder.pid} on `))
    assert.match(b.stderr, /took the ci:local lock after/)
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\nend\nstart\nend\n')
    assert.deepEqual(readdirSync(join(root, '.git', 'locks')), [])
  })

  test('--no-lock runs without it; --list does not take it', async () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const first = backgroundWith({ HOLD: '1' }, 'local')
    await until(() => existsSync(lock()))
    const list = ci('local', '--list')
    assert.equal(list.status, 0, list.stderr)
    assert.doesNotMatch(list.stderr, /waiting/)
    const unlocked = ci('local', '--no-lock')
    assert.equal(unlocked.status, 0, unlocked.stdout + unlocked.stderr)
    assert.doesNotMatch(unlocked.stderr, /waiting/)
    // The unlocked run went through while the first one still held the lock.
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\nstart\nend\n')
    go()
    assert.equal((await first.done).status, 0)
  })

  // A step that records its background child and holds; then a step and a job that must
  // not start once the run is interrupted.
  const INTERRUPTIBLE = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: (sleep 30; echo late >> "$RUNNER_LOG") & echo $! > "$RUNNER_LOG.child"; sleep 30
      - if: failure()
        run: echo after >> "$RUNNER_LOG"
  b:
    runs-on: ubuntu-latest
    needs: a
    if: always()
    steps:
      - run: echo b >> "$RUNNER_LOG"
`

  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGQUIT', 131],
  ] as const) {
    test(`${signal} stops the running step with its children, starts nothing more, gives the lock back and exits ${code}`, async () => {
      root = repo({ '.github/workflows/ci.yml': INTERRUPTIBLE })
      const child = spawn(process.execPath, [BIN, 'ci', 'local'], { cwd: root, env: env() })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
      const pidFile = join(root, '.git', 'runner.log.child')
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'))
      // The running step's group is in the lock's record.
      await until(() => typeof JSON.parse(readFileSync(lock(), 'utf8')).group === 'number')
      child.kill(signal)
      assert.equal(await closed, code)
      assert.match(stderr, new RegExp(`lntt ci: interrupted \\(${signal}\\)`))
      assert.equal(existsSync(lock()), false)
      const background = Number(readFileSync(pidFile, 'utf8'))
      await until(() => {
        try {
          process.kill(background, 0)
          return false
        } catch {
          return true
        }
      })
      assert.equal(existsSync(join(root, '.git', 'runner.log')), false)
    })
  }

  test('a second signal changes nothing: one line, the first one’s exit code', async () => {
    // A step that ignores SIGTERM keeps the run stopping long enough for a second signal.
    root = repo({
      '.github/workflows/ci.yml': `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: trap '' TERM; while true; do sleep 0.1; done
`,
    })
    const child = spawn(process.execPath, [BIN, 'ci', 'local'], { cwd: root, env: env() })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
    await until(() => existsSync(lock()) && typeof JSON.parse(readFileSync(lock(), 'utf8')).group === 'number')
    child.kill('SIGINT')
    await until(() => /interrupted/.test(stderr))
    child.kill('SIGINT')
    assert.equal(await closed, 130)
    assert.equal(stderr.match(/lntt ci: interrupted \(SIGINT\)/g)?.length, 1, stderr)
  })

  test('a lock that cannot be given back is one line, and the run keeps its exit code', async () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const first = backgroundWith({ HOLD: '1' }, 'local')
    await until(() => existsSync(lock()))
    rmSync(join(root, '.git', 'locks'), { recursive: true, force: true, ...RETRY })
    go()
    const a = await first.done
    assert.equal(a.status, 0, a.stdout + a.stderr)
    assert.match(a.stderr, /^lntt ci: cannot give the ci:local lock back \(ENOENT: .*\) — .*ci-local\.lock$/m)
    assert.equal(a.stderr.match(/cannot give/g)?.length, 1, a.stderr)
    assert.match(a.stdout, /✔ ci\.yml\/ci/)
  })

  test('an interrupt that cannot give the lock back still exits 128 plus the signal', async () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const first = backgroundWith({ HOLD: '1' }, 'local')
    await until(() => existsSync(lock()))
    rmSync(join(root, '.git', 'locks'), { recursive: true, force: true, ...RETRY })
    first.child.kill('SIGINT')
    const a = await first.done
    assert.equal(a.status, 130, a.stdout + a.stderr)
    assert.equal(a.stderr.match(/cannot give the ci:local lock back/g)?.length, 1, a.stderr)
  })

  test('the run stops at the lock’s maximum hold time, counted from when it took the lock', async () => {
    root = repo({ '.github/workflows/ci.yml': `${SLOW}      - run: echo after >> "$RUNNER_LOG"\n` })
    // Once the jump file exists, the run's clock reads 121 minutes later.
    const jump = join(root, '.git', 'jump')
    const clock = `import { existsSync } from 'node:fs'
const now = Date.now
Date.now = () => now() + (existsSync(${JSON.stringify(jump)}) ? 121 * 60_000 : 0)`
    const child = spawn(
      process.execPath,
      ['--import', `data:text/javascript,${encodeURIComponent(clock)}`, BIN, 'ci', 'local'],
      { cwd: root, env: { ...env(), HOLD: '1' } },
    )
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve))
    // The first step is running: its group is in the lock's record.
    await until(() => existsSync(lock()) && typeof JSON.parse(readFileSync(lock(), 'utf8')).group === 'number')
    writeFileSync(jump, '')
    go()
    assert.equal(await closed, 1, stdout)
    assert.match(stdout, /after .*\(the run passed the lock's maximum hold time of 120 minutes — load /)
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\nend\n')
  })

  test('a holder killed while its step runs is waited for until the step ends', async () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const holder = spawn(process.execPath, [BIN, 'ci', 'local'], { cwd: root, env: { ...env(), HOLD: '1' } })
    // 'exit', not 'close': the orphaned step keeps the holder's output pipes open.
    const killed = new Promise((resolve) => holder.on('exit', resolve))
    await until(() => existsSync(lock()) && typeof JSON.parse(readFileSync(lock(), 'utf8')).group === 'number')
    const { group } = JSON.parse(readFileSync(lock(), 'utf8'))
    holder.kill('SIGKILL')
    await killed
    const second = background('local')
    await until(() => /still is/.test(second.out.stderr))
    assert.match(
      second.out.stderr,
      new RegExp(`which is no longer running, but its step \\(process group ${group}\\) still is`),
    )
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\n')
    go()
    const b = await second.done
    assert.equal(b.status, 0, b.stdout + b.stderr)
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\nend\nstart\nend\n')
  })

  test('the project scope uses a lock file per repository', async () => {
    root = repo({
      '.github/workflows/ci.yml': SLOW,
      '.agents/config.jsonc': JSON.stringify({ ci: { local: { lock: 'project' } } }),
    })
    const first = backgroundWith({ HOLD: '1' }, 'local')
    const locks = join(root, '.git', 'locks')
    const name = new RegExp(`^ci-local-${basename(root)}-[0-9a-f]{12}\\.lock$`)
    await until(() => existsSync(locks) && readdirSync(locks).some((f) => name.test(f)))
    assert.equal(existsSync(lock()), false)
    go()
    assert.equal((await first.done).status, 0)
    assert.deepEqual(readdirSync(locks), [])
  })

  test('a lock that cannot be taken is one line, exit 1', () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    writeFileSync(join(root, '.git', 'file'), '')
    const out = spawnSync(process.execPath, [BIN, 'ci', 'local'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...env(), LNTT_CI_LOCK_DIR: join(root, '.git', 'file', 'locks') },
    })
    assert.equal(out.status, 1)
    assert.match(
      out.stderr,
      /^lntt ci: cannot take the ci:local lock \(ENOTDIR: .*\) — .*; --no-lock runs without it\n$/,
    )
  })

  test('--no-lock is the one negated option', () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    assert.equal(ci('local', '--no-list').status, 2)
    assert.equal(ci('local', '--no-strict').status, 2)
  })

  test('without ci.local: a machine lock and 30 minutes per step, so a quick step passes', () => {
    root = repo({ '.github/workflows/ci.yml': SLOW })
    const config = ciConfig(root)
    assert.deepEqual([config.lock, config.timeoutMinutes], ['machine', 30])
    const out = ci('local')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.equal(readFileSync(join(root, '.git', 'runner.log'), 'utf8'), 'start\nend\n')
  })

  test('a timeout from the configuration stops the step and prints the load', () => {
    root = repo({
      '.github/workflows/ci.yml': SLOW.replace('[ -n "$HOLD" ]', 'true'),
      '.agents/config.jsonc': JSON.stringify({ ci: { local: { timeoutMinutes: 0.005 } } }),
    })
    const out = ci('local')
    assert.equal(out.status, 1)
    assert.match(out.stdout, /✖ ci\.yml\/ci .* failed: run: .* timed out/)
    assert.match(out.stdout, /\(timed out after 0\.3s — load [\d.]+ \/ [\d.]+ \/ [\d.]+ on \d+ cores/)
    assert.match(out.stdout, /A timeout is not a verdict on the code/)
  })
})

describe('lntt ci candidate', () => {
  const CONFIG = { delivery: { candidate: { prefix: 'candidate/' } } }

  function candidate(event: unknown, ...args: string[]) {
    write(root, { '.git/event.json': JSON.stringify(event) })
    // A gh that answers the open-candidate query and records every call.
    write(root, {
      '.git/bin/gh': `#!/bin/sh\necho "$*" >> "${root}/.git/gh.log"\ncase "$*" in *"--state open"*) echo '[{"number":40,"headRefName":"candidate/4","body":""}]';; esac\n`,
    })
    execFileSync('chmod', ['+x', join(root, '.git/bin/gh')])
    return spawnSync(process.execPath, [BIN, 'ci', 'candidate', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, '.git/bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_PATH: join(root, '.git/event.json'),
      },
    })
  }

  const opened = (fields = {}) => ({
    action: 'opened',
    pull_request: {
      number: 7,
      title: 't',
      body: 'Closes #3',
      base: { ref: 'main' },
      head: { ref: 'feat/3/x' },
      labels: [],
      ...fields,
    },
  })

  test('without delivery.candidate it does nothing, with a notice', () => {
    root = repo({})
    const out = candidate(opened())
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /::notice::no delivery\.candidate/)
  })

  test('a pull request opened into main moves onto the open candidate (dry run)', () => {
    root = repo({ '.agents/config.jsonc': JSON.stringify(CONFIG) })
    const out = candidate(opened(), '--dry-run')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\[dry-run\] gh pr edit 7 --repo o\/r --base candidate\/4/)
    assert.match(out.stdout, /\[dry-run\] gh pr comment 7/)
  })

  test('a hotfix stays on main and reads nothing', () => {
    root = repo({ '.agents/config.jsonc': JSON.stringify(CONFIG) })
    const out = candidate(opened({ head: { ref: 'hotfix/login' } }))
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /it stays, a hotfix stays on main/)
  })
})

describe('lntt ci proved', () => {
  const SHA = 'a'.repeat(40)
  const HEAD = 'b'.repeat(40)
  const BEFORE = 'c'.repeat(40)
  const TREE = 'f'.repeat(40)

  // The API of a push that rebase-merged #7, up to date with main, its full CI green;
  // a path it does not know fails, as on an API error. Every call is logged.
  const API: Record<string, unknown> = {
    [`repos/o/r/git/commits/${SHA}`]: { tree: { sha: TREE } },
    [`repos/o/r/git/commits/${HEAD}`]: { tree: { sha: TREE } },
    [`repos/o/r/commits/${SHA}/pulls`]: [
      { number: 7, merged_at: '2026-10-27T10:00:00Z', base: { ref: 'main' }, head: { sha: HEAD } },
    ],
    [`repos/o/r/compare/${BEFORE}...${HEAD}`]: { status: 'ahead' },
    [`repos/o/r/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=100`]: {
      workflow_runs: [{ id: 11, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'u/11' }],
    },
    [`repos/o/r/actions/runs/11/jobs?per_page=100`]: {
      jobs: [{ name: 'ci', conclusion: 'success', steps: [{ name: 'Full CI', conclusion: 'success' }] }],
    },
  }

  // `event` is the push event's body, written as GITHUB_EVENT_PATH; GITHUB_REPOSITORY
  // set to '' leaves the repository to `gh repo view`.
  function proved(api: Record<string, unknown>, extra: Record<string, string> & { event?: string }, ...args: string[]) {
    root = repo({})
    const cases = Object.entries(api)
      .map(([path, answer]) => `  '${path}') echo '${JSON.stringify(answer)}';;`)
      .join('\n')
    write(root, {
      '.git/bin/gh': `#!/bin/sh\necho "$*" >> "${root}/.git/gh.log"\n[ "$1 $2" = "repo view" ] && { echo o/r; exit 0; }\ncase "$2" in\n${cases}\n  *) echo "HTTP 502" >&2; exit 1;;\nesac\n`,
    })
    execFileSync('chmod', ['+x', join(root, '.git/bin/gh')])
    const { event, ...vars } = extra
    if (event !== undefined) write(root, { '.git/event.json': event })
    return spawnSync(process.execPath, [BIN, 'ci', 'proved', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, '.git/bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_ACTIONS: '',
        GITHUB_WORKFLOW_REF: '',
        GITHUB_SHA: '',
        GITHUB_REF_NAME: '',
        GITHUB_EVENT_PATH: event === undefined ? '' : join(root, '.git/event.json'),
        ...vars,
      },
    })
  }

  // The push run's own environment: the sha, the branch, the workflow and the event.
  function actions(event: unknown): Record<string, string> & { event: string } {
    return {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: SHA,
      GITHUB_REF_NAME: 'main',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/heads/main',
      event: typeof event === 'string' ? event : JSON.stringify(event),
    }
  }

  test('from a terminal, the repository comes from gh and the sha from HEAD', () => {
    const result = proved(API, { GITHUB_REPOSITORY: '' }, '--job', 'ci', '--workflow', 'ci.yml', '--before', BEFORE)
    assert.equal(result.status, 1)
    const head = git(root, 'rev-parse', 'HEAD')
    const calls = readFileSync(join(root, '.git/gh.log'), 'utf8')
    assert.match(calls, /^repo view /m)
    assert.match(calls, new RegExp(`^api repos/o/r/commits/${head}/pulls$`, 'm'))
  })

  test('in a push run, a proved tree exits 0 with a notice naming the run', () => {
    const result = proved(API, actions({ before: BEFORE }), '--job', 'ci', '--step', 'Full CI')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^::notice title=Tree already proved::proved: .*#7.*u\/11/)
    const calls = readFileSync(join(root, '.git/gh.log'), 'utf8')
    assert.match(calls, new RegExp(`api repos/o/r/compare/${BEFORE}\\.\\.\\.${HEAD}`))
    assert.match(calls, /api repos\/o\/r\/actions\/workflows\/ci\.yml\/runs/)
  })

  test('the options name the push from a terminal', () => {
    const result = proved(
      API,
      {},
      ...['--job', 'ci', '--workflow', 'ci.yml', '--sha', SHA, '--before', BEFORE, '--branch', 'main'],
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^proved: /)
  })

  test('the marker step is read from --step', () => {
    const result = proved(API, actions({ before: BEFORE }), '--job', 'ci', '--step', 'Smoke')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /step Smoke/)
  })

  test('an event with no previous tip, or unreadable, is not proved', () => {
    for (const event of [{}, { before: null }, { before: 7 }, 'not json']) {
      const result = proved(API, actions(event), '--job', 'ci')
      assert.equal(result.status, 1)
      assert.match(result.stdout, /^::notice title=Full run::not proved: no previous tip/)
    }
  })

  test('an API error is not proved: exit 1, with the reason', () => {
    const result = proved({}, actions({ before: BEFORE }), '--job', 'ci')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /^::notice title=Full run::not proved: .*HTTP 502/)
  })

  test('no job, or no workflow outside Actions, is a usage error', () => {
    for (const args of [
      ['--workflow', 'ci.yml'],
      ['--job', 'ci'],
    ]) {
      const result = proved(API, {}, ...args)
      assert.equal(result.status, 2)
      assert.match(result.stderr, /--job|--workflow/)
    }
  })
})

describe('reporting', () => {
  test('--list says which steps the event skips', () => {
    root = repo({
      '.github/workflows/ci.yml': `
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - if: github.base_ref == 'main'
        run: pnpm test
`,
    })
    assert.match(ci('local', '--list').stdout, /pnpm test .*\n\s+→ runs on the host/)
    assert.match(
      ci('local', '--list', '--base', 'candidate/1').stdout,
      /pnpm test .*\n\s+→ skipped: the condition is false for this event/,
    )
  })

  test('the summary names jobs left out by --job as not selected', () => {
    root = repo({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE, 'must-exist': '' })
    const out = ci('local', '--job', 'ci.yml/ci')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /1 passed, 0 failed, 0 cloud only, 0 skipped, 1 not selected with --job/)
  })
})
