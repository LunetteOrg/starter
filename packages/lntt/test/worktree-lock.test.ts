import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { acquireLock, FRESH_MS, LockedError, lockPath, releaseLock } from '../src/worktree-lock.ts'

let gitDir: string
const sleepers: ChildProcess[] = []

// A live process that is not this one, for a lock to name.
function live(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid as number
}

// A lock as another run wrote it, last touched `agoMs` ago.
function held(content: string, agoMs = 0): void {
  writeFileSync(lockPath(gitDir), content)
  const at = new Date(Date.now() - agoMs)
  utimesSync(lockPath(gitDir), at, at)
}

const OLD = FRESH_MS * 4

beforeEach(() => {
  gitDir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-lock-')))
})

afterEach(() => {
  releaseLock(gitDir)
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
  rmSync(gitDir, { recursive: true, force: true })
})

describe('the lock of a worktree, shared by lntt review and lntt check tests mutate', () => {
  test('is taken with the pid and the command, and goes with releaseLock', () => {
    acquireLock(gitDir, 'lntt check tests mutate')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt check tests mutate`)
    releaseLock(gitDir)
    assert.equal(existsSync(lockPath(gitDir)), false)
  })

  test('is refused while a live process holds it, naming its command and pid', () => {
    const pid = live()
    for (const command of ['lntt review', 'lntt check tests mutate']) {
      held(`${pid} ${command}`)
      assert.throws(
        () => acquireLock(gitDir, 'lntt something'),
        (error: Error) =>
          error instanceof LockedError &&
          error.message === `${command} is already running in this worktree (pid ${pid})`,
      )
      assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${pid} ${command}`, 'the holder keeps its lock')
    }
  })

  test('a lock that names no command (written by an older lntt) is refused as another lntt command', () => {
    const pid = live()
    held(String(pid))
    assert.throws(
      () => acquireLock(gitDir, 'lntt review'),
      /another lntt command is already running in this worktree \(pid \d+\)/,
    )
  })

  test('a lock whose process is gone, and untouched for a while, is taken over', () => {
    held('999999 lntt review', OLD)
    acquireLock(gitDir, 'lntt check tests mutate')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt check tests mutate`)
  })

  test('a lock with no valid pid is taken over', () => {
    held('garbage', 0)
    acquireLock(gitDir, 'lntt review')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt review`)
  })

  test('a pid this process cannot signal (EPERM) is a live holder, not a dead one', () => {
    // pid 1 belongs to root: signalling it fails with EPERM, ESRCH only for a pid that is gone.
    held('1 lntt review', OLD)
    assert.throws(() => acquireLock(gitDir, 'lntt check tests mutate'), /lntt review is already running .*\(pid 1\)/)
  })

  test('a pid this process cannot see, with a lock touched a moment ago, is a live holder', () => {
    // Another pid namespace answers ESRCH for a process that is running: the heartbeat says so.
    held('999999 lntt review', 1000)
    assert.throws(
      () => acquireLock(gitDir, 'lntt check tests mutate'),
      /lntt review is already running .*\(pid 999999\)/,
    )
  })

  test('the holder touches its lock: a lock it keeps fresh is not taken over by its pid being unseen', async () => {
    acquireLock(gitDir, 'lntt review', { heartbeatMs: 20 })
    const old = new Date(Date.now() - OLD)
    utimesSync(lockPath(gitDir), old, old)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(Date.now() - statSync(lockPath(gitDir)).mtimeMs < FRESH_MS, 'the heartbeat refreshed it')
  })

  // #287: two reviews of one worktree ran at once. Taking over a dead lock was unlink then
  // create: a second run that had judged the lock dead, and was about to remove it, removed
  // the one the first run had just created, and both held "the" lock.
  test('a run that judged the lock dead does not remove the live lock another run created since (#287)', () => {
    const pid = live()
    held('999999 lntt review', OLD)
    assert.throws(
      () =>
        acquireLock(gitDir, 'lntt review', {
          // The other run takes over between this run's judgement and its removal.
          judgedDead: () => held(`${pid} lntt review`),
        }),
      (error: Error) => error instanceof LockedError && error.message.includes(`(pid ${pid})`),
    )
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${pid} lntt review`, 'the live lock is still there')
  })

  test('a guard a crashed takeover left behind does not block the next one', () => {
    held('999999 lntt review', OLD)
    writeFileSync(`${lockPath(gitDir)}.takeover`, '')
    const old = new Date(Date.now() - OLD)
    utimesSync(`${lockPath(gitDir)}.takeover`, old, old)
    acquireLock(gitDir, 'lntt review')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt review`)
  })
})
