import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, type TestContext, test } from 'node:test'
import { CircleciLoginRejected } from '../../src/ci/circleci.ts'
import { emptyConfig } from '../../src/ci/config.ts'
import type { Job } from '../../src/ci/plan.ts'
import { circleciJobs, circleciUnavailable, cliProcessor, localEvent } from '../../src/ci/sync.ts'
import { repo } from './helpers.ts'

// The circleci CLI itself, or a script in its place, through the library's synchronous shell
// (src/ci/sync.ts); the loader's logic is src/ci/circleci.spec.ts's.

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

describe('the circleci CLI', () => {
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
      (error) =>
        !(error instanceof CircleciLoginRejected) &&
        /config process \.circleci\/config\.yml: .*unknown orb/.test(String(error)),
    )
  })

  test('circleciUnavailable is null when the CLI runs', (t) => {
    root = repo({})
    stubCircleci(t, root, 'exit 0')
    assert.equal(circleciUnavailable(root), null)
  })

  test('circleciUnavailable names the folder when the CLI does not run from it', (t) => {
    root = repo({})
    stubCircleci(t, root, 'echo "No version is set for shim: circleci" >&2; exit 126')
    assert.ok(String(circleciUnavailable(root)).includes(`does not run from ${root}`))
  })

  test('a missing CLI is reported as not installed, by the probe and by the processor', (t) => {
    root = repo({})
    const path = process.env.PATH
    process.env.PATH = join(root, 'empty')
    t.after(() => {
      process.env.PATH = path
    })
    assert.match(String(circleciUnavailable(root)), /not installed/)
    assert.throws(() => cliProcessor(root)('.circleci/config.yml', SIMPLE, {}), /not installed/)
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

// Why the real-CLI test cannot run on this machine, or false: the CLI does not run from
// a temporary repo (where the test runs it), or the stored login is rejected, which a
// trivial `config process` shows. It runs when the file loads, since `skip` is decided
// at declaration; the call is one request to CircleCI, made only where the CLI is.
function realCliSkip(): string | false {
  const dir = repo({})
  try {
    const unavailable = circleciUnavailable(dir)
    if (unavailable) return unavailable
    cliProcessor(dir)('probe.yml', PROBE, {})
    return false
  } catch (error) {
    if (error instanceof CircleciLoginRejected) return error.message
    // Any other failure (the network, a regression) runs the test, which then fails with it.
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
