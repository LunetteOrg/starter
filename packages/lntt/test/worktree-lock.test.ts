// The worktree's lock on the real machine: the Promise entry of lntt check tests mutate, over
// Node's file system and the pids of running processes. The rules of who holds the lock, the
// takeover and the scoped release are tested in memory beside the module
// (src/worktree/lock.spec.ts).

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
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
import { acquireLock, FRESH_MS, heldBy, isLocked, lockPath, releaseLock } from '../src/worktree-lock.ts'

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

describe('the lock of a worktree on Node, as lntt check tests mutate takes it', () => {
  test('is taken with the pid and the command, and goes with releaseLock', async () => {
    await acquireLock(gitDir, 'lntt check tests mutate')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt check tests mutate`)
    assert.deepEqual(readdirSync(gitDir), ['lntt-review.lock'], 'the file linked to the lock is gone')
    releaseLock(gitDir)
    assert.equal(existsSync(lockPath(gitDir)), false)
  })

  test('is refused while a live process holds it, naming its command and pid', async () => {
    const pid = live()
    held(`${pid} lntt review`)
    await assert.rejects(
      acquireLock(gitDir, 'lntt check tests mutate'),
      (error: unknown) =>
        isLocked(error) && error.message === `lntt review is already running in this worktree (pid ${pid})`,
    )
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${pid} lntt review`, 'the holder keeps its lock')
    assert.deepEqual(heldBy(gitDir), { pid, command: 'lntt review' })
  })

  test('a lock whose process is gone, and untouched for a while, is taken over', async () => {
    held('999999 lntt review', OLD)
    assert.equal(heldBy(gitDir), null)
    await acquireLock(gitDir, 'lntt check tests mutate')
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${process.pid} lntt check tests mutate`)
  })

  test('a pid this process cannot signal (EPERM) is a live holder, not a dead one', {
    skip: process.getuid?.() === 0,
  }, async () => {
    // pid 1 belongs to root: signalling it fails with EPERM, ESRCH only for a pid that is gone.
    // Run as root, the signal succeeds and the test would not reach EPERM: skipped there.
    held('1 lntt review', OLD)
    await assert.rejects(acquireLock(gitDir, 'lntt check tests mutate'), /lntt review is already running .*\(pid 1\)/)
  })

  test('a lock naming this very process is not held by another', () => {
    held(`${process.pid} lntt review`)
    assert.equal(heldBy(gitDir), null)
  })

  test('releaseLock leaves a lock that names another process', () => {
    const content = `${live()} lntt review`
    held(content)
    releaseLock(gitDir)
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), content)
  })

  test('the holder touches its lock, and never a lock another process took', async () => {
    await acquireLock(gitDir, 'lntt review', { heartbeatMs: 20 })
    const old = new Date(Date.now() - OLD)
    utimesSync(lockPath(gitDir), old, old)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(Date.now() - statSync(lockPath(gitDir)).mtimeMs < FRESH_MS, 'the heartbeat refreshed it')
    held(`${live()} lntt review`, OLD)
    const before = statSync(lockPath(gitDir)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(statSync(lockPath(gitDir)).mtimeMs, before)
  })
})
