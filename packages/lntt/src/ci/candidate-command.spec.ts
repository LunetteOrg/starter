import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestConsole from 'effect/testing/TestConsole'
import { ProjectConfig } from '../config/load.ts'
import { Gh, GhError } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { type CandidateInput, candidate, candidateLayers, proved, reported } from './candidate-command.ts'
import { Board } from './candidate-steps.ts'

const CONFIG = { delivery: { candidate: { prefix: 'candidate/' } } }

// Pull request #7 of feat/x into main, open; no candidate open; an empty base.
const PR = {
  number: 7,
  title: 't',
  body: '',
  baseRefName: 'main',
  headRefName: 'feat/x',
  labels: [],
  mergedAt: null,
  author: { login: 'me' },
  isCrossRepository: false,
}

// GitHub as gh's arguments answer it, the writes recorded; `failing` makes every call fail.
function github(pr: object = PR, failing?: string) {
  const writes: string[] = []
  const reads: string[] = []
  // Recorded when a call runs: Gh builds some of its operations before they are run.
  const layer = Gh.over((args, { write } = {}) =>
    Effect.suspend(() => {
      const line = args.join(' ')
      if (failing) return Effect.fail(new GhError({ args, output: failing }))
      if (write) {
        writes.push(line)
        return Effect.succeed(args[1] === 'create' ? 'https://github.com/o/r/pull/42' : '')
      }
      reads.push(line)
      if (line.startsWith('repo view')) return Effect.succeed('o/r')
      if (line.startsWith('pr view')) return Effect.succeed(JSON.stringify(pr))
      if (line.includes('matching-refs') || line.startsWith('pr list')) return Effect.succeed('[]')
      if (line.includes('commits/main'))
        return Effect.succeed(JSON.stringify({ sha: 'b'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } }))
      return Effect.succeed('')
    }),
  )
  return { writes, reads, layer }
}

const input = (lines: string[], fields: Partial<CandidateInput> = {}): CandidateInput => ({
  merged: false,
  follow: false,
  guard: false,
  dryRun: false,
  env: { GITHUB_REPOSITORY: 'o/r' },
  cwd: '/clone',
  log: (line) => lines.push(line),
  ...fields,
})

const world = (config: Record<string, unknown>, gh = github()) => {
  const fs = memoryFileSystem({ dirs: ['/events'] })
  return {
    fs,
    gh,
    layer: Layer.mergeAll(
      gh.layer,
      Board.none,
      Git.memory({}),
      fs.layer,
      ProjectConfig.memory(config),
      TestConsole.layer,
    ),
  }
}

const event = (head: string) =>
  JSON.stringify({
    pull_request: {
      number: 7,
      title: 't',
      body: '',
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      head: { ref: head, repo: { full_name: 'o/r' } },
    },
  })

describe('lntt ci candidate', () => {
  it.effect('without delivery.candidate it does nothing, with a notice, and asks nothing', () => {
    const w = world({})
    const lines: string[] = []
    return Effect.gen(function* () {
      assert.strictEqual(yield* reported(candidate(input(lines))), 0)
      assert.deepStrictEqual(lines, [
        '::notice::no delivery.candidate in .agents/config: the candidate automation does nothing',
      ])
      assert.deepStrictEqual(w.gh.reads, [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    '--guard reads the event: the candidate passes, a pull request left on main fails with an annotation',
    () => {
      const w = world(CONFIG)
      return Effect.gen(function* () {
        yield* w.fs.put('/events/candidate.json', event('candidate/3'))
        yield* w.fs.put('/events/left.json', event('feat/x'))
        const lines: string[] = []
        const at = (path: string) =>
          reported(candidate(input(lines, { guard: true, env: { GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: 'o/r' } })))
        assert.strictEqual(yield* at('/events/candidate.json'), 0)
        assert.strictEqual(yield* at('/events/left.json'), 1)
        assert.match(lines[0] ?? '', /^candidate guard: #7 passes: /)
        assert.match(lines[1] ?? '', /^::error title=Not on the candidate::/)
        assert.deepStrictEqual(w.gh.reads, [])
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect(
    '--guard --pr reads the pull request with gh; --guard needs a pull_request event, else a usage error',
    () => {
      const w = world(CONFIG)
      const lines: string[] = []
      return Effect.gen(function* () {
        assert.strictEqual(yield* reported(candidate(input(lines, { guard: true, pr: '7' }))), 1)
        assert.match(lines[0] ?? '', /^::error title=Not on the candidate::#7 targets main/)
        assert.strictEqual(yield* reported(candidate(input([], { guard: true, env: {} }))), 2)
        yield* w.fs.put('/events/push.json', JSON.stringify({ ref: 'refs/heads/main' }))
        assert.strictEqual(
          yield* reported(candidate(input([], { guard: true, env: { GITHUB_EVENT_PATH: '/events/push.json' } }))),
          2,
        )
        const err = (yield* TestConsole.errorLines).join('\n')
        assert.match(
          err,
          /lntt ci: --guard without --pr reads the pull request from GITHUB_EVENT_PATH\nusage: lntt ci local /,
        )
        assert.match(err, /lntt ci: --guard runs on a pull_request event/)
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a usage error found once the configuration is read exits 2, with the usage', () => {
    const w = world(CONFIG)
    return Effect.gen(function* () {
      assert.strictEqual(yield* reported(candidate(input([], { env: { GITHUB_REPOSITORY: 'o/r' } }))), 2)
      assert.strictEqual(yield* reported(candidate(input([], { pr: 'x7' }))), 2)
      const err = (yield* TestConsole.errorLines).join('\n')
      assert.match(
        err,
        /^lntt ci: without --pr or --follow, GITHUB_EVENT_PATH must name the event\nusage: lntt ci local /,
      )
      assert.match(err, /lntt ci: --pr takes a number, not x7/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an event file that holds no object, or no JSON, is one line, exit 1', () => {
    const w = world(CONFIG)
    return Effect.gen(function* () {
      for (const [name, text] of [
        ['null', 'null'],
        ['list', '[]'],
        ['text', '"x"'],
        ['broken', '{'],
      ] as const) {
        yield* w.fs.put(`/events/${name}.json`, text)
        const env = { GITHUB_EVENT_PATH: `/events/${name}.json`, GITHUB_REPOSITORY: 'o/r' }
        assert.strictEqual(yield* reported(candidate(input([], { env }))), 1)
      }
      const err = yield* TestConsole.errorLines
      assert.deepStrictEqual(err.slice(0, 3), [
        'lntt ci: /events/null.json holds no event object',
        'lntt ci: /events/list.json holds no event object',
        'lntt ci: /events/text.json holds no event object',
      ])
      assert.match(String(err[3]), /^lntt ci: \/events\/broken\.json: /)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--pr from a terminal: an open pull request is opened and moved, and the base is not followed', () => {
    const w = world(CONFIG)
    const lines: string[] = []
    return Effect.gen(function* () {
      assert.strictEqual(yield* reported(candidate(input(lines, { pr: '7' }))), 0)
      assert.ok(
        lines.some((l) => /^candidate: #7 \(feat\/x → main\): moving it/.test(l)),
        lines.join('\n'),
      )
      assert.ok(
        lines.some((l) => /^candidate: follow main: no git client in this run/.test(l)),
        lines.join('\n'),
      )
      assert.include(w.gh.writes, 'pr edit 7 --repo o/r --base candidate/1')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'a merged pull request is closed; --event, --merged, --labels and --head-ref override what GitHub says',
    () =>
      Effect.gen(function* () {
        const merged: string[] = []
        yield* reported(candidate(input(merged, { pr: '7' }))).pipe(
          Effect.provide(world(CONFIG, github({ ...PR, mergedAt: '2026-11-13T00:00:00Z' })).layer),
        )
        assert.include(merged, 'candidate: #7 is not a merge into a candidate, nothing to record.')
        const open = world(CONFIG).layer
        const labelled: string[] = []
        yield* reported(candidate(input(labelled, { pr: '7', labels: 'hotfix' }))).pipe(Effect.provide(open))
        assert.ok(
          labelled.some((l) => /^candidate: #7 \(feat\/x → main\): it stays/.test(l)),
          labelled.join('\n'),
        )
        const renamed: string[] = []
        yield* reported(candidate(input(renamed, { pr: '7', headRef: 'hotfix/x' }))).pipe(Effect.provide(open))
        assert.ok(
          renamed.some((l) => /^candidate: #7 \(hotfix\/x → main\): it stays/.test(l)),
          renamed.join('\n'),
        )
        // Into a candidate: closed is no merge to record, --merged makes it one.
        const intoCandidate = world(CONFIG, github({ ...PR, baseRefName: 'candidate/3' }))
        const closed: string[] = []
        assert.strictEqual(
          yield* reported(candidate(input(closed, { pr: '7', event: 'closed' }))).pipe(
            Effect.provide(intoCandidate.layer),
          ),
          0,
        )
        assert.include(closed, 'candidate: #7 is not a merge into a candidate, nothing to record.')
        const recorded = yield* reported(candidate(input([], { pr: '7', event: 'closed', merged: true }))).pipe(
          Effect.provide(intoCandidate.layer),
          Effect.flatMap((code) => Effect.map(TestConsole.errorLines, (err) => [code, err.at(-1)] as const)),
          Effect.provide(TestConsole.layer),
        )
        assert.strictEqual(recorded[0], 1)
        assert.match(
          String(recorded[1]),
          /^lntt ci: no open pull request from candidate\/3 into main: the issues of #7 .* are not recorded\.$/,
        )
      }),
  )

  it.effect('--follow follows the base with the clone, and handles no pull request', () => {
    const w = world(CONFIG)
    const lines: string[] = []
    return Effect.gen(function* () {
      assert.strictEqual(yield* reported(candidate(input(lines, { follow: true }))), 0)
      assert.ok(
        lines.some((l) => /^candidate: follow main: /.test(l)),
        lines.join('\n'),
      )
      assert.notOk(
        lines.some((l) => /no git client/.test(l)),
        lines.join('\n'),
      )
      assert.notOk(w.gh.reads.some((r) => r.startsWith('pr view')))
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'a push to the base follows it with the clone; outside Actions the repository is the one gh works on',
    () => {
      const w = world(CONFIG)
      const lines: string[] = []
      return Effect.gen(function* () {
        yield* w.fs.put('/events/push.json', JSON.stringify({ ref: 'refs/heads/main' }))
        assert.strictEqual(
          yield* reported(candidate(input(lines, { env: { GITHUB_EVENT_PATH: '/events/push.json' } }))),
          0,
        )
        assert.strictEqual(w.gh.reads[0], 'repo view --json nameWithOwner --jq .nameWithOwner')
        assert.ok(
          lines.some((l) => /^candidate: follow main: /.test(l)),
          lines.join('\n'),
        )
        assert.notOk(
          lines.some((l) => /no git client/.test(l)),
          lines.join('\n'),
        )
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a failure of the automation is one line, exit 1', () => {
    const w = world(CONFIG, github(PR, 'offline'))
    return Effect.gen(function* () {
      assert.strictEqual(yield* reported(candidate(input([], { pr: '7' }))), 1)
      assert.deepStrictEqual(yield* TestConsole.errorLines, ['lntt ci: gh pr view failed: offline'])
    }).pipe(Effect.provide(w.layer))
  })
})

// gh as a spawner in memory: what each call's environment held.
function spawner() {
  const envs: (Record<string, unknown> | undefined)[] = []
  const asked: string[][] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      envs.push(command.options.env)
      asked.push([command.command, ...command.args.map(String)])
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode('o/r')),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  return { envs, asked, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)) }
}

describe('the board’s client', () => {
  const boardOf = (env: Record<string, string>) => {
    const s = spawner()
    return Effect.gen(function* () {
      const board = (yield* Board).gh
      if (board) yield* board.repository
      return { board: board !== null, envs: s.envs }
    }).pipe(
      Effect.provide(
        candidateLayers({ env, cwd: '/clone', dryRun: false, log: () => {} }).pipe(Layer.provide(s.layer)),
      ),
    )
  }

  it.effect(
    'the Projects token in a workflow that has one; none in a workflow without it; the operator’s gh in a terminal',
    () =>
      Effect.gen(function* () {
        const token = yield* boardOf({ GITHUB_ACTIONS: 'true', PROJECTS_GH_TOKEN: 'projects' })
        assert.deepStrictEqual(token, { board: true, envs: [{ GH_TOKEN: 'projects' }] })
        assert.deepStrictEqual((yield* boardOf({ GITHUB_ACTIONS: 'true' })).board, false)
        const terminal = yield* boardOf({})
        assert.deepStrictEqual(terminal, { board: true, envs: [undefined] })
      }),
  )
})

describe('the clone’s git', () => {
  it.effect('authenticates through its environment in Actions, never through its arguments', () => {
    const s = spawner()
    return Effect.gen(function* () {
      yield* (yield* Git).isShallow
      const env = s.envs[0] as Record<string, string>
      assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader')
      assert.strictEqual(
        env.GIT_CONFIG_VALUE_0,
        `AUTHORIZATION: basic ${Buffer.from('x-access-token:secret').toString('base64')}`,
      )
      assert.notInclude(s.asked.flat().join(' '), 'secret')
    }).pipe(
      Effect.provide(
        candidateLayers({
          env: { GITHUB_ACTIONS: 'true', GH_TOKEN: 'secret' },
          cwd: '/clone',
          dryRun: false,
          log: () => {},
        }).pipe(Layer.provide(s.layer)),
      ),
    )
  })
})

describe('lntt ci proved', () => {
  const provedWorld = (gh: ReturnType<typeof github>, git = Git.memory({})) =>
    Layer.mergeAll(gh.layer, git, memoryFileSystem({ dirs: ['/events'] }).layer, TestConsole.layer)

  it.effect('an API error is not proved: exit 1, with the reason and the annotation of a full run in Actions', () => {
    const lines: string[] = []
    return Effect.gen(function* () {
      const code = yield* reported(
        proved({
          jobs: ['ci'],
          workflow: 'ci.yml',
          sha: 'a'.repeat(40),
          before: 'c'.repeat(40),
          env: { GITHUB_REPOSITORY: 'o/r', GITHUB_ACTIONS: 'true', GITHUB_REF_NAME: 'main' },
          cwd: '/clone',
          log: (line) => lines.push(line),
        }),
      )
      assert.strictEqual(code, 1)
      assert.match(
        lines[0] ?? '',
        /^::notice title=Full run::not proved: gh api repos\/o\/r\/commits\/a{40}\/pulls failed: HTTP 502$/,
      )
    }).pipe(Effect.provide(provedWorld(github(PR, 'HTTP 502'))))
  })

  it.effect(
    'in Actions, the previous tip is the push event’s: a commit id goes on to GitHub, anything else is none',
    () => {
      const fs = memoryFileSystem({ dirs: ['/events'] })
      const lines: string[] = []
      const layer = Layer.mergeAll(github(PR, 'HTTP 502').layer, Git.memory({}), fs.layer, TestConsole.layer)
      return Effect.gen(function* () {
        yield* fs.put('/events/push.json', JSON.stringify({ before: 'c'.repeat(40) }))
        yield* fs.put('/events/odd.json', JSON.stringify({ before: 7 }))
        for (const path of ['/events/push.json', '/events/odd.json']) {
          yield* reported(
            proved({
              jobs: ['ci'],
              workflow: 'ci.yml',
              env: {
                GITHUB_REPOSITORY: 'o/r',
                GITHUB_SHA: 'd'.repeat(40),
                GITHUB_REF_NAME: 'main',
                GITHUB_EVENT_PATH: path,
              },
              cwd: '/clone',
              log: (line) => lines.push(line),
            }),
          )
        }
        assert.match(lines[0] ?? '', /^not proved: gh api repos\/o\/r\/commits\/d{40}\/pulls failed: HTTP 502$/)
        assert.strictEqual(lines[1], 'not proved: no previous tip of main to compare with')
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('from a terminal, the sha is HEAD; with no push event there is no previous tip', () => {
    const lines: string[] = []
    return Effect.gen(function* () {
      const code = yield* reported(
        proved({
          jobs: ['ci'],
          workflow: 'ci.yml',
          branch: 'main',
          env: { GITHUB_REPOSITORY: 'o/r' },
          cwd: '/clone',
          log: (l) => lines.push(l),
        }),
      )
      assert.strictEqual(code, 1)
      assert.deepStrictEqual(lines, ['not proved: no previous tip of main to compare with'])
    }).pipe(
      Effect.provide(
        provedWorld(github(), Git.memory({ verify: (rev) => Effect.succeed(rev === 'HEAD' ? 'a'.repeat(40) : null) })),
      ),
    )
  })
})
