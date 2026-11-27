import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { branchRules } from '../branch.ts'
import { Git, GitError } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import {
  answer,
  askAtLimit,
  checkedOutBranches,
  liveChildren,
  Mailbox,
  MailboxFailed,
  pending,
  recordStarted,
  reportsTo,
  send,
  sentMessage,
  startedBy,
  waitForAnswer,
} from './mailbox.ts'
import { messageDirectory, START_GRACE_MS } from './rules.ts'

const DIR = '/repo/.git/lntt-messages'
// Local time, as `date +%Y%m%d-%H%M%S` writes it in the files already in use.
const AT = new Date('2026-10-17T10:15:00').getTime()

// The mailbox on a file system in memory, the clock at AT: each test gets its own.
function world(options: { worktrees?: string } = {}) {
  const fs = memoryFileSystem({ dirs: ['/repo/.git', '/w/other'] })
  const layer = Layer.mergeAll(
    fs.layer,
    Mailbox.at(DIR),
    Git.memory({
      worktrees: (gitDir) =>
        options.worktrees === undefined
          ? Effect.fail(new GitError({ args: ['--git-dir', gitDir], output: 'not a git repository' }))
          : Effect.succeed(options.worktrees),
    }),
  )
  const names = (dir: string) =>
    [...fs.files.keys()]
      .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map((path) => path.slice(dir.length + 1))
      .sort()
  return { fs, layer, names }
}

describe('where a message lives', () => {
  it('to-<role>, to-child-<issue> for one child, to-coordinator-<theme> for one coordinator', () => {
    assert.strictEqual(messageDirectory(DIR, 'coordinator'), `${DIR}/to-coordinator`)
    assert.strictEqual(messageDirectory(DIR, 'orchestrator'), `${DIR}/to-orchestrator`)
    assert.strictEqual(messageDirectory(DIR, 'child'), `${DIR}/to-child`)
    assert.strictEqual(messageDirectory(DIR, 'child', { issue: 84 }), `${DIR}/to-child-84`)
    assert.strictEqual(
      messageDirectory(DIR, 'coordinator', { theme: 'release-0-6-1' }),
      `${DIR}/to-coordinator-release-0-6-1`,
    )
  })

  it('a role that is not one of the three is refused', () => {
    assert.throws(() => messageDirectory(DIR, 'boss'), /orchestrator, coordinator or child/)
  })

  it('an issue narrows only a child, a theme only a coordinator, and a theme is a slug', () => {
    assert.throws(() => messageDirectory(DIR, 'coordinator', { issue: 84 }), /only a child/)
    assert.throws(() => messageDirectory(DIR, 'child', { theme: 'x' }), /only a coordinator/)
    assert.throws(() => messageDirectory(DIR, 'coordinator', { theme: '../x' }), /not a slug/)
  })
})

const refused = <A, E extends { message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

describe('sending', () => {
  it.effect('writes <YYYYMMDD-HHMMSS>-<topic>.md in the role directory, the question as the body', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const sent = yield* send(DIR, 'coordinator', 'May I start #89 now?\nIt is independent.', { topic: 'start-89' })
      assert.strictEqual(sent.id, '20261017-101500-start-89')
      assert.strictEqual(sent.path, `${DIR}/to-coordinator/20261017-101500-start-89.md`)
      assert.strictEqual(w.fs.text(sent.path), 'May I start #89 now?\nIt is independent.\n')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('the topic comes from the first words of the question when none is given', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const sent = yield* send(DIR, 'orchestrator', 'Is the ADR level a decision for the person?')
      assert.strictEqual(sent.id, '20261017-101500-adr-level-decision-person')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'two messages in the same second on one topic do not overwrite each other, and no temporary file is left',
    () => {
      const w = world()
      return Effect.gen(function* () {
        yield* TestClock.setTime(AT)
        const first = yield* send(DIR, 'coordinator', 'one', { topic: 't' })
        const second = yield* send(DIR, 'coordinator', 'two', { topic: 't' })
        assert.deepStrictEqual([first.id, second.id], ['20261017-101500-t', '20261017-101500-t-2'])
        assert.strictEqual(w.fs.text(first.path), 'one\n')
        assert.strictEqual(w.fs.text(second.path), 'two\n')
        assert.deepStrictEqual(w.names(`${DIR}/to-coordinator`), ['20261017-101500-t-2.md', '20261017-101500-t.md'])
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a question with nothing to slug still gets a topic', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      assert.strictEqual((yield* send(DIR, 'coordinator', '？？？')).id, '20261017-101500-message')
      assert.strictEqual((yield* send(DIR, 'coordinator', '??? !!!')).id, '20261017-101500-message-2')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an empty question, a topic that is not a slug and a role that is none are refused', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.match(yield* refused(send(DIR, 'coordinator', '  \n')), /empty/)
      assert.match(yield* refused(send(DIR, 'coordinator', 'q', { topic: '../x' })), /topic/)
      assert.match(yield* refused(send(DIR, 'boss', 'q')), /orchestrator, coordinator or child, not boss/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('to the orchestrator or a coordinator, the issue tags the topic and the role directory stays', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const up = yield* send(DIR, 'orchestrator', 'May I push?', { topic: 'push', issue: 84 })
      assert.deepStrictEqual(
        [up.id, up.topic, up.path],
        ['20261017-101500-issue-84-push', 'issue-84-push', `${DIR}/to-orchestrator/20261017-101500-issue-84-push.md`],
      )
      const side = yield* send(DIR, 'coordinator', 'q', { topic: 'order', issue: 84, theme: 'alpha' })
      assert.strictEqual(side.path, `${DIR}/to-coordinator-alpha/20261017-101500-issue-84-order.md`)
      // Not tagged twice.
      assert.strictEqual(
        (yield* send(DIR, 'orchestrator', 'q', { topic: 'issue-84-push', issue: 84 })).topic,
        'issue-84-push',
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('the topic drawn from the question is cut to 40 characters before the issue tags it', () => {
    const w = world()
    return Effect.gen(function* () {
      const question = 'Which of the two pull requests of the theme merges first, the CLI or the docs?'
      const plain = yield* send(DIR, 'orchestrator', question)
      const tagged = yield* send(DIR, 'orchestrator', question, { issue: 84 })
      assert.strictEqual(tagged.topic, `issue-84-${plain.topic}`)
      assert.ok(plain.topic.length <= 40)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('to a child, the issue names its directory and leaves the topic as it is', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const sent = yield* send(DIR, 'child', 'q', { topic: 'hint', issue: 84 })
      assert.strictEqual(sent.topic, 'hint')
      assert.strictEqual(sent.path, `${DIR}/to-child-84/20261017-101500-hint.md`)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('answering', () => {
  it.effect('writes <id>.answer.md next to the message, wherever the message is, its id with or without .md', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const child = yield* send(DIR, 'child', 'q', { topic: 't', issue: 84 })
      const written = yield* answer(DIR, child.id, 'yes')
      assert.strictEqual(written, `${DIR}/to-child-84/20261017-101500-t.answer.md`)
      assert.strictEqual(w.fs.text(written), 'yes\n')
      const up = yield* send(DIR, 'orchestrator', 'q', { topic: 't', issue: 84 })
      assert.strictEqual(yield* answer(DIR, up.id, 'yes'), `${DIR}/to-orchestrator/${up.id}.answer.md`)
      const side = yield* send(DIR, 'coordinator', 'q', { topic: 'u' })
      assert.strictEqual(yield* answer(DIR, `${side.id}.md`, 'ok'), `${DIR}/to-coordinator/${side.id}.answer.md`)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an id that names no message, or an answer, is refused; answering twice keeps the first answer', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.match(yield* refused(answer(DIR, '20261017-000000-none', 'x')), /no message/)
      const sent = yield* send(DIR, 'coordinator', 'q', { topic: 't' })
      assert.match(yield* refused(answer(DIR, `${sent.id}.answer`, 'x')), /no message/)
      yield* answer(DIR, sent.id, 'first')
      assert.match(yield* refused(answer(DIR, sent.id, 'second')), /already answered/)
      assert.deepStrictEqual(w.names(`${DIR}/to-coordinator`), [`${sent.id}.answer.md`, `${sent.id}.md`])
      assert.strictEqual(w.fs.text(`${DIR}/to-coordinator/${sent.id}.answer.md`), 'first\n')
      assert.match(yield* refused(answer(DIR, sent.id, ' ')), /empty/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an id in two directories is ambiguous', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(`${DIR}/to-coordinator/20261017-101500-t.md`, 'q\n')
      yield* w.fs.put(`${DIR}/to-orchestrator/20261017-101500-t.md`, 'q\n')
      assert.match(yield* refused(answer(DIR, '20261017-101500-t', 'x')), /more than one/)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an id that is not a message name, or that climbs out of the mailbox, is refused', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(`${DIR}/to-coordinator/20261017-101500-a.md`, 'q\n')
      yield* w.fs.put(`${DIR}/outside.md`, 'q\n')
      yield* w.fs.put(`${DIR}/x/20261017-101500-t.md`, 'q\n')
      for (const id of ['../outside', '../x/20261017-101500-t', '../x/20261017-101500-t.md']) {
        assert.match(yield* refused(answer(DIR, id, 'x')), /no message/)
      }
      assert.strictEqual(w.fs.text(`${DIR}/outside.answer.md`), undefined)
      assert.strictEqual(w.fs.text(`${DIR}/x/20261017-101500-t.answer.md`), undefined)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('a message already sent', () => {
  it.effect('is found by its id with its role, in a child’s directory too', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const sent = yield* send(DIR, 'child', 'Try X', { topic: 'hint', issue: 84 })
      assert.deepStrictEqual(yield* sentMessage(DIR, sent.id), { ...sent, to: 'child' })
      assert.match(yield* refused(sentMessage(DIR, '20261017-000000-none')), /no message 20261017-000000-none/)
    }).pipe(Effect.provide(w.layer))
  })
})

describe('waiting for the answer', () => {
  it.effect('polls every 20 seconds until the answer file appears, and returns its text', () => {
    const w = world()
    return Effect.gen(function* () {
      const sent = yield* send(DIR, 'coordinator', 'q', { topic: 't' })
      const waiting = yield* Effect.forkChild(waitForAnswer(sent))
      yield* TestClock.adjust('40 seconds')
      assert.strictEqual(waiting.pollUnsafe(), undefined, 'still waiting')
      yield* answer(DIR, sent.id, 'go ahead')
      yield* TestClock.adjust('20 seconds')
      assert.strictEqual(yield* Fiber.join(waiting), 'go ahead\n')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('an answer already there is returned without waiting', () => {
    const w = world()
    return Effect.gen(function* () {
      const sent = yield* send(DIR, 'coordinator', 'q', { topic: 't' })
      yield* answer(DIR, sent.id, 'done')
      assert.strictEqual(yield* waitForAnswer(sent), 'done\n')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('the interval is a setting, and a timeout ends the wait with the message left in place', () => {
    const w = world()
    return Effect.gen(function* () {
      const sent = yield* send(DIR, 'coordinator', 'q', { topic: 't' })
      const waiting = yield* Effect.forkChild(Effect.flip(waitForAnswer(sent, { intervalMs: 1000, timeoutMs: 3000 })))
      yield* TestClock.adjust('2 seconds')
      assert.strictEqual(waiting.pollUnsafe(), undefined, 'still waiting at 2 s')
      yield* TestClock.adjust('1 second')
      assert.match((yield* Fiber.join(waiting)).message, /no answer to .* in 3 s; the message is still at /)
      assert.ok(w.fs.text(sent.path))
    }).pipe(Effect.provide(w.layer))
  })
})

describe('the inbox', () => {
  it.effect('lists the unanswered messages of a role, oldest first', () => {
    const w = world()
    return Effect.gen(function* () {
      const a = yield* send(DIR, 'coordinator', 'first', { topic: 'a' })
      yield* TestClock.adjust('5 seconds')
      const b = yield* send(DIR, 'coordinator', 'second', { topic: 'b' })
      yield* TestClock.adjust('5 seconds')
      const c = yield* send(DIR, 'coordinator', 'third', { topic: 'c' })
      yield* send(DIR, 'orchestrator', 'not mine', { topic: 'x' })
      yield* answer(DIR, b.id, 'done')
      assert.deepStrictEqual(
        (yield* pending(DIR, 'coordinator')).map((m) => [m.id, m.question]),
        [
          [a.id, 'first'],
          [c.id, 'third'],
        ],
      )
      assert.deepStrictEqual(yield* pending(DIR, 'child'), [], 'empty when the directory does not exist yet')
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('reads messages written by hand: any text, no trailing newline; notes are not messages', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.fs.put(`${DIR}/to-coordinator/20261015-090000-hand-written.md`, 'Question\nover two lines')
      yield* w.fs.put(`${DIR}/to-coordinator/notes.md`, 'not a message')
      const listed = yield* pending(DIR, 'coordinator')
      assert.deepStrictEqual(
        listed.map((m) => [m.question, m.topic]),
        [['Question\nover two lines', 'hand-written']],
      )
    }).pipe(Effect.provide(w.layer))
  })

  it.effect(
    'a message tagged with an issue is in the orchestrator’s and the coordinator’s inbox; a child’s is its own',
    () => {
      const w = world()
      return Effect.gen(function* () {
        yield* send(DIR, 'orchestrator', 'up', { topic: 'limit', issue: 84 })
        yield* send(DIR, 'coordinator', 'side', { topic: 'limit', issue: 84, theme: 'alpha' })
        yield* send(DIR, 'child', 'for 84', { topic: 'a', issue: 84 })
        yield* send(DIR, 'child', 'for 89', { topic: 'b', issue: 89 })
        assert.deepStrictEqual(
          (yield* pending(DIR, 'orchestrator')).map((m) => [m.topic, m.question]),
          [['issue-84-limit', 'up']],
        )
        assert.deepStrictEqual(
          (yield* pending(DIR, 'coordinator', { theme: 'alpha' })).map((m) => m.topic),
          ['issue-84-limit'],
        )
        assert.deepStrictEqual(
          (yield* pending(DIR, 'child', { issue: 84 })).map((m) => m.question),
          ['for 84'],
        )
      }).pipe(Effect.provide(w.layer))
    },
  )
})

describe('the start marker', () => {
  it.effect('records who a branch reports to, reads it back, and a later start replaces it', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* recordStarted(DIR, { branch: 'feat/84/x', issue: 84, to: 'orchestrator' })
      yield* recordStarted(DIR, { branch: 'feat/84/x', issue: 84, to: 'coordinator', theme: 'alpha' })
      assert.deepStrictEqual(yield* startedBy(DIR, 'feat/84/x'), {
        branch: 'feat/84/x',
        issue: 84,
        to: 'coordinator',
        theme: 'alpha',
      })
      assert.deepStrictEqual(w.names(`${DIR}/started`), ['feat%2F84%2Fx.json'])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a branch with no marker, or one that cannot be read, has none', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual(yield* startedBy(DIR, 'feat/84/x'), null)
      yield* w.fs.put(`${DIR}/started/feat%2F84%2Fx.json`, '{ cut')
      assert.strictEqual(yield* startedBy(DIR, 'feat/84/x'), null)
      yield* w.fs.put(`${DIR}/started/feat%2F84%2Fx.json`, JSON.stringify({ branch: 'feat/84/x', to: 'boss' }))
      assert.strictEqual(yield* startedBy(DIR, 'feat/84/x'), null)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a marker is the branch’s own: two branches that flatten alike keep one each', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* recordStarted(DIR, { branch: 'feat/84-x', issue: 84, to: 'orchestrator' })
      assert.strictEqual(yield* startedBy(DIR, 'feat-84/x'), null)
      yield* recordStarted(DIR, { branch: 'feat-84/x', issue: 84, to: 'coordinator', theme: 'alpha' })
      assert.strictEqual((yield* startedBy(DIR, 'feat/84-x'))?.to, 'orchestrator')
      assert.strictEqual((yield* startedBy(DIR, 'feat-84/x'))?.to, 'coordinator')
      assert.strictEqual(w.names(`${DIR}/started`).length, 2)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a marker that does not say who, exactly, is none', () => {
    const w = world()
    return Effect.gen(function* () {
      const write = (marker: Record<string, unknown>) =>
        Effect.andThen(
          w.fs.put(`${DIR}/started/feat%2F84%2Fx.json`, JSON.stringify({ branch: 'feat/84/x', ...marker })),
          startedBy(DIR, 'feat/84/x'),
        )
      assert.ok(yield* write({ issue: 84, to: 'coordinator', theme: 'alpha' }), 'the well-formed one is read')
      assert.strictEqual(yield* write({ issue: 84, to: 'coordinator' }), null, 'a coordinator with no theme')
      assert.strictEqual(yield* write({ issue: 84, to: 'coordinator', theme: '../x' }), null, 'a theme not a slug')
      assert.strictEqual(yield* write({ issue: '84', to: 'orchestrator' }), null, 'an issue as a string')
      assert.strictEqual(yield* write({ issue: 1.5, to: 'orchestrator' }), null, 'an issue that is not whole')
      assert.strictEqual(yield* write({ to: 'orchestrator' }), null, 'no issue at all')
    }).pipe(Effect.provide(w.layer))
  })
})

describe('liveChildren', () => {
  const none = Effect.succeed(new Set<string>())

  it.effect(
    'a marker younger than a minute is a start in progress: live and never cleared; at exactly the grace it goes',
    () => {
      const w = world()
      return Effect.gen(function* () {
        yield* TestClock.setTime(AT)
        yield* recordStarted(DIR, { branch: 'feat/1/a', issue: 1, to: 'orchestrator' })
        const live = Effect.map(liveChildren(DIR, { to: 'orchestrator' }, none), (list) => list.map((m) => m.branch))
        assert.deepStrictEqual(yield* live, ['feat/1/a'])
        yield* TestClock.adjust(START_GRACE_MS - 1)
        assert.deepStrictEqual(yield* live, ['feat/1/a'])
        assert.notStrictEqual(yield* startedBy(DIR, 'feat/1/a'), null)
        yield* TestClock.adjust(1)
        assert.deepStrictEqual(yield* live, [])
        assert.strictEqual(yield* startedBy(DIR, 'feat/1/a'), null)
      }).pipe(Effect.provide(w.layer))
    },
  )

  it.effect('a file of started/ whose name is not a branch is skipped and left; no started/ has none', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* liveChildren(DIR, { to: 'orchestrator' }, none), [])
      yield* w.fs.put(`${DIR}/started/%E0%A4%A.json`, '{}\n')
      yield* w.fs.put(`${DIR}/started/notes.txt`, 'x')
      assert.deepStrictEqual(yield* liveChildren(DIR, { to: 'orchestrator' }, none), [])
      assert.ok(w.fs.text(`${DIR}/started/%E0%A4%A.json`))
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('lists the markers that report to the target and are checked out, and clears the others', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* recordStarted(DIR, { branch: 'feat/2/b', issue: 2, to: 'orchestrator' })
      yield* TestClock.adjust('2 minutes')
      yield* recordStarted(DIR, { branch: 'feat/1/a', issue: 1, to: 'orchestrator' })
      yield* recordStarted(DIR, { branch: 'feat/3/c', issue: 3, to: 'coordinator', theme: 'alpha' })
      yield* recordStarted(DIR, { branch: 'chore/alpha', issue: null, to: 'orchestrator', theme: 'alpha' })
      yield* TestClock.adjust('2 minutes')
      const here = Effect.succeed(new Set(['feat/1/a', 'feat/3/c', 'chore/alpha']))
      const live = (target: { to: 'orchestrator' | 'coordinator'; theme?: string }) =>
        Effect.map(liveChildren(DIR, target, here), (list) => list.map((m) => m.branch).sort())
      assert.deepStrictEqual(yield* live({ to: 'orchestrator' }), ['chore/alpha', 'feat/1/a'])
      assert.strictEqual(yield* startedBy(DIR, 'feat/2/b'), null)
      assert.deepStrictEqual(yield* live({ to: 'coordinator', theme: 'alpha' }), ['feat/3/c'])
      assert.deepStrictEqual(yield* live({ to: 'coordinator', theme: 'beta' }), [])
      assert.deepStrictEqual(yield* live({ to: 'coordinator' }), ['feat/3/c'])
    }).pipe(Effect.provide(w.layer))
  })
})

describe('the worktrees git lists', () => {
  const LISTING = [
    'worktree /repo\nHEAD 1\nbranch refs/heads/main',
    'worktree /w/other\nHEAD 2\nbranch refs/heads/olivia/feat-7-x',
    'worktree /w/gone\nHEAD 3\nbranch refs/heads/feat/9/gone',
    'worktree /w/detached\nHEAD 4\ndetached',
  ].join('\n\n')

  it.effect('are the branches of a worktree that exists, each also under the name it answers to', () => {
    const w = world({ worktrees: LISTING })
    return Effect.gen(function* () {
      yield* w.fs.put('/repo/README.md', 'x')
      const alias = (branch: string) => (branch === 'olivia/feat-7-x' ? 'feat/7/x' : null)
      assert.deepStrictEqual([...(yield* checkedOutBranches('/repo/.git', alias))].sort(), [
        'feat/7/x',
        'main',
        'olivia/feat-7-x',
      ])
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a mailbox outside a git directory cannot tell who is alive', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.match(
        yield* refused(checkedOutBranches('/tmp')),
        /cannot list the worktrees of \/tmp: the mailbox must be in a git common directory/,
      )
    }).pipe(Effect.provide(w.layer))
  })
})

describe('the parent of a branch, at the review limit', () => {
  const RULES = branchRules({})

  it.effect('a branch still on the name Orca gave it has the marker of its conventional name', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* recordStarted(DIR, { branch: 'feat/7/x', issue: 7, to: 'orchestrator' })
      const marker = { branch: 'feat/7/x', issue: 7, to: 'orchestrator' as const }
      assert.deepStrictEqual(yield* reportsTo('feat/7/x', RULES), marker)
      assert.deepStrictEqual(yield* reportsTo('olivia/feat-7-x', RULES), marker)
      assert.strictEqual(yield* reportsTo('feat/8/y', RULES), null)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a mailbox that cannot be found has no parent', () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* reportsTo('feat/7/x', RULES), null)
    }).pipe(
      Effect.provide(Layer.mergeAll(memoryFileSystem().layer, Mailbox.at(new MailboxFailed({ message: 'no git' })))),
    ),
  )

  it.effect('the limit goes to a coordinator by theme, once until it is answered; a write that fails is said', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* TestClock.setTime(AT)
      const marker = { branch: 'feat/7/x', issue: 7, to: 'coordinator' as const, theme: 'alpha' }
      const first = yield* askAtLimit(marker, 'feat/7/x', '#7 feat/7/x: lntt review limit\n\n- f1')
      assert.deepStrictEqual(first.asked, {
        id: '20261017-101500-issue-7-review-limit',
        to: 'coordinator',
        path: `${DIR}/to-coordinator-alpha/20261017-101500-issue-7-review-limit.md`,
      })
      assert.strictEqual(
        first.line,
        'limit: sent 20261017-101500-issue-7-review-limit to the coordinator alpha; wait with: pnpm exec lntt ask --wait 20261017-101500-issue-7-review-limit',
      )
      const again = yield* askAtLimit(marker, 'feat/7/x', '#7 feat/7/x: lntt review limit')
      assert.match(again.line, /^limit: already sent 20261017-101500-issue-7-review-limit /)
      // Another branch's limit is its own.
      const other = yield* askAtLimit({ ...marker, branch: 'feat/8/y', issue: 8 }, 'feat/8/y', '#8 feat/8/y: limit')
      assert.match(other.line, /^limit: sent 20261017-101500-issue-8-review-limit /)
    }).pipe(Effect.provide(w.layer))
  })

  it.effect('a limit that cannot be written is a line, not a failure', () =>
    Effect.gen(function* () {
      const marker = { branch: 'feat/7/x', issue: null, to: 'orchestrator' as const }
      assert.deepStrictEqual(yield* askAtLimit(marker, 'feat/7/x', 'feat/7/x: limit'), {
        asked: null,
        line: 'limit: could not send to the orchestrator: outside a git repository',
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          memoryFileSystem().layer,
          Mailbox.at(new MailboxFailed({ message: 'outside a git repository' })),
        ),
      ),
    ),
  )
})
