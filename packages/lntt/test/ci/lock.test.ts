import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Effect from 'effect/Effect'
import { CiProcesses } from '../../src/ci/lock.ts'
import { CiProcessesLive } from '../../src/ci/machine.ts'

// The ci:local lock `lntt ci local` takes (src/ci/lock.ts), on the real file system and between
// real processes: what neither the in-memory file system of src/ci/lock.spec.ts nor one process can
// show. Its rules are src/ci/lock-rules.spec.ts's.

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-lock-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const here = (path: string) => pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), path)).href

describe('three waiters on a dead holder’s lock', () => {
  // Each waiter takes the lock eight times, logs in and out, and then plays dead: it leaves its
  // record and names its pid in the dead file, so the others race to take over.
  const WAITER = `
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { acquire, CiProcesses } from ${JSON.stringify(here('../../src/ci/lock.ts'))}
const [dir, name] = process.argv.slice(1)
const dead = () => (existsSync(dir + '/dead') ? readFileSync(dir + '/dead', 'utf8').split('\\n') : [])
while (!existsSync(dir + '/go')) await new Promise((r) => setTimeout(r, 1))
for (let round = 1; round <= 8; round++) {
  const pid = process.pid * 10 + round
  const processes = Layer.succeed(CiProcesses)(
    CiProcesses.of({
      self: pid,
      host: 'here',
      // Slow to judge, so the waiters' verdicts and removals interleave.
      alive: (p) => Effect.sleep('3 millis').pipe(Effect.as(!dead().includes(String(p)))),
      groupAlive: () => Effect.succeed(false),
    }),
  )
  await Effect.runPromise(
    acquire({ path: dir + '/ci-local.lock', worktree: name, log: () => Effect.void, interval: 2 }).pipe(
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, processes)),
    ),
  )
  appendFileSync(dir + '/log', 'in ' + name + '\\n')
  await new Promise((r) => setTimeout(r, 5))
  appendFileSync(dir + '/log', 'out ' + name + '\\n')
  appendFileSync(dir + '/dead', pid + '\\n')
}
`

  test('exactly one holds the lock at a time', async () => {
    const started = new Date(Date.now() - 5 * 60_000).toISOString()
    writeFileSync(join(dir, 'ci-local.lock'), JSON.stringify({ pid: 1, host: 'here', worktree: '/w/other', started }))
    writeFileSync(join(dir, 'dead'), '1\n')
    const waiters = ['a', 'b', 'c'].map(
      (name) =>
        new Promise<number | null>((done) =>
          spawn(process.execPath, ['--input-type=module', '-e', WAITER, dir, name], {
            stdio: 'inherit',
            cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
          }).on('close', done),
        ),
    )
    writeFileSync(join(dir, 'go'), '')
    assert.deepEqual(await Promise.all(waiters), [0, 0, 0])
    const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')
    assert.equal(log.length, 48)
    for (let i = 0; i < log.length; i += 2) {
      assert.equal(log[i]?.replace('in ', 'out '), log[i + 1], `overlap at line ${i + 1}:\n${log.join('\n')}`)
    }
  })
})

describe('liveness', () => {
  const judged = <A>(f: (p: CiProcesses['Service']) => Effect.Effect<A>) =>
    Effect.runPromise(Effect.flatMap(CiProcesses, f).pipe(Effect.provide(CiProcessesLive)))

  test('a running process, one of another user (EPERM), a finished one; a process group', async () => {
    assert.equal(await judged((p) => p.alive(process.pid)), true)
    assert.equal(await judged((p) => p.alive(1)), true)
    const finished = spawnSync('true').pid as number
    assert.equal(await judged((p) => p.alive(finished)), false)
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    const closed = new Promise((done) => child.on('close', done))
    assert.equal(await judged((p) => p.groupAlive(child.pid as number)), true)
    process.kill(-(child.pid as number), 'SIGKILL')
    await closed
    assert.equal(await judged((p) => p.groupAlive(child.pid as number)), false)
  })
})
