// The worktree's lock on the real machine: lockWorktree, a resource of a scope, over Node's file
// system and the pids of running processes, as lntt review and lntt check tests mutate hold it.
// The rules of who holds the lock, the takeover and the scoped release are tested in memory beside
// the module (src/worktree/lock.spec.ts).

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
import * as Effect from 'effect/Effect'
import { lockWorktree, WorktreeLockLive } from '../src/worktree/lock.ts'
import { FRESH_MS, heldBy, lockPath } from '../src/worktree-lock.ts'

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

// The lock held for `command` while `during` runs, released with the scope: what `during` saw, or
// the refusal's message.
function hold<A>(command: string, during: () => A = () => undefined as A): Promise<A | string> {
  return Effect.runPromise(
    Effect.scoped(Effect.andThen(lockWorktree(gitDir, command), Effect.sync(during))).pipe(
      Effect.catchTag('LockedError', (error) => Effect.succeed(error.message)),
      Effect.provide(WorktreeLockLive),
    ),
  )
}

const OLD = FRESH_MS * 4

beforeEach(() => {
  gitDir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-lock-')))
})

afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
  rmSync(gitDir, { recursive: true, force: true })
})

describe('the lock of a worktree on Node', () => {
  test('is taken with the pid and the command, alone in the git directory, and goes with the scope', async () => {
    const seen = await hold('lntt check tests mutate', () => ({
      text: readFileSync(lockPath(gitDir), 'utf8'),
      files: readdirSync(gitDir),
    }))
    assert.deepEqual(seen, {
      text: `${process.pid} lntt check tests mutate`,
      files: ['lntt-review.lock'],
    })
    assert.equal(existsSync(lockPath(gitDir)), false)
  })

  test('is refused while a live process holds it, naming its command and pid', async () => {
    const pid = live()
    held(`${pid} lntt review`)
    assert.equal(await hold('lntt check tests mutate'), `lntt review is already running in this worktree (pid ${pid})`)
    assert.equal(readFileSync(lockPath(gitDir), 'utf8'), `${pid} lntt review`, 'the holder keeps its lock')
    assert.deepEqual(heldBy(gitDir), { pid, command: 'lntt review' })
  })

  test('a lock whose process is gone, and untouched for a while, is taken over', async () => {
    held('999999 lntt review', OLD)
    assert.equal(heldBy(gitDir), null)
    assert.equal(
      await hold('lntt check tests mutate', () => readFileSync(lockPath(gitDir), 'utf8')),
      `${process.pid} lntt check tests mutate`,
    )
  })

  test('a pid this process cannot signal (EPERM) is a live holder, not a dead one', {
    skip: process.getuid?.() === 0,
  }, async () => {
    // pid 1 belongs to root: signalling it fails with EPERM, ESRCH only for a pid that is gone.
    // Run as root, the signal succeeds and the test would not reach EPERM: skipped there.
    held('1 lntt review', OLD)
    assert.match(String(await hold('lntt check tests mutate')), /lntt review is already running .*\(pid 1\)/)
  })

  test('a lock naming this very process is not held by another', () => {
    held(`${process.pid} lntt review`)
    assert.equal(heldBy(gitDir), null)
  })

  test("lockWorktree's heartbeat sets the lock's real mtime to now, and the scope removes it", async () => {
    const lock = lockPath(gitDir)
    const ages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* lockWorktree(gitDir, 'lntt review', { heartbeat: '20 millis' })
          const old = new Date(Date.now() - OLD)
          utimesSync(lock, old, old)
          // A beat is awaited, not a span of time: a loaded machine may run it late.
          for (let waited = 0; Date.now() - statSync(lock).mtimeMs >= FRESH_MS && waited < 10_000; waited += 10)
            yield* Effect.sleep('10 millis')
          return Date.now() - statSync(lock).mtimeMs
        }),
      ).pipe(Effect.provide(WorktreeLockLive)),
    )
    assert.ok(ages >= 0 && ages < FRESH_MS, `touched to now, not ${ages} ms from now`)
    assert.equal(existsSync(lock), false)
  })
})
