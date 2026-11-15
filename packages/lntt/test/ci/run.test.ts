import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { SHELLS } from '../../src/ci/actions.ts'
import type { Job, Local, Step } from '../../src/ci/plan.ts'
import { runJobs, stopRunning } from '../../src/ci/run.ts'

// The library's Promise form of the run (src/ci/run.ts) on real processes: what only a process
// group on the machine shows. The run's logic is src/ci/runner.spec.ts's, on an in-memory spawner.

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-run-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (command: string, env: Record<string, string> = {}): Local => ({
  kind: 'run',
  command,
  shell: SHELLS.bash,
  cwd: dir,
  env,
})

function job(key: string, steps: Step[], extra: Partial<Job> = {}): Job {
  return { key, provider: 'github', workflow: 'ci.yml', needs: [], state: { state: 'run' }, notes: [], steps, ...extra }
}

const quiet = { log: () => {}, output: 'ignore' as const }

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) assert.fail('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// Waits for a process (a negative pid: a process group) to be gone.
function gone(pid: number): Promise<void> {
  return until(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  })
}

describe('runJobs on the machine', () => {
  const failure = { text: 'failure()', decide: (failed: boolean) => ({ known: true as const, value: failed }) }

  test('steps run in order on the host, with their env and CI=true', async () => {
    const results = await runJobs(
      [
        job('ci.yml/a', [
          { label: 'one', local: run('echo "$X-$CI" >> out', { X: 'x' }) },
          { label: 'two', local: run('echo two >> out') },
        ]),
      ],
      quiet,
    )
    assert.equal(readFileSync(join(dir, 'out'), 'utf8'), 'x-true\ntwo\n')
    assert.deepEqual(
      results[0].steps.map((s) => s.status),
      ['passed', 'passed'],
    )
    assert.equal(results[0].status, 'passed')
  })

  test('a step that outlasts the timeout is stopped with its process group, and fails naming the load', async () => {
    const started = Date.now()
    const results = await runJobs(
      [
        job('ci.yml/a', [
          // A child of the shell that would write later, unless its group is stopped.
          { label: 'hang', local: run('(sleep 30; echo late > late) & echo $! > child; sleep 30') },
          { label: 'next', local: run('echo next >> out') },
          { label: 'report', condition: failure, local: run('echo report >> out') },
        ]),
      ],
      { ...quiet, timeoutMs: 300, load: () => 'load 9.0 / 8.0 / 7.0 on 4 cores' },
    )
    assert.ok(Date.now() - started < 3000)
    assert.deepEqual(
      results[0].steps.map((s) => [s.status, s.reason, s.timedOut]),
      [
        ['failed', 'timed out after 0.3s — load 9.0 / 8.0 / 7.0 on 4 cores', true],
        ['skipped', 'an earlier step failed', undefined],
        ['passed', undefined, undefined],
      ],
    )
    assert.equal(results[0].status, 'failed')
    assert.equal(results[0].reason, 'hang timed out')
    assert.equal(readFileSync(join(dir, 'out'), 'utf8'), 'report\n')
    await gone(Number(readFileSync(join(dir, 'child'), 'utf8')))
  })

  test('a step that ignores SIGTERM is killed once the grace has passed', async () => {
    const started = Date.now()
    const results = await runJobs([job('ci.yml/a', [{ label: 'stubborn', local: run("trap '' TERM; sleep 30") }])], {
      ...quiet,
      timeoutMs: 300,
      killAfterMs: 300,
      load: () => 'load',
    })
    assert.equal(results[0].steps[0].reason, 'timed out after 0.3s — load')
    const took = Date.now() - started
    // It outlived the SIGTERM, and went with the SIGKILL.
    assert.ok(took >= 600 && took < 2000, `took ${took} ms`)
  })
})

test('the default shell does not fail a pipeline on its first command, as on GitHub', async () => {
  const results = await runJobs(
    [
      job('ci.yml/a', [
        { label: 'p', local: { kind: 'run', command: 'false | true', shell: SHELLS.default, cwd: dir, env: {} } },
      ]),
    ],
    quiet,
  )
  assert.equal(results[0].status, 'passed')
})

describe('stopping', () => {
  test('an interrupt starts no further step, failure() steps and later jobs included', async () => {
    const interrupt = new AbortController()
    const groups: (number | null)[] = []
    const running = runJobs(
      [
        job('ci.yml/a', [
          { label: 'long', local: run('sleep 30') },
          {
            label: 'report',
            condition: { text: 'failure()', decide: (failed) => ({ known: true, value: failed }) },
            local: run('echo report >> out'),
          },
        ]),
        job('ci.yml/b', [{ label: 'b', local: run('echo b >> out') }]),
      ],
      { ...quiet, signal: interrupt.signal, onGroup: (group) => groups.push(group) },
    )
    await until(() => groups.length > 0)
    interrupt.abort()
    await stopRunning()
    const results = await running
    assert.deepEqual(
      results[0].steps.map((s) => s.status),
      ['failed', 'skipped'],
    )
    assert.equal(results[0].steps[1].reason, 'interrupted')
    assert.deepEqual([results[1].status, results[1].reason], ['skipped', 'interrupted'])
    assert.equal(existsSync(join(dir, 'out')), false)
    assert.deepEqual(groups, [groups[0], null])
  })

  test('stopRunning gives up waiting after its cap; the SIGKILL follows the run’s grace', async () => {
    let group = 0
    const running = runJobs(
      [job('ci.yml/a', [{ label: 'stubborn', local: run("trap '' TERM; touch ready; sleep 30") }])],
      {
        ...quiet,
        killAfterMs: 1500,
        onGroup: (g) => {
          if (g) group = g
        },
      },
    )
    await until(() => group !== 0)
    await until(() => existsSync(join(dir, 'ready')))
    const started = Date.now()
    await stopRunning({ capMs: 200 })
    assert.ok(Date.now() - started < 1000, `waited ${Date.now() - started} ms`)
    assert.doesNotThrow(() => process.kill(-group, 0), 'the group still runs after the cap')
    await running
    await gone(-group)
  })
})
