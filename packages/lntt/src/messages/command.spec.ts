import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import { ConfigInvalid, ProjectConfig } from '../config/load.ts'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { command, type MessagesCommand } from './command.ts'
import { Mailbox } from './mailbox.ts'

const GIT = '/repo/.git'
const DIR = `${GIT}/lntt-messages`
const HOUR = 3_600_000

// A repository whose main checkout is /repo and whose linked worktree /w/other has `other` checked
// out (the branch git names, as `worktrees` lists it), the mailbox in its git common directory.
function world() {
  const fs = memoryFileSystem({ dirs: ['/repo', '/w/other', GIT] })
  const git = { branches: { '/repo': 'main', '/w/other': 'other' } as Record<string, string>, listed: 0 }
  const layer = Layer.mergeAll(
    fs.layer,
    Mailbox.at(DIR),
    ProjectConfig.memory({}),
    Git.memory({
      worktrees: () =>
        Effect.sync(() => {
          git.listed++
          return Object.entries(git.branches)
            .map(([path, branch]) => `worktree ${path}\nHEAD 1\nbranch refs/heads/${branch}`)
            .join('\n\n')
        }),
    }),
  )
  // A child that reports to a role, with a marker written long ago, as a started child's is: a
  // marker younger than a minute is a start in progress, live and never cleared.
  const marker = (branch: string, to = 'orchestrator', extra: object = {}) =>
    fs.put(
      `${DIR}/started/${encodeURIComponent(branch)}.json`,
      `${JSON.stringify({ branch, issue: 7, to, ...extra })}\n`,
      HOUR,
    )
  const markers = () =>
    [...fs.files.keys()]
      .filter((path) => path.startsWith(`${DIR}/started/`))
      .map((path) => path.slice(`${DIR}/started/`.length))
  // The worktree /w/other is removed.
  const remove = () => {
    delete git.branches['/w/other']
  }
  // One run of `lntt ask`, `inbox` or `answer`: its exit code, stdout and stderr.
  const lntt = (parsed: MessagesCommand) =>
    Effect.gen(function* () {
      const code = yield* command(parsed)
      return {
        code,
        out: (yield* TestConsole.logLines).join('\n'),
        err: (yield* TestConsole.errorLines).join('\n'),
      }
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)))
  const ask = (question: string, options: Partial<Extract<MessagesCommand, { kind: 'ask' }>> = {}) =>
    lntt({ kind: 'ask', to: 'orchestrator', question, intervalMs: 50, timeoutMs: 100, ...options })
  const inbox = (role: string, options: Partial<Extract<MessagesCommand, { kind: 'inbox' }>> = {}) =>
    lntt({ kind: 'inbox', role, address: {}, wait: false, follow: false, intervalMs: 50, ...options })
  const answer = (id: string, text: string) => lntt({ kind: 'answer', id, text })
  // A command in the background, and its outcome once it ends.
  const background = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.forkChild(effect)
  return { fs, git, layer, marker, markers, remove, lntt, ask, inbox, answer, background }
}

// A question left unanswered: its timeout passes on the TestClock.
const unanswered = <A, E, R>(w: ReturnType<typeof world>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* w.background(effect)
    yield* TestClock.adjust('1 second')
    return yield* Fiber.join(fiber)
  })

const lines = (out: string) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; to: string; topic: string; path: string; question: string })

describe('lntt ask / inbox / answer', () => {
  it.effect('a child asks the orchestrator about its issue: the issue tags the topic, inbox and answer find it', () => {
    const w = world()
    return Effect.gen(function* () {
      const asked = yield* unanswered(w, w.ask('q', { issue: 84, topic: 'limit' }))
      assert.strictEqual(asked.code, 1)
      assert.match(asked.err, /no answer to \d{8}-\d{6}-issue-84-limit in 0\.1 s/)
      const [message] = lines((yield* w.inbox('orchestrator')).out)
      assert.strictEqual(message?.topic, 'issue-84-limit')
      assert.strictEqual(message?.path, `${DIR}/to-orchestrator/${message?.id}.md`)
      assert.strictEqual((yield* w.answer(message?.id as string, 'go')).code, 0)
      assert.strictEqual((yield* w.inbox('orchestrator')).out, '')
      assert.ok(!w.fs.files.has(`${DIR}/to-child-84`))
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a hand-written question with its .answer.md is answered: not in the inbox', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(`${DIR}/to-coordinator/20261015-090000-adr-level.md`, 'Which ADR level?\n')
      yield* w.fs.put(`${DIR}/to-coordinator/20261015-090000-adr-level.answer.md`, 'Level 2.\n')
      assert.strictEqual((yield* w.inbox('coordinator')).out, '')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a child is addressed by its issue; two coordinators have a mailbox each', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* unanswered(w, w.ask('Try X', { to: 'child', issue: 84, topic: 'hint' }))
      assert.strictEqual(lines((yield* w.inbox('child', { address: { issue: 84 } })).out)[0]?.question, 'Try X')
      assert.strictEqual((yield* w.inbox('child')).out, '')
      yield* unanswered(w, w.ask('for alpha', { to: 'coordinator', theme: 'alpha', topic: 'q' }))
      assert.strictEqual(
        lines((yield* w.inbox('coordinator', { address: { theme: 'alpha' } })).out)[0]?.question,
        'for alpha',
      )
      assert.strictEqual((yield* w.inbox('coordinator', { address: { theme: 'beta' } })).out, '')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a child of a theme asks its coordinator about its issue, and the coordinator answers', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other', 'coordinator', { theme: 'alpha' })
      const asking = yield* w.background(
        w.ask('Which base?', { to: 'coordinator', theme: 'alpha', issue: 84, timeoutMs: 20_000 }),
      )
      yield* TestClock.adjust('10 millis')
      const listed = yield* w.inbox('coordinator', { address: { theme: 'alpha' }, wait: true, timeoutMs: 20_000 })
      const [message] = lines(listed.out)
      assert.strictEqual(message?.topic, 'issue-84-which-base')
      assert.strictEqual((yield* w.answer(message?.id as string, 'main')).code, 0)
      yield* TestClock.adjust('1 second')
      const asked = yield* Fiber.join(asking)
      assert.deepStrictEqual([asked.code, asked.out], [0, 'main'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('inbox --issue still narrows only a child; a role that is none is refused', () => {
    const w = world()
    return Effect.gen(function* () {
      const narrowed = yield* w.inbox('orchestrator', { address: { issue: 84 } })
      assert.deepStrictEqual([narrowed.code, narrowed.err], [1, 'lntt inbox: --issue narrows only a child'])
      const boss = yield* w.ask('q', { to: 'boss' })
      assert.strictEqual(boss.code, 1)
      assert.match(boss.err, /^lntt ask: a message goes to the orchestrator, coordinator or child, not boss$/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an unknown id is one line and exit 1', () => {
    const w = world()
    return Effect.gen(function* () {
      const unknown = yield* w.answer('20260101-000000-none', 'x')
      assert.deepStrictEqual([unknown.code, unknown.err], [1, `lntt answer: no message 20260101-000000-none in ${DIR}`])
    }).pipe(Effect.provide(w.layer))
  })
})

describe('lntt ask --wait', () => {
  const wait = (w: ReturnType<typeof world>, id: string, timeoutMs?: number) =>
    w.lntt({ kind: 'wait', id, intervalMs: 50, ...(timeoutMs === undefined ? {} : { timeoutMs }) })

  it.effect('waits for the answer of a message already sent; an answer already there is printed at once', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* unanswered(w, w.ask('q', { topic: 'later' }))
      const [{ id } = { id: '' }] = lines((yield* w.inbox('orchestrator')).out)
      const waiting = yield* w.background(wait(w, id, 20_000))
      yield* TestClock.adjust('100 millis')
      yield* w.answer(id, 'Yes.')
      yield* TestClock.adjust('100 millis')
      const waited = yield* Fiber.join(waiting)
      assert.deepStrictEqual([waited.code, waited.out], [0, 'Yes.'])
      assert.include(waited.err, `waiting for the answer to ${id}`)
      const again = yield* wait(w, `${id}.md`)
      assert.deepStrictEqual([again.code, again.out], [0, 'Yes.'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('the answer is printed with one newline at its end, whatever the file ends with', () => {
    const w = world()
    return Effect.gen(function* () {
      const cases = [
        ['20260101-000000-bare', 'Go.', 'Go.'],
        ['20260101-000000-one', 'Go.\n', 'Go.'],
        ['20260101-000000-two', 'Go.\n\n', 'Go.\n'],
      ] as const
      for (const [id, text, printed] of cases) {
        yield* w.fs.put(`${DIR}/to-orchestrator/${id}.md`, 'q\n')
        yield* w.fs.put(`${DIR}/to-orchestrator/${id}.answer.md`, text)
        const r = yield* wait(w, id)
        assert.deepStrictEqual([r.code, r.out], [0, printed], id)
      }
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('finds a message sent to a child', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(`${DIR}/to-child-84/20260101-000000-decision.md`, 'q\n')
      yield* w.fs.put(`${DIR}/to-child-84/20260101-000000-decision.answer.md`, 'Go.\n')
      const r = yield* wait(w, '20260101-000000-decision')
      assert.deepStrictEqual([r.code, r.out], [0, 'Go.'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an unknown id, no answer in time, or an id in two directories: exit 1, one line', () => {
    const w = world()
    return Effect.gen(function* () {
      const unknown = yield* wait(w, '20260101-000000-none')
      assert.strictEqual(unknown.code, 1)
      assert.match(unknown.err, /^lntt ask: no message 20260101-000000-none/)
      yield* w.fs.put(`${DIR}/to-coordinator-alpha/20261015-090000-q.md`, 'Q\n')
      const late = yield* unanswered(w, wait(w, '20261015-090000-q', 100))
      assert.strictEqual(late.code, 1)
      assert.match(late.err, /no answer to 20261015-090000-q in 0\.1 s/)
      yield* w.fs.put(`${DIR}/to-orchestrator/20261015-090000-q.md`, 'Q\n')
      const twice = yield* wait(w, '20261015-090000-q', 100)
      assert.strictEqual(twice.code, 1)
      assert.match(twice.err, /^lntt ask: 20261015-090000-q names more than one message: /)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('lntt inbox follows the children that report to it', () => {
  it.effect('a worktree whose folder was deleted, still listed by git, is not a live writer', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      // git still lists it, at a folder that is not there.
      w.remove()
      w.git.branches['/w/gone'] = 'other'
      const r = yield* w.inbox('orchestrator', { wait: true })
      assert.deepStrictEqual([r.code, r.err], [3, 'lntt inbox: no child reports to the orchestrator'])
      assert.deepStrictEqual(w.markers(), [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a start in progress, a marker with no worktree yet, is a writer, and is not cleared', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(
        `${DIR}/started/feat%2Fnew.json`,
        `${JSON.stringify({ branch: 'feat/new', issue: 8, to: 'orchestrator' })}\n`,
      )
      const waiting = yield* w.background(w.inbox('orchestrator', { wait: true }))
      yield* TestClock.adjust('100 millis')
      yield* unanswered(w, w.ask('Hello'))
      yield* TestClock.adjust('100 millis')
      assert.strictEqual((yield* Fiber.join(waiting)).code, 0)
      assert.deepStrictEqual(w.markers(), ['feat%2Fnew.json'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'listing without --wait does not look at the worktrees; a message already there is returned with no writer',
    () => {
      const w = world()
      return Effect.gen(function* () {
        yield* w.marker('feat/gone')
        const listed = yield* w.inbox('orchestrator')
        assert.deepStrictEqual([listed.code, w.git.listed, w.markers()], [0, 0, ['feat%2Fgone.json']])
        yield* unanswered(w, w.ask('Ready?'))
        const r = yield* w.inbox('orchestrator', { wait: true, intervalMs: 5000 })
        assert.strictEqual(r.code, 0, r.err)
        assert.strictEqual(lines(r.out)[0]?.question, 'Ready?')
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('--timeout shorter than the interval ends on time, exit 1 with a live writer, not 3', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const waiting = yield* w.background(w.inbox('orchestrator', { wait: true, intervalMs: 20_000, timeoutMs: 300 }))
      yield* TestClock.adjust('300 millis')
      const r = yield* Fiber.join(waiting)
      assert.deepStrictEqual(
        [r.code, r.err.split('\n').at(-1)],
        [1, 'lntt inbox: no message to the orchestrator in 0.3 s'],
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--wait with a live writer and no --timeout waits, then ends when its worktree goes', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const waiting = yield* w.background(w.inbox('orchestrator', { wait: true }))
      yield* TestClock.adjust('10 seconds')
      assert.strictEqual(waiting.pollUnsafe(), undefined, 'still waiting')
      w.remove()
      yield* TestClock.adjust('100 millis')
      const r = yield* Fiber.join(waiting)
      assert.strictEqual(r.code, 3)
      assert.match(r.err, /no child reports to the orchestrator/)
      assert.deepStrictEqual(w.markers(), [])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--wait returns the first message, also one left by the last writer in the same poll', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const waiting = yield* w.background(w.inbox('orchestrator', { wait: true, intervalMs: 2000 }))
      yield* TestClock.adjust('100 millis')
      yield* unanswered(w, w.ask('Last words'))
      w.remove()
      yield* TestClock.adjust('2 seconds')
      const r = yield* Fiber.join(waiting)
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(lines(r.out)[0]?.question, 'Last words')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a child has no writers to follow: --wait ends on its --timeout alone', () => {
    const w = world()
    return Effect.gen(function* () {
      const r = yield* unanswered(w, w.inbox('child', { address: { issue: 7 }, wait: true, timeoutMs: 200 }))
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /no message to the child in 0.2 s/)
      assert.strictEqual(w.git.listed, 0)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('only the markers that report to the mailbox are its writers; with no theme any coordinator writes', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other', 'coordinator', { theme: 'alpha' })
      assert.strictEqual((yield* w.inbox('orchestrator', { wait: true })).code, 3)
      assert.strictEqual((yield* w.inbox('coordinator', { address: { theme: 'beta' }, wait: true })).code, 3)
      assert.strictEqual(w.markers().length, 1, 'a live marker of another mailbox is not cleared')
      for (const address of [{ theme: 'alpha' }, {}]) {
        const r = yield* unanswered(w, w.inbox('coordinator', { address, wait: true, timeoutMs: 200 }))
        assert.strictEqual(r.code, 1, JSON.stringify(address))
      }
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a worktree still on the name Orca gave its branch is alive under its conventional marker', () => {
    const w = world()
    return Effect.gen(function* () {
      w.git.branches['/w/other'] = 'ilmeskio/chore-7-the-slug'
      yield* w.marker('chore/7/the-slug')
      const r = yield* unanswered(w, w.inbox('orchestrator', { wait: true, timeoutMs: 200 }))
      assert.strictEqual(r.code, 1, r.err)
      assert.deepStrictEqual(w.markers(), ['chore%2F7%2Fthe-slug.json'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--follow prints one line per message, answered or not by then, and exits 3 with the last writer', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const following = yield* w.background(w.inbox('orchestrator', { follow: true, intervalMs: 2000 }))
      yield* TestClock.adjust('100 millis')
      yield* unanswered(w, w.ask('one', { topic: 'one' }))
      const [first] = lines((yield* w.inbox('orchestrator')).out)
      yield* w.answer(first?.id as string, 'seen')
      yield* unanswered(w, w.ask('two', { topic: 'two' }))
      w.remove()
      yield* TestClock.adjust('2 seconds')
      const r = yield* Fiber.join(following)
      assert.strictEqual(r.code, 3)
      assert.deepStrictEqual(
        lines(r.out).map((line) => [line.topic, line.to]),
        [
          ['one', 'orchestrator'],
          ['two', 'orchestrator'],
        ],
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--follow prints the unanswered messages at start, not the answered ones, then ends with no writer', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* unanswered(w, w.ask('Answered', { topic: 'answered' }))
      yield* w.answer(lines((yield* w.inbox('orchestrator')).out)[0]?.id as string, 'done')
      yield* unanswered(w, w.ask('Early'))
      const r = yield* w.inbox('orchestrator', { follow: true })
      assert.strictEqual(r.code, 3)
      assert.deepStrictEqual(
        lines(r.out).map((line) => line.question),
        ['Early'],
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('--follow --timeout with a live writer ends with exit 1', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const r = yield* unanswered(w, w.inbox('orchestrator', { follow: true, timeoutMs: 200 }))
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /followed the orchestrator's mailbox for 0.2 s/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a configuration that does not validate is an error of the wait', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.marker('other')
      const r = yield* w
        .inbox('orchestrator', { wait: true })
        .pipe(
          Effect.provide(
            Layer.succeed(ProjectConfig)(
              ProjectConfig.of({ data: Effect.fail(new ConfigInvalid({ message: 'bad' })) }),
            ),
          ),
        )
      assert.deepStrictEqual([r.code, r.err], [1, 'lntt inbox: bad'])
    }).pipe(Effect.provide(w.layer))
  })
})
