import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { SHELLS } from '../../src/ci/actions.ts'
import type { Event } from '../../src/ci/event.ts'
import type { Job, Local, Step } from '../../src/ci/plan.ts'
import { formatReport } from '../../src/ci/report.ts'
import { exitCode, machineLoad, ordered, runJobs } from '../../src/ci/run.ts'

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

describe('runJobs', () => {
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

  test('after a failure only steps that ask for it run', async () => {
    const results = await runJobs(
      [
        job('ci.yml/a', [
          { label: 'boom', local: run('exit 3') },
          { label: 'next', local: run('echo next >> out') },
          {
            label: 'report',
            condition: { text: 'failure()', decide: (failed) => ({ known: true, value: failed }) },
            local: run('echo report >> out'),
          },
        ]),
      ],
      quiet,
    )
    assert.equal(readFileSync(join(dir, 'out'), 'utf8'), 'report\n')
    assert.deepEqual(
      results[0].steps.map((s) => s.status),
      ['failed', 'skipped', 'passed'],
    )
    assert.equal(results[0].status, 'failed')
    assert.equal(exitCode(results, { strict: false }), 1)
  })

  test('no-ops, checks, blocked steps and unknown steps', async () => {
    const results = await runJobs(
      [
        job('ci.yml/a', [
          { label: 'checkout', local: { kind: 'noop', note: 'tree' } },
          { label: 'node', local: { kind: 'check', note: 'n', check: () => null } },
          { label: 'secret', local: { kind: 'blocked', reason: 'needs secrets.X' } },
          { label: 'pnpm', local: { kind: 'check', note: 'p', check: () => 'pnpm missing' } },
        ]),
      ],
      quiet,
    )
    assert.deepEqual(
      results[0].steps.map((s) => [s.status, s.reason]),
      [
        ['noop', 'tree'],
        ['passed', 'n'],
        ['blocked', 'needs secrets.X'],
        ['failed', 'pnpm missing'],
      ],
    )
  })

  test('a condition the run cannot evaluate blocks the step', async () => {
    const results = await runJobs(
      [
        job('ci.yml/a', [
          {
            label: 'x',
            condition: { text: 'steps.a.outputs.b', decide: () => ({ known: false, unknown: ['steps.a.outputs.b'] }) },
            local: run('true'),
          },
        ]),
      ],
      quiet,
    )
    assert.equal(results[0].steps[0].status, 'blocked')
    assert.equal(results[0].status, 'passed')
  })

  test('jobs follow needs; a job whose need failed is skipped; others go on', async () => {
    const jobs = [
      job('ci.yml/deploy', [{ label: 'd', local: run('true') }], { needs: ['ci.yml/build'] }),
      job('ci.yml/build', [{ label: 'b', local: run('exit 1') }]),
      job('ci.yml/lint', [{ label: 'l', local: run('true') }]),
    ]
    assert.deepEqual(
      ordered(jobs).map((j) => j.key),
      ['ci.yml/build', 'ci.yml/deploy', 'ci.yml/lint'],
    )
    const started: string[] = []
    const results = await runJobs(jobs, { ...quiet, onJob: (key) => started.push(key) })
    assert.deepEqual(started, ['ci.yml/build', 'ci.yml/lint'])
    const status = Object.fromEntries(results.map((r) => [r.key, r.status]))
    assert.deepEqual(status, { 'ci.yml/build': 'failed', 'ci.yml/deploy': 'skipped', 'ci.yml/lint': 'passed' })
  })

  test('cloud-only, skipped and blocked jobs are reported, not run; --strict fails on blocked', async () => {
    const results = await runJobs(
      [
        job('release.yml/release', [{ label: 'p', local: run('echo no >> out') }], {
          state: { state: 'cloud-only', reason: 'publishes' },
        }),
        job('ci.yml/b', [{ label: 'x', local: run('echo no >> out') }], {
          state: { state: 'blocked', reason: 'matrix' },
        }),
        job('ci.yml/c', [{ label: 'y', local: { kind: 'blocked', reason: 'secret' } }]),
      ],
      quiet,
    )
    assert.deepEqual(
      results.map((r) => [r.status, r.reason]),
      [
        ['cloud-only', 'publishes'],
        ['blocked', 'matrix'],
        ['passed', undefined],
      ],
    )
    assert.equal(exitCode(results, { strict: false }), 0)
    assert.equal(exitCode(results, { strict: true }), 1)
  })

  test('--job runs only the jobs named', async () => {
    const results = await runJobs(
      [job('ci.yml/a', [{ label: 'a', local: run('true') }]), job('ci.yml/b', [{ label: 'b', local: run('true') }])],
      { ...quiet, only: ['ci.yml/b'] },
    )
    assert.deepEqual(
      results.map((r) => [r.key, r.status]),
      [
        ['ci.yml/a', 'not-selected'],
        ['ci.yml/b', 'passed'],
      ],
    )
  })
})

describe('job conditions after needs', () => {
  const after = (text: string, f: (n: { success: boolean; failure: boolean }) => boolean) => ({
    text,
    decide: (n: { success: boolean; failure: boolean }) => ({ known: true as const, value: f(n) }),
  })

  test('always() and failure() jobs run after a failed need; a success() job does not', async () => {
    const results = await runJobs(
      [
        job('ci.yml/build', [{ label: 'b', local: run('exit 1') }]),
        job('ci.yml/deploy', [{ label: 'd', local: run('true') }], {
          needs: ['ci.yml/build'],
          condition: after('success()', (n) => n.success),
        }),
        job('ci.yml/notify', [{ label: 'n', local: run('true') }], {
          needs: ['ci.yml/build'],
          condition: after('failure()', (n) => n.failure),
        }),
        job('ci.yml/cleanup', [{ label: 'c', local: run('true') }], {
          needs: ['ci.yml/build'],
          condition: after('always()', () => true),
        }),
      ],
      quiet,
    )
    assert.deepEqual(
      results.map((r) => [r.key, r.status]),
      [
        ['ci.yml/build', 'failed'],
        ['ci.yml/deploy', 'skipped'],
        ['ci.yml/notify', 'passed'],
        ['ci.yml/cleanup', 'passed'],
      ],
    )
  })

  test('a need that is cloud-only, blocked or skipped makes success() false; without a condition too', async () => {
    const results = await runJobs(
      [
        job('ci.yml/release', [], { state: { state: 'cloud-only', reason: 'r' } }),
        job('ci.yml/after', [{ label: 'a', local: run('true') }], {
          needs: ['ci.yml/release'],
          condition: after('success()', (n) => n.success),
        }),
        job('circleci/next', [{ label: 'n', local: run('true') }], { needs: ['ci.yml/release'] }),
      ],
      quiet,
    )
    assert.deepEqual(
      results.map((r) => r.status),
      ['cloud-only', 'skipped', 'skipped'],
    )
    assert.match(results[1].reason ?? '', /ci\.yml\/release: cloud-only/)
  })

  test('a job left out by --job is reported as not selected', async () => {
    const results = await runJobs([job('ci.yml/a', [{ label: 'a', local: run('true') }])], { ...quiet, only: [] })
    assert.equal(results[0].status, 'not-selected')
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

describe('timeouts', () => {
  const failure = { text: 'failure()', decide: (failed: boolean) => ({ known: true as const, value: failed }) }

  test('a step that outlasts the timeout is stopped with its process group, and fails naming the load', async () => {
    const started = Date.now()
    const results = await runJobs(
      [
        job('ci.yml/a', [
          // A child of the shell that would write after the timeout, unless its group is stopped.
          { label: 'hang', local: run('(sleep 1; echo late > late) & sleep 30') },
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
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(existsSync(join(dir, 'late')), false)
  })

  test('in container mode the timeout is the whole job', async () => {
    const results = await runJobs([job('ci.yml/a', [{ label: 'x', local: run('true') }])], {
      ...quiet,
      container: () => ['sh', '-c', 'sleep 30'],
      timeoutMs: 200,
      load: () => 'load 1.0 / 1.0 / 1.0 on 2 cores',
    })
    assert.deepEqual(
      [results[0].status, results[0].reason, results[0].timedOut],
      ['failed', 'timed out after 0.2s — load 1.0 / 1.0 / 1.0 on 2 cores', true],
    )
  })

  test('a step within the timeout passes', async () => {
    const results = await runJobs([job('ci.yml/a', [{ label: 'quick', local: run('true') }])], {
      ...quiet,
      timeoutMs: 5000,
      load: () => assert.fail('no load is read without a timeout'),
    })
    assert.equal(results[0].status, 'passed')
  })

  test('the machine load names the load average and the cores', () => {
    assert.match(machineLoad(), /^load \d+\.\d \/ \d+\.\d \/ \d+\.\d on \d+ cores/)
  })

  test('the report prints the timeout next to the step and says it is not a verdict', async () => {
    const event: Event = {
      name: 'pull_request',
      base: 'main',
      head: 'feat/x',
      sha: '0123456789abcdef',
      baseRef: 'main',
      changed: [],
      repository: null,
      defaultBranch: 'main',
    }
    const results = await runJobs([job('ci.yml/a', [{ label: 'hang', local: run('sleep 30') }])], {
      ...quiet,
      timeoutMs: 100,
      load: () => 'load 48.2 / 31.0 / 20.5 on 15 cores, 9 containers running (7 Testcontainers)',
    })
    const report = formatReport(event, results, { strict: false })
    assert.match(report, /✖ ci\.yml\/a .* failed: hang timed out/)
    assert.match(
      report,
      /✖ hang .*\(timed out after 0\.1s — load 48\.2 \/ 31\.0 \/ 20\.5 on 15 cores, 9 containers running \(7 Testcontainers\)\)/,
    )
    assert.match(report, /A timeout is not a verdict on the code/)
    const green = formatReport(event, await runJobs([job('ci.yml/a', [{ label: 'q', local: run('true') }])], quiet), {
      strict: false,
    })
    assert.doesNotMatch(green, /timeout/)
  })
})
