import { assert, describe, it } from '@effect/vitest'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import { ProjectConfig } from '../config/load.ts'
import { Gh, GhError, type GhOperations } from '../gh/gh.ts'
import { Git, GitError, type GitOperations } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { command, type LocalInput } from './local.ts'
import { CiProcesses } from './lock.ts'
import { Machine } from './runner.ts'

const ROOT = '/repo'
const LOCKS = '/cache/lntt'

const CI = `
on:
  pull_request:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: echo lint
      - run: test -f must-exist
`

const RELEASE = `
on: [pull_request]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`

const input = (fields: Partial<LocalInput> = {}): LocalInput => ({
  event: 'pull_request',
  list: false,
  strict: false,
  container: false,
  lock: true,
  lockDir: LOCKS,
  node: 'v24.0.0',
  ...fields,
})

// What a command does: `hang` never exits, `test -f must-exist` fails unless `exists`, any other
// exits 0; `sh -c command -v` finds the commands in `onPath`; docker is not installed.
interface Machinery {
  exists?: boolean
  onPath?: string[]
}

// A clone on feat/x with origin/main fetched, src/a.ts changed against it.
const clone = (answers: Partial<GitOperations> = {}) =>
  Git.memory({
    status: Effect.succeed(''),
    branch: Effect.succeed('feat/x'),
    verify: (rev) =>
      Effect.succeed(
        rev === 'HEAD'
          ? 'c0ffee1234'
          : ['refs/remotes/origin/main^{commit}', 'origin/main', 'refs/remotes/origin/candidate/13^{commit}'].includes(
                rev,
              )
            ? 'abc'
            : null,
      ),
    changed: () => Effect.succeed(['src/a.ts']),
    originUrl: Effect.succeed(''),
    originHead: Effect.succeed('origin/main'),
    pointingAt: () => Effect.succeed([]),
    commonDir: Effect.succeed('/repo/.git'),
    ...answers,
  })

// The world of one run: the repository's files, its configuration, git and GitHub, the machine.
function world(
  options: {
    files?: Record<string, string>
    config?: Record<string, unknown>
    git?: Partial<GitOperations>
    gh?: Partial<GhOperations>
  } & Machinery = {},
) {
  const fs = memoryFileSystem({ dirs: [ROOT, '/tmp', LOCKS] })
  for (const [path, text] of Object.entries(options.files ?? { '.github/workflows/ci.yml': CI })) {
    const at = `${ROOT}/${path}`
    Effect.runSync(fs.dir(at.slice(0, at.lastIndexOf('/'))))
    fs.files.set(at, { text, mtime: 0 })
  }
  // What each command saw when it started: its argv, and the lock files present.
  const ran: { argv: string[]; locks: string[] }[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const argv = [command.command, ...command.args.map(String)]
      if (command.command === 'docker') {
        return yield* Effect.fail(
          PlatformError.systemError({ _tag: 'NotFound', module: 'ChildProcess', method: 'spawn' }),
        )
      }
      const last = argv.at(-1) ?? ''
      let code = 0
      if (command.command === 'sh' && argv[2] === 'command -v "$0"') code = options.onPath?.includes(last) ? 0 : 1
      else {
        ran.push({ argv, locks: [...fs.files.keys()].filter((path) => path.startsWith(`${LOCKS}/`)) })
        if (last === 'test -f must-exist' && !options.exists) code = 1
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(500 + ran.length),
        exitCode: last === 'hang' ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  // The command's temporary folder, in memory.
  const files = Layer.effect(FileSystem.FileSystem)(
    Effect.map(FileSystem.FileSystem, (service) =>
      FileSystem.FileSystem.of({
        ...service,
        makeTempDirectoryScoped: () => Effect.as(service.makeDirectory('/tmp/ci', { recursive: true }), '/tmp/ci'),
      }),
    ),
  ).pipe(Layer.provide(fs.layer))
  const layer = Layer.mergeAll(
    files,
    clone(options.git),
    Gh.memory({ repository: Effect.succeed('o/r'), openPullRequests: () => Effect.succeed([]), ...options.gh }),
    ProjectConfig.memory(options.config ?? {}),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
    Machine.memory([1, 1, 1], 4),
    CiProcesses.memory({ self: 1000, running: new Set() }),
    TestConsole.layer,
  )
  return { fs, ran, layer }
}

const output = Effect.gen(function* () {
  return {
    out: (yield* TestConsole.logLines).join('\n'),
    err: (yield* TestConsole.errorLines).join('\n'),
  }
})

describe('lntt ci local', () => {
  it.effect('refuses a dirty working tree, and runs nothing', () => {
    const w = world({ git: { status: Effect.succeed(' M dirty') } })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input(), ROOT), 1)
      assert.match((yield* output).err, /^lntt ci: the working tree has uncommitted changes; .*\n M dirty$/)
      assert.deepStrictEqual(w.ran, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--job runs the job named; the summary names the others as not selected', () => {
    const w = world({
      files: { '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE },
      exists: true,
    })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input({ only: ['ci.yml/ci'] }), ROOT), 0)
      assert.match((yield* output).out, /1 passed, 0 failed, 0 cloud only, 0 skipped, 1 not selected with --job/)
      assert.notInclude(
        w.ran.map((r) => r.argv.at(-1)),
        'npm publish',
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an unknown --job is a usage error: exit 2, the jobs there are, and the usage', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input({ only: ['nope'] }), ROOT), 2)
      const { err } = yield* output
      assert.match(err, /^lntt ci: no job nope \(ci\.yml\/ci\)\nusage: lntt ci local /)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('the run holds the lock while its steps run, and gives it back; --no-lock runs without it', () => {
    const w = world({ exists: true })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input(), ROOT), 0)
      assert.deepStrictEqual(w.ran.at(-1)?.locks, [`${LOCKS}/ci-local.lock`])
      assert.strictEqual(w.fs.text(`${LOCKS}/ci-local.lock`), undefined)
      assert.strictEqual(yield* command(input({ lock: false }), ROOT), 0)
      assert.deepStrictEqual(w.ran.at(-1)?.locks, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--list prints the plan, runs nothing and takes no lock, even on a dirty tree', () => {
    const w = world({ git: { status: Effect.succeed(' M dirty') } })
    return Effect.gen(function* () {
      yield* w.fs.put(`${LOCKS}/ci-local.lock`, '{"held":"by another run"}')
      assert.strictEqual(yield* command(input({ list: true }), ROOT), 0)
      const { out } = yield* output
      assert.match(out, /pull request feat\/x → main/)
      assert.match(out, /uses: actions\/checkout@v7\n\s+→ no-op: the working tree is the checkout/)
      assert.deepStrictEqual(w.ran, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('ci.local.lock: project takes a lock file per repository, named after its common dir', () => {
    const w = world({ exists: true, config: { ci: { local: { lock: 'project' } } } })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input(), ROOT), 0)
      const [lock] = w.ran.at(-1)?.locks ?? []
      assert.match(lock ?? '', /^\/cache\/lntt\/ci-local-repo-[0-9a-f]{12}\.lock$/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a lock that cannot be taken is one line naming --no-lock, exit 1, and runs nothing', () => {
    const w = world({
      config: { ci: { local: { lock: 'project' } } },
      git: { commonDir: Effect.fail(new GitError({ args: ['rev-parse'], output: 'not a git repository' })) },
    })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input(), ROOT), 1)
      assert.match(
        (yield* output).err,
        /^lntt ci: cannot take the ci:local lock \(git rev-parse failed: not a git repository\) — \/cache\/lntt; --no-lock runs without it$/,
      )
      assert.deepStrictEqual(w.ran, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('without ci.local: a machine lock, and a step stopped after 30 minutes, naming the load', () => {
    const w = world({ files: { '.github/workflows/ci.yml': CI.replace('echo lint', 'hang') }, exists: true })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(command(input(), ROOT))
      yield* TestClock.adjust(Duration.minutes(30))
      assert.strictEqual(yield* Fiber.join(fiber), 1)
      assert.deepStrictEqual(w.ran[0]?.locks, [`${LOCKS}/ci-local.lock`])
      const { out } = yield* output
      assert.match(out, /✖ ci\.yml\/ci .* failed: run: hang timed out/)
      assert.match(out, /\(timed out after 30m — load 1\.0 \/ 1\.0 \/ 1\.0 on 4 cores\)/)
      assert.match(out, /A timeout is not a verdict on the code/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a timeout from the configuration stops the step', () => {
    const w = world({
      files: { '.github/workflows/ci.yml': CI.replace('echo lint', 'hang') },
      config: { ci: { local: { timeoutMinutes: 0.005 } } },
    })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(command(input(), ROOT))
      yield* TestClock.adjust(Duration.millis(300))
      assert.strictEqual(yield* Fiber.join(fiber), 1)
      assert.match((yield* output).out, /\(timed out after 0\.3s — load /)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--list says which steps the event skips, by the base', () => {
    const files = {
      '.github/workflows/ci.yml': `
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - if: github.base_ref == 'main'
        run: pnpm test
`,
    }
    const w = world({ files })
    return Effect.gen(function* () {
      yield* command(input({ list: true }), ROOT)
      assert.match((yield* output).out, /pnpm test .*\n\s+→ runs on the host/)
      yield* command(input({ list: true, base: 'candidate/1' }), ROOT)
      assert.match((yield* output).out, /pnpm test .*\n\s+→ skipped: the condition is false for this event/)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('container mode', () => {
  it.effect('needs its executors and Docker on the PATH, else one line, exit 1', () => {
    const w = world({ onPath: ['docker'] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input({ container: true }), ROOT), 1)
      assert.strictEqual((yield* output).err, 'lntt ci: container mode needs act on the PATH')
      assert.deepStrictEqual(w.ran, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('runs each job whole through act, with the event file in the command’s folder', () => {
    const w = world({ onPath: ['act', 'docker'] })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input({ container: true }), ROOT), 0)
      assert.deepStrictEqual(w.ran[0]?.argv, [
        'act',
        'pull_request',
        '-W',
        '.github/workflows/ci.yml',
        '-j',
        'ci',
        '-e',
        '/tmp/ci/event.json',
      ])
      assert.deepStrictEqual(JSON.parse(w.fs.text('/tmp/ci/event.json') ?? '{}'), {
        action: 'synchronize',
        pull_request: { draft: false, base: { ref: 'main' }, head: { ref: 'feat/x' } },
      })
    }).pipe(Effect.provide(w.layer))
  })
})

describe('the base', () => {
  const CANDIDATE = { delivery: { candidate: { prefix: 'candidate/' } } }
  const open = { openPullRequests: () => Effect.succeed([{ number: 40, headRefName: 'candidate/13' }]) }

  it.effect('with no candidate: origin/main', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* command(input({ list: true }), ROOT)
      assert.match(
        (yield* output).out,
        /pull request feat\/x → main @ c0ffee12 \(diff against origin\/main, 1 files changed\)/,
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a push with no origin/main: an error that says to fetch, exit 1', () => {
    const w = world({ git: { verify: (rev) => Effect.succeed(rev === 'HEAD' ? 'c0ffee1234' : null) } })
    return Effect.gen(function* () {
      assert.strictEqual(yield* command(input({ list: true, event: 'push' }), ROOT), 1)
      assert.match(
        (yield* output).err,
        /^lntt ci: no origin\/main in this clone: run git fetch origin, or give --base$/,
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an explicit --base wins over the open candidate', () => {
    const w = world({ config: CANDIDATE, gh: open })
    return Effect.gen(function* () {
      yield* command(input({ list: true, base: 'main' }), ROOT)
      assert.match((yield* output).out, /pull request feat\/x → main /)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('GitHub unreachable: origin/main, and it says so', () => {
    const w = world({
      config: CANDIDATE,
      gh: { openPullRequests: () => Effect.fail(new GhError({ args: ['pr', 'list'], output: 'offline' })) },
    })
    return Effect.gen(function* () {
      yield* command(input({ list: true }), ROOT)
      const { out, err } = yield* output
      assert.match(out, /pull request feat\/x → main /)
      assert.match(err, /^lntt ci: .*the open candidate is unknown/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect("a detached HEAD at a candidate's head: the candidate's pull request into main", () => {
    const w = world({
      config: CANDIDATE,
      gh: open,
      git: {
        branch: Effect.succeed('HEAD'),
        current: Effect.succeed(''),
        // HEAD is the candidate's head.
        verify: (rev) =>
          Effect.succeed(
            ['HEAD', 'origin/candidate/13'].includes(rev)
              ? 'c0ffee1234'
              : rev.startsWith('refs/remotes/origin/')
                ? 'abc'
                : null,
          ),
        pointingAt: () => Effect.succeed(['refs/remotes/origin/candidate/13']),
      },
    })
    return Effect.gen(function* () {
      yield* command(input({ list: true }), ROOT)
      assert.match((yield* output).out, /pull request candidate\/13 → main /)
    }).pipe(Effect.provide(w.layer))
  })
})
