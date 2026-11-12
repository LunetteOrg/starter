import { readdirSync, readFileSync } from 'node:fs'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import { ProjectConfig } from '../config/load.ts'
import { Gh, GhError, type Issue } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import { answer, Mailbox, MailboxFailed, pending } from '../messages/mailbox.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { AgentsDir, command, type StartCommand } from './start.ts'

const BOX = '/repo/.git/lntt-messages'
const AGENTS = '/lntt/agents'
const THEME = 'release-0-6-1'
const COORDINATOR_BRANCH = `chore/no-issue/${THEME}`

const ISSUES: Record<number, Issue> = {
  84: { title: 'Coordinator mode: a theme parent delegates', labels: [{ name: 'enhancement' }], type: null },
  89: { title: 'Board status for released issues', labels: [{ name: 'enhancement' }], type: null },
}

const CONFIG = {
  coordinator: {
    gate: 'propose',
    models: {
      coordinator: { model: 'sonnet' },
      children: { S: { model: 'sonnet' }, M: { model: 'opus', effort: 'high' } },
    },
  },
}

const encode = (text: string) => new TextEncoder().encode(text)

// The repository at /repo with origin/main fetched, GitHub's issues, the project's configuration,
// the mailbox in its git directory, lntt's templates, and an orca that records each call and
// answers a worktree create (or refuses it, with `orcaFails`).
function world(config: Record<string, unknown> = CONFIG) {
  const fs = memoryFileSystem({ dirs: ['/repo/.git', AGENTS] })
  const shipped = new URL('../../agents/', import.meta.url)
  for (const name of readdirSync(shipped).filter((name) => name.endsWith('.md'))) {
    fs.files.set(`${AGENTS}/${name}`, { text: readFileSync(new URL(name, shipped), 'utf8'), mtime: 0 })
  }
  const state = { orca: [] as string[][], orcaFails: false, mailbox: BOX as string | MailboxFailed }
  const spawn = (cmd: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (cmd._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = cmd.args.map(String)
      let out = ''
      let err = ''
      let code = 0
      if (cmd.command === 'sh') out = '/opt/orca/bin/orca\n'
      else if (cmd.command === 'orca') {
        state.orca.push(args)
        if (args.includes('--help')) out = 'Usage: orca worktree create --name <n> [--model <id>] [--effort <level>]\n'
        else if (state.orcaFails) {
          err = 'orca: the terminal did not start'
          code = 1
        } else {
          const name = args[args.indexOf('--name') + 1]
          out = JSON.stringify({
            result: { worktree: { path: `/orca/${name}` }, launch: { outcome: { handle: 'term_1' } } },
          })
        }
      } else return yield* Effect.die(`not expected: ${cmd.command}`)
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(out)),
        stderr: Stream.make(encode(err)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = Layer.mergeAll(
    fs.layer,
    ProjectConfig.memory(config),
    Git.memory({
      commonDir: Effect.succeed('/repo/.git'),
      originHead: Effect.succeed(null),
      verify: (rev) =>
        Effect.succeed(rev.startsWith('refs/remotes/origin/main') || rev === 'origin/main' ? 'c1' : null),
    }),
    Gh.memory({
      issue: (n) =>
        ISSUES[n]
          ? Effect.succeed(ISSUES[n])
          : Effect.fail(new GhError({ args: ['api', `issues/${n}`], output: 'HTTP 404' })),
    }),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)),
  )
  // One run of `lntt worktree start --host orca`: its exit code, stdout and stderr.
  const lntt = (parsed: Partial<StartCommand>) =>
    Effect.gen(function* () {
      const code = yield* command({
        issues: [],
        host: 'orca',
        given: {},
        noAgent: false,
        coordinator: false,
        approve: [],
        workflow: false,
        pollMs: 50,
        ...parsed,
      })
      return { code, out: (yield* TestConsole.logLines).join('\n'), err: (yield* TestConsole.errorLines).join('\n') }
    }).pipe(
      Effect.provideService(AgentsDir, AGENTS),
      Effect.provide(Layer.fresh(TestConsole.layer)),
      Effect.provide(Layer.suspend(() => Mailbox.at(state.mailbox))),
    )
  const creates = () => state.orca.filter((a) => a[0] === 'worktree' && a[1] === 'create' && !a.includes('--help'))
  const markers = () =>
    [...fs.files.entries()]
      .filter(([path]) => path.startsWith(`${BOX}/started/`))
      .map(([, file]) => JSON.parse(file.text) as Record<string, unknown>)
  const putMarker = (marker: Record<string, unknown>) =>
    fs.put(`${BOX}/started/${encodeURIComponent(marker.branch as string)}.json`, `${JSON.stringify(marker)}\n`)
  // The theme's coordinator worktree, started.
  const coordinated = () => putMarker({ branch: COORDINATOR_BRANCH, issue: null, to: 'orchestrator', theme: THEME })
  const approved = (...issues: number[]) => fs.put(`${BOX}/approved-${THEME}.txt`, `${issues.join('\n')}\n`)
  const child = (more: Partial<StartCommand> = {}): Partial<StartCommand> => ({
    issues: [89],
    theme: THEME,
    parent: 'current',
    context: 'Your neighbours: #89 (no lntt code).\n',
    ...more,
  })
  return { fs, state, layer, lntt, creates, markers, putMarker, coordinated, approved, child }
}

const flagOf = (call: string[] | undefined, flag: string) => call?.[call.indexOf(flag) + 1]

describe('lntt worktree start --coordinator', () => {
  it.effect('--prompt adds to the coordinator’s brief, in a section of its own at the end', () => {
    const w = world()
    return Effect.gen(function* () {
      const r = yield* w.lntt({ coordinator: true, theme: 't', issues: [84], prompt: 'extra' })
      assert.strictEqual(r.code, 0, r.err)
      const brief = flagOf(w.creates()[0], '--prompt') as string
      assert.match(brief, /You write no code/)
      assert.match(brief, /#84: Coordinator mode/)
      assert.match(brief, /\/opt\/orca\/bin\/orca worktree set/)
      assert.ok(brief.endsWith('\n\n## Added at start\n\nextra\n'), brief)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a start that fails leaves no marker: the theme has no coordinator, and no gate waits', () => {
    const w = world()
    return Effect.gen(function* () {
      w.state.orcaFails = true
      const failed = yield* w.lntt({ coordinator: true, theme: THEME, issues: [84] })
      assert.deepStrictEqual(
        [failed.code, failed.err.split('\n').at(-1)],
        [1, 'lntt worktree: orca worktree create: orca: the terminal did not start'],
      )
      assert.deepStrictEqual(w.markers(), [])
      w.state.orcaFails = false
      const r = yield* w.lntt(w.child())
      assert.strictEqual(r.code, 0, r.err)
      assert.notInclude(r.err, 'no child is created')
      assert.match(flagOf(w.creates().at(-1), '--prompt') as string, /lntt ask --to orchestrator --issue 89/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a second start that fails leaves the live coordinator’s marker', () => {
    const w = world()
    return Effect.gen(function* () {
      // The live marker carries a field the start would not write: only a restore keeps it.
      const live = {
        branch: COORDINATOR_BRANCH,
        issue: null,
        to: 'orchestrator',
        theme: THEME,
        since: 'the first start',
      }
      yield* w.putMarker(live)
      w.state.orcaFails = true
      assert.strictEqual((yield* w.lntt({ coordinator: true, theme: THEME, issues: [84] })).code, 1)
      assert.deepStrictEqual(w.markers(), [live])
    }).pipe(Effect.provide(w.layer))
  })
})

describe('lntt worktree start --theme (a coordinator’s child)', () => {
  it.effect(
    'a theme with no coordinator worktree: the child reports to the orchestrator, the theme’s context and Size kept',
    () => {
      const w = world()
      return Effect.gen(function* () {
        const r = yield* w.lntt(w.child({ size: 'M' }))
        assert.strictEqual(r.code, 0, r.err)
        const [call] = w.creates()
        assert.strictEqual(flagOf(call, '--model'), 'opus')
        const brief = flagOf(call, '--prompt') as string
        assert.match(brief, /## The theme\n\nYour neighbours: #89/)
        assert.match(brief, /lntt ask --to orchestrator --issue 89 "#89 ready: /)
        assert.notMatch(brief, /--to coordinator|your coordinator|the coordinator/i)
        const [marker] = w.markers()
        assert.deepStrictEqual(marker, { branch: marker?.branch, issue: 89, to: 'orchestrator' })
        assert.match(r.err, /theme release-0-6-1 has no coordinator worktree/)
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a marker of the theme that is not the coordinator’s (a child’s, on an issue) is no coordinator', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.putMarker({ branch: COORDINATOR_BRANCH, issue: 89, to: 'coordinator', theme: THEME })
      const r = yield* w.lntt(w.child())
      assert.strictEqual(r.code, 0, r.err)
      assert.match(flagOf(w.creates()[0], '--prompt') as string, /lntt ask --to orchestrator --issue 89/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    '--prompt adds to a child’s brief, with --context and --workflow; without --workflow there is no section',
    () => {
      const w = world()
      return Effect.gen(function* () {
        yield* w.coordinated()
        yield* w.approved(89)
        yield* w.lntt(w.child({ workflow: true, prompt: 'Rebase on #84 first.' }))
        const brief = flagOf(w.creates()[0], '--prompt') as string
        assert.match(brief, /^You are working on issue #89/)
        assert.match(brief, /## The theme\n\nYour neighbours: #89/)
        assert.match(brief, /At most 6 agents/)
        assert.ok(brief.endsWith('\n\n## Added at start\n\nRebase on #84 first.\n'), brief)
        yield* w.lntt(w.child())
        assert.notMatch(flagOf(w.creates()[1], '--prompt') as string, /ultracode|workflow/i)
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('the command line wins over the Size; a Size that does not exist is refused before anything', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.coordinated()
      yield* w.approved(89)
      yield* w.lntt(w.child({ size: 'M', given: { model: 'haiku' } }))
      assert.strictEqual(flagOf(w.creates()[0], '--model'), 'haiku')
      const size = yield* w.lntt(w.child({ size: 'XXL' }))
      assert.strictEqual(size.code, 1)
      assert.match(size.err, /XS, S, M, L or XL/)
      assert.strictEqual(w.creates().length, 1)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('gate: free starts at once', () => {
    const w = world({ coordinator: { gate: 'free' } })
    return Effect.gen(function* () {
      yield* w.coordinated()
      const r = yield* w.lntt(w.child())
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.creates().length, 1)
    }).pipe(Effect.provide(w.layer))
  })

  // The proposal waits for the orchestrator's answer on the mailbox; the answer comes on the TestClock.
  const proposed = (w: ReturnType<typeof world>, reply: string) =>
    Effect.gen(function* () {
      yield* w.coordinated()
      const starting = yield* Effect.forkChild(w.lntt(w.child()))
      yield* TestClock.adjust('10 millis')
      const [message] = yield* pending(BOX, 'orchestrator')
      assert.match(
        message?.question ?? '',
        /^Coordinator release-0-6-1 proposes to start:\n- #89: Board status for released issues \(on origin\/main\)/,
      )
      assert.deepStrictEqual(w.creates(), [], 'nothing is created while the answer is awaited')
      yield* answer(BOX, message?.id as string, reply)
      yield* TestClock.adjust('100 millis')
      return yield* Fiber.join(starting)
    })

  it.effect('an approval starts the child and is kept, so the same child is not proposed twice', () => {
    const w = world()
    return Effect.gen(function* () {
      const r = yield* proposed(w, 'approve')
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.creates().length, 1)
      assert.strictEqual(w.fs.text(`${BOX}/approved-${THEME}.txt`), '89\n')
    }).pipe(Effect.provide(w.layer))
  })

  for (const [reply, why] of [
    ['not yet: #84 merges first', 'an answer that does not approve stops the start, with the reason'],
    ['yes, but not #89 yet', 'an answer that adds a condition does not approve'],
  ] as const) {
    it.effect(why, () => {
      const w = world()
      return Effect.gen(function* () {
        const r = yield* proposed(w, reply)
        assert.strictEqual(r.code, 1)
        assert.include(r.err, `lntt worktree: not approved by the orchestrator: ${reply}`)
        assert.deepStrictEqual(w.creates(), [])
      }).pipe(Effect.provide(w.layer))
    })
  }
})

describe('the marker of who a branch reports to', () => {
  it.effect('is written before the host starts: a start that fails still leaves it', () => {
    const w = world()
    return Effect.gen(function* () {
      w.state.orcaFails = true
      const r = yield* w.lntt({ issues: [89] })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /the terminal did not start/)
      const [marker] = w.markers()
      assert.deepStrictEqual(marker, { branch: marker?.branch, issue: 89, to: 'orchestrator' })
      assert.match(marker?.branch as string, /^[a-z]+\/89\//)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('one that cannot be written is a warning: the start goes on', () => {
    const w = world()
    return Effect.gen(function* () {
      w.state.mailbox = new MailboxFailed({ message: 'the mailbox is not a directory' })
      const r = yield* w.lntt({ issues: [89] })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(
        r.err,
        /^lntt worktree start: could not record who [a-z]+\/89\/\S+ reports to: the mailbox is not a directory$/m,
      )
      assert.strictEqual(w.creates().length, 1)
      assert.strictEqual(JSON.parse(r.out).issue, 89)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('what stops a start before anything is created', () => {
  it.effect('an issue GitHub cannot read', () => {
    const w = world()
    return Effect.gen(function* () {
      const missing = yield* w.lntt({ issues: [404] })
      assert.deepStrictEqual([missing.code, missing.err], [1, 'lntt worktree: gh api issues/404 failed: HTTP 404'])
      assert.deepStrictEqual(w.creates(), [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an agent that cannot take what was asked', () => {
    const w = world()
    return Effect.gen(function* () {
      const r = yield* w.lntt({ issues: [89], given: { kind: 'opencode', effort: 'high' } })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /opencode takes no effort from the command line/)
      assert.deepStrictEqual(w.state.orca, [])
    }).pipe(Effect.provide(w.layer))
  })
})
