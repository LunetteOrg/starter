import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  answer,
  type Mailbox,
  messageDirectory,
  pending,
  recordStarted,
  send,
  startedBy,
  waitForAnswer,
} from '../src/messages.ts'

let dir: string

// Local time, as `date +%Y%m%d-%H%M%S` writes it in the files already in use.
// A clock that only moves when the code sleeps: the 20-second poll costs no time.
function box(start = '2026-10-17T10:15:00'): Mailbox & { slept: number[] } {
  let now = new Date(start).getTime()
  const slept: number[] = []
  return {
    dir,
    slept,
    now: () => new Date(now),
    sleep: (ms) => {
      slept.push(ms)
      now += ms
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lntt-messages-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('where a message lives', () => {
  test('to-<role>, to-child-<issue> for one child, to-coordinator-<theme> for one coordinator', () => {
    assert.equal(messageDirectory(dir, 'coordinator'), join(dir, 'to-coordinator'))
    assert.equal(messageDirectory(dir, 'orchestrator'), join(dir, 'to-orchestrator'))
    assert.equal(messageDirectory(dir, 'child'), join(dir, 'to-child'))
    assert.equal(messageDirectory(dir, 'child', { issue: 84 }), join(dir, 'to-child-84'))
    assert.equal(
      messageDirectory(dir, 'coordinator', { theme: 'release-0-6-1' }),
      join(dir, 'to-coordinator-release-0-6-1'),
    )
  })

  test('a role that is not one of the three is refused', () => {
    assert.throws(() => messageDirectory(dir, 'boss'), /orchestrator, coordinator or child/)
  })

  test('an issue narrows only a child, a theme only a coordinator, and a theme is a slug', () => {
    assert.throws(() => messageDirectory(dir, 'coordinator', { issue: 84 }), /only a child/)
    assert.throws(() => messageDirectory(dir, 'child', { theme: 'x' }), /only a coordinator/)
    assert.throws(() => messageDirectory(dir, 'coordinator', { theme: '../x' }), /not a slug/)
  })
})

describe('sending', () => {
  test('writes <YYYYMMDD-HHMMSS>-<topic>.md in the role directory, the question as the body', () => {
    const sent = send(box(), 'coordinator', 'May I start #89 now?\nIt is independent.', { topic: 'start-89' })
    assert.equal(sent.id, '20261017-101500-start-89')
    assert.equal(sent.path, join(dir, 'to-coordinator', '20261017-101500-start-89.md'))
    assert.equal(readFileSync(sent.path, 'utf8'), 'May I start #89 now?\nIt is independent.\n')
  })

  test('the topic comes from the first words of the question when none is given', () => {
    const sent = send(box(), 'orchestrator', 'Is the ADR level a decision for the person?')
    assert.equal(sent.id, '20261017-101500-adr-level-decision-person')
  })

  test('two messages in the same second on one topic do not overwrite each other', () => {
    const clock = box()
    const first = send(clock, 'coordinator', 'one', { topic: 't' })
    const second = send(clock, 'coordinator', 'two', { topic: 't' })
    assert.notEqual(first.id, second.id)
    assert.equal(readFileSync(first.path, 'utf8'), 'one\n')
    assert.equal(readFileSync(second.path, 'utf8'), 'two\n')
  })

  test('leaves no temporary file behind', () => {
    send(box(), 'coordinator', 'q', { topic: 't' })
    assert.deepEqual(readdirSync(join(dir, 'to-coordinator')), ['20261017-101500-t.md'])
  })

  test('a question with nothing to slug still gets a topic', () => {
    assert.equal(send(box(), 'coordinator', '？？？').id, '20261017-101500-message')
    assert.equal(send(box(), 'coordinator', '??? !!!').id, '20261017-101500-message-2')
  })

  test('an empty question is refused', () => {
    assert.throws(() => send(box(), 'coordinator', '  \n'), /empty/)
  })

  test('a topic that is not a slug is refused', () => {
    assert.throws(() => send(box(), 'coordinator', 'q', { topic: '../x' }), /topic/)
  })

  test('to the orchestrator or a coordinator, the issue tags the topic and the role directory stays', () => {
    const clock = box()
    const up = send(clock, 'orchestrator', 'May I push?', { topic: 'push', issue: 84 })
    assert.equal(up.id, '20261017-101500-issue-84-push')
    assert.equal(up.topic, 'issue-84-push')
    assert.equal(up.path, join(dir, 'to-orchestrator', '20261017-101500-issue-84-push.md'))
    const side = send(clock, 'coordinator', 'q', { topic: 'order', issue: 84, theme: 'alpha' })
    assert.equal(side.path, join(dir, 'to-coordinator-alpha', '20261017-101500-issue-84-order.md'))
  })

  test('a topic already tagged with its issue is not tagged twice', () => {
    const sent = send(box(), 'orchestrator', 'q', { topic: 'issue-84-push', issue: 84 })
    assert.equal(sent.topic, 'issue-84-push')
  })

  test('the topic drawn from the question is cut to 40 characters before the issue tags it', () => {
    const question = 'Which of the two pull requests of the theme merges first, the CLI or the docs?'
    const plain = send(box(), 'orchestrator', question)
    const tagged = send(box(), 'orchestrator', question, { issue: 84 })
    assert.equal(tagged.topic, `issue-84-${plain.topic}`)
    assert.ok(plain.topic.length <= 40)
  })

  test('to a child, the issue names its directory and leaves the topic as it is', () => {
    const sent = send(box(), 'child', 'q', { topic: 'hint', issue: 84 })
    assert.equal(sent.topic, 'hint')
    assert.equal(sent.path, join(dir, 'to-child-84', '20261017-101500-hint.md'))
  })
})

describe('answering', () => {
  test('writes <id>.answer.md next to the message, wherever the message is', () => {
    const sent = send(box(), 'child', 'q', { topic: 't', issue: 84 })
    const written = answer(dir, sent.id, 'yes')
    assert.equal(written, join(dir, 'to-child-84', '20261017-101500-t.answer.md'))
    assert.equal(readFileSync(written, 'utf8'), 'yes\n')
  })

  test('finds a message to the orchestrator tagged with an issue', () => {
    const sent = send(box(), 'orchestrator', 'q', { topic: 't', issue: 84 })
    assert.equal(answer(dir, sent.id, 'yes'), join(dir, 'to-orchestrator', '20261017-101500-issue-84-t.answer.md'))
  })

  test('takes the id with the .md the file name has', () => {
    const sent = send(box(), 'coordinator', 'q', { topic: 't' })
    assert.equal(answer(dir, `${sent.id}.md`, 'ok'), join(dir, 'to-coordinator', `${sent.id}.answer.md`))
  })

  test('an id that names no message, or an answer, is refused', () => {
    assert.throws(() => answer(dir, '20261017-000000-none', 'x'), /no message/)
    const sent = send(box(), 'coordinator', 'q', { topic: 't' })
    assert.throws(() => answer(dir, `${sent.id}.answer`, 'x'), /no message/)
  })

  test('answering twice is refused; the first answer stays', () => {
    const sent = send(box(), 'coordinator', 'q', { topic: 't' })
    answer(dir, sent.id, 'first')
    assert.throws(() => answer(dir, sent.id, 'second'), /already answered/)
    assert.deepEqual(readdirSync(join(dir, 'to-coordinator')).sort(), [`${sent.id}.answer.md`, `${sent.id}.md`])
    assert.equal(readFileSync(join(dir, 'to-coordinator', `${sent.id}.answer.md`), 'utf8'), 'first\n')
  })

  test('an id in two directories is ambiguous', () => {
    const id = '20261017-101500-t'
    for (const to of ['to-coordinator', 'to-orchestrator']) {
      mkdirSync(join(dir, to), { recursive: true })
      writeFileSync(join(dir, to, `${id}.md`), 'q\n')
    }
    assert.throws(() => answer(dir, id, 'x'), /more than one/)
  })

  test('an id that is not a message name, or that climbs out of the mailbox, is refused', () => {
    // A real file outside to-*/ that the id would reach.
    mkdirSync(join(dir, 'to-coordinator'))
    writeFileSync(join(dir, 'outside.md'), 'q\n')
    mkdirSync(join(dir, 'x'))
    writeFileSync(join(dir, 'x', '20261017-101500-t.md'), 'q\n')
    assert.throws(() => answer(dir, '../outside', 'x'), /no message/)
    assert.throws(() => answer(dir, '../x/20261017-101500-t', 'x'), /no message/)
    assert.throws(() => answer(dir, '../x/20261017-101500-t.md', 'x'), /no message/)
    assert.ok(!existsSync(join(dir, 'outside.answer.md')))
    assert.ok(!existsSync(join(dir, 'x', '20261017-101500-t.answer.md')))
  })

  test('an empty answer is refused', () => {
    const sent = send(box(), 'coordinator', 'q', { topic: 't' })
    assert.throws(() => answer(dir, sent.id, ' '), /empty/)
  })
})

describe('waiting for the answer', () => {
  test('polls every 20 seconds until the answer file appears, and returns its text', () => {
    const clock = box()
    const sent = send(clock, 'coordinator', 'q', { topic: 't' })
    let polls = 0
    const waiting: Mailbox = {
      ...clock,
      sleep: (ms) => {
        clock.sleep(ms)
        polls += 1
        if (polls === 3) answer(dir, sent.id, 'go ahead')
      },
    }
    assert.equal(waitForAnswer(waiting, sent), 'go ahead\n')
    assert.deepEqual(clock.slept, [20000, 20000, 20000])
  })

  test('an answer already there is returned without waiting', () => {
    const clock = box()
    const sent = send(clock, 'coordinator', 'q', { topic: 't' })
    answer(dir, sent.id, 'done')
    assert.equal(waitForAnswer(clock, sent), 'done\n')
    assert.deepEqual(clock.slept, [])
  })

  test('the interval is a setting, and a timeout ends the wait with the message left in place', () => {
    const clock = box()
    const sent = send(clock, 'coordinator', 'q', { topic: 't' })
    assert.throws(() => waitForAnswer(clock, sent, { intervalMs: 1000, timeoutMs: 3000 }), /no answer to .* in 3 s/)
    assert.deepEqual(clock.slept, [1000, 1000, 1000])
    assert.ok(existsSync(sent.path))
  })
})

describe('the inbox', () => {
  test('lists the unanswered messages of a role, oldest first', () => {
    const clock = box()
    const a = send(clock, 'coordinator', 'first', { topic: 'a' })
    clock.sleep(5000)
    const b = send(clock, 'coordinator', 'second', { topic: 'b' })
    clock.sleep(5000)
    const c = send(clock, 'coordinator', 'third', { topic: 'c' })
    send(clock, 'orchestrator', 'not mine', { topic: 'x' })
    answer(dir, b.id, 'done')
    assert.deepEqual(
      pending(dir, 'coordinator').map((m) => [m.id, m.question]),
      [
        [a.id, 'first'],
        [c.id, 'third'],
      ],
    )
  })

  test('is empty when the directory does not exist yet', () => {
    assert.deepEqual(pending(dir, 'orchestrator'), [])
  })

  test('reads messages written by hand: any text, no trailing newline', () => {
    mkdirSync(join(dir, 'to-coordinator'))
    writeFileSync(join(dir, 'to-coordinator', '20261015-090000-hand-written.md'), 'Question\nover two lines')
    writeFileSync(join(dir, 'to-coordinator', 'notes.md'), 'not a message')
    const [only, ...rest] = pending(dir, 'coordinator')
    assert.equal(rest.length, 0)
    assert.equal(only?.question, 'Question\nover two lines')
    assert.equal(only?.topic, 'hand-written')
  })

  test('lists a message tagged with an issue in the orchestrator’s and the coordinator’s inbox', () => {
    const clock = box()
    send(clock, 'orchestrator', 'up', { topic: 'limit', issue: 84 })
    send(clock, 'coordinator', 'side', { topic: 'limit', issue: 84, theme: 'alpha' })
    assert.deepEqual(
      pending(dir, 'orchestrator').map((m) => [m.topic, m.question]),
      [['issue-84-limit', 'up']],
    )
    assert.deepEqual(
      pending(dir, 'coordinator', { theme: 'alpha' }).map((m) => m.topic),
      ['issue-84-limit'],
    )
  })

  test('a child’s inbox is its own to-child-<issue>', () => {
    const clock = box()
    send(clock, 'child', 'for 84', { topic: 'a', issue: 84 })
    send(clock, 'child', 'for 89', { topic: 'b', issue: 89 })
    assert.deepEqual(
      pending(dir, 'child', { issue: 84 }).map((m) => m.question),
      ['for 84'],
    )
  })
})

describe('the start marker', () => {
  test('records who a branch reports to, and reads it back', () => {
    const root = join(dir, 'box')
    recordStarted(root, { branch: 'feat/84/x', issue: 84, to: 'coordinator', theme: 'alpha' })
    assert.deepEqual(startedBy(root, 'feat/84/x'), {
      branch: 'feat/84/x',
      issue: 84,
      to: 'coordinator',
      theme: 'alpha',
    })
    assert.deepEqual(readdirSync(join(root, 'started')), ['feat-84-x.json'])
  })

  test('a later start of the same branch replaces the marker', () => {
    recordStarted(dir, { branch: 'feat/84/x', issue: 84, to: 'orchestrator' })
    recordStarted(dir, { branch: 'feat/84/x', issue: 84, to: 'coordinator', theme: 'beta' })
    assert.equal(startedBy(dir, 'feat/84/x')?.theme, 'beta')
    assert.deepEqual(readdirSync(join(dir, 'started')), ['feat-84-x.json'])
  })

  test('a branch with no marker, or one that cannot be read, has none', () => {
    assert.equal(startedBy(dir, 'feat/84/x'), null)
    mkdirSync(join(dir, 'started'))
    writeFileSync(join(dir, 'started', 'feat-84-x.json'), '{ cut')
    assert.equal(startedBy(dir, 'feat/84/x'), null)
    writeFileSync(join(dir, 'started', 'feat-84-x.json'), JSON.stringify({ branch: 'feat/84/x', to: 'boss' }))
    assert.equal(startedBy(dir, 'feat/84/x'), null)
  })

  test('a marker is the branch’s own: another branch with the same flat name has none', () => {
    recordStarted(dir, { branch: 'feat/84-x', issue: 84, to: 'orchestrator' })
    assert.equal(startedBy(dir, 'feat-84/x'), null)
  })
})
