import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, type TestContext, test } from 'node:test'
import { parse } from 'yaml'
import {
  CircleciLoginRejected,
  circleciJobs,
  circleciUnavailable,
  cliProcessor,
  type Processor,
} from '../../src/ci/circleci.ts'
import { emptyConfig } from '../../src/ci/config.ts'
import { localEvent } from '../../src/ci/event.ts'
import type { Job } from '../../src/ci/plan.ts'
import { repo } from './helpers.ts'

// Stands in for `circleci config process` on configs without orbs, commands or job
// parameters, where the processed config has the same jobs and workflows. The
// parameters it receives are recorded, and workflows whose `when` is the bare
// parameter are dropped as the CLI drops them.
function fakeProcessor(seen: Array<{ path: string; parameters: Record<string, unknown> }>): Processor {
  return (path, text, parameters) => {
    seen.push({ path, parameters })
    return { config: parse(text) }
  }
}

const PROBE = `
version: 2.1
jobs:
  probe:
    docker:
      - image: cimg/base:stable
    steps:
      - checkout
workflows:
  probe:
    jobs: [probe]
`

const SIMPLE = `
version: 2.1
jobs:
  test:
    docker:
      - image: cimg/node:24.15
      - image: cimg/postgres:17.0
    environment:
      FOO: bar
    steps:
      - checkout
      - restore_cache:
          keys: [x]
      - run: pnpm install --frozen-lockfile
      - run:
          name: tests
          command: pnpm test
          environment:
            SMOKE: '1'
      - run:
          name: on failure
          command: echo failed
          when: on_fail
      - store_test_results:
          path: reports
      - some_orb/unknown_command
  deploy:
    docker:
      - image: cimg/base:current
    steps:
      - run: ./deploy.sh
workflows:
  ci:
    jobs:
      - test
      - deploy:
          requires: [test]
          context: production
          filters:
            branches:
              only: main
`

// A dynamic configuration shaped like a path-filtering setup, with the choosing job
// defined locally so that no orb is resolved.
const SETUP = `
version: 2.1
setup: true
jobs:
  choose:
    parameters:
      config-path: { type: string }
      mapping: { type: string, default: '' }
      base-revision: { type: string, default: main }
    docker:
      - image: cimg/base:current
    steps:
      - run: echo choosing
workflows:
  full:
    when: pipeline.event.name != "pull_request" or pipeline.event.github.pull_request.base.ref == "main"
    jobs:
      - choose:
          config-path: .circleci/full.yml
          mapping: |
            (?!docs/).* run-ci true
  minimal:
    when: pipeline.event.name == "pull_request" and pipeline.event.github.pull_request.base.ref != "main"
    jobs:
      - choose:
          config-path: .circleci/minimal.yml
          mapping: |
            (?!docs/).* run-ci true
`

const continuation = (job: string) => `
version: 2.1
parameters:
  run-ci: { type: boolean, default: false }
jobs:
  ${job}:
    docker:
      - image: cimg/node:24.15
    steps:
      - checkout
      - run: pnpm ${job}
workflows:
  w:
    when: << pipeline.parameters.run-ci >>
    jobs: [${job}]
`

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

const byKey = (list: Job[], key: string) => {
  const job = list.find((j) => j.key === key)
  assert.ok(job, `no job ${key} in ${list.map((j) => j.key).join(', ')}`)
  return job
}

describe('circleciJobs', () => {
  test('no .circleci/config.yml, no jobs', () => {
    root = repo({})
    assert.deepEqual(circleciJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig(), fakeProcessor([])), [])
  })

  test('steps are mapped, secondary images and filters reported, a context blocks the job', () => {
    root = repo({ '.circleci/config.yml': SIMPLE })
    const list = circleciJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig(), fakeProcessor([]))
    const job = byKey(list, 'circleci/test')
    assert.deepEqual(job.state, { state: 'run' })
    assert.deepEqual(
      job.steps.map((s) => [s.label, s.local.kind]),
      [
        ['checkout', 'noop'],
        ['restore_cache', 'noop'],
        ['run: pnpm install --frozen-lockfile', 'run'],
        ['run: tests', 'run'],
        ['run: on failure', 'run'],
        ['store_test_results', 'noop'],
        ['some_orb/unknown_command', 'fail'],
      ],
    )
    const tests = job.steps[3].local
    assert.ok(tests.kind === 'run')
    assert.deepEqual(tests.env, { FOO: 'bar', SMOKE: '1' })
    assert.deepEqual(tests.shell, ['/bin/bash', '-eo', 'pipefail', '-c'])
    assert.deepEqual(job.steps[4].condition?.decide(false), { known: true, value: false })
    assert.deepEqual(job.steps[4].condition?.decide(true), { known: true, value: true })
    assert.match(job.notes.join('\n'), /cimg\/postgres:17\.0/)
    // deploy only runs on main: the pull request's branch is feat/x.
    assert.equal(byKey(list, 'circleci/deploy').state.state, 'skipped')
  })

  test('a job with a context is blocked unless cloud-only', () => {
    root = repo({ '.circleci/config.yml': SIMPLE })
    execFileSync('git', ['switch', '-q', 'main'], { cwd: root })
    const event = localEvent(root, 'push', 'main')
    const deploy = byKey(circleciJobs(root, event, emptyConfig(), fakeProcessor([])), 'circleci/deploy')
    assert.equal(deploy.state.state, 'blocked')
    assert.match(deploy.state.state === 'blocked' ? deploy.state.reason : '', /context production/)
    const config = emptyConfig()
    config.cloudOnly = { 'circleci/deploy': 'deploys to production' }
    assert.equal(
      byKey(circleciJobs(root, event, config, fakeProcessor([])), 'circleci/deploy').state.state,
      'cloud-only',
    )
  })

  test('dynamic config: a pull request into main follows the full continuation, with the mapped parameters', () => {
    root = repo({
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    })
    const seen: Array<{ path: string; parameters: Record<string, unknown> }> = []
    const list = circleciJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig(), fakeProcessor(seen))
    const choose = byKey(list, 'circleci/choose').state
    assert.equal(choose.state, 'cloud-only')
    assert.match(choose.state === 'cloud-only' ? choose.reason : '', /\.circleci\/full\.yml.*run-ci=true/)
    assert.deepEqual(byKey(list, 'circleci/test').state, { state: 'run' })
    assert.equal(
      list.some((j) => j.key === 'circleci/lint'),
      false,
    )
    assert.deepEqual(seen.find((s) => s.path.endsWith('full.yml'))?.parameters, { 'run-ci': true })
  })

  test('dynamic config: a pull request into a candidate follows the minimal continuation', () => {
    root = repo({
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    })
    const list = circleciJobs(root, localEvent(root, 'pull_request', 'candidate/2'), emptyConfig(), fakeProcessor([]))
    assert.deepEqual(byKey(list, 'circleci/lint').state, { state: 'run' })
    assert.equal(
      list.some((j) => j.key === 'circleci/test'),
      false,
    )
  })

  test('dynamic config: a change to docs only sets no parameter, and the continuation runs nothing', () => {
    root = repo(
      {
        '.circleci/config.yml': SETUP,
        '.circleci/full.yml': continuation('test'),
        '.circleci/minimal.yml': continuation('lint'),
      },
      { 'docs/a.md': 'x\n' },
    )
    const list = circleciJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig(), fakeProcessor([]))
    assert.equal(byKey(list, 'circleci/test').state.state, 'skipped')
  })

  test('the real circleci CLI processes the same dynamic config', { skip: realCliSkip() }, () => {
    root = repo({
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    })
    const list = circleciJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig(), cliProcessor(root))
    const job = byKey(list, 'circleci/test')
    assert.deepEqual(job.state, { state: 'run' })
    assert.deepEqual(
      job.steps.map((s) => s.label),
      ['checkout', 'run: pnpm test'],
    )
  })

  test('a rejected token is named, not reported as a generic failure', (t) => {
    root = repo({ '.circleci/config.yml': SIMPLE })
    stubCircleci(t, root, 'echo "Error: The API token was rejected by CircleCI" >&2; exit 255')
    assert.throws(() => cliProcessor(root)('.circleci/config.yml', SIMPLE, {}), CircleciLoginRejected)
  })

  test('any other failure of config process stays a generic one, with the CLI output', (t) => {
    root = repo({ '.circleci/config.yml': SIMPLE })
    stubCircleci(t, root, 'echo "Error: unknown orb" >&2; exit 1')
    assert.throws(
      () => cliProcessor(root)('.circleci/config.yml', SIMPLE, {}),
      (error) => !(error instanceof CircleciLoginRejected) && /config process .*unknown orb/.test(String(error)),
    )
  })

  test('circleciUnavailable: null when the CLI runs, a reason when it does not run or is missing', (t) => {
    root = repo({})
    stubCircleci(t, root, 'exit 0')
    assert.equal(circleciUnavailable(root), null)
    stubCircleci(t, root, 'echo "No version is set for shim: circleci" >&2; exit 126')
    assert.match(String(circleciUnavailable(root)), /does not run from/)
    process.env.PATH = join(root, 'empty')
    assert.match(String(circleciUnavailable(root)), /not installed/)
  })
})

// Puts a `circleci` script first on PATH for the test.
function stubCircleci(t: TestContext, dir: string, body: string): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'circleci'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  t.after(() => {
    process.env.PATH = path
  })
}

// Why the real-CLI test cannot run on this machine, or false. It probes in a folder
// outside the repo, as the test runs the CLI in one, and processes a trivial config,
// which is what a stored login that CircleCI rejects fails.
function realCliSkip(): string | false {
  const dir = repo({})
  try {
    const unavailable = circleciUnavailable(dir)
    if (unavailable) return unavailable
    cliProcessor(dir)('probe.yml', PROBE, {})
    return false
  } catch (error) {
    if (error instanceof CircleciLoginRejected) return error.message
    return `circleci config process does not run here: ${String(error)}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
