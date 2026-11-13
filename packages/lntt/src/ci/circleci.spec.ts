import { assert, describe, it } from '@effect/vitest'
import { parse } from 'yaml'
import { drive } from '../testing/asks.ts'
import { circleciJobs, type Processor } from './circleci.ts'
import { emptyConfig } from './config.ts'
import type { Event } from './event.ts'
import type { Job } from './plan.ts'

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

const root = '/repo'

// A pull request of feat/x into `base`, or a push to it.
const event = (name: 'pull_request' | 'push', base: string): Event => ({
  name,
  base,
  head: name === 'push' ? base : 'feat/x',
  sha: '0123456789abcdef',
  baseRef: `origin/${base}`,
  changed: ['src/a.ts'],
  repository: null,
  defaultBranch: 'main',
})

// The jobs of the repository holding `files`, processed by `processor`, with `changed` the files
// changed against a path-filtering base.
const jobsOf = (
  files: Record<string, string>,
  at: Event,
  config = emptyConfig(),
  processor: Processor = fakeProcessor([]),
  changed: string[] = ['src/a.ts'],
) =>
  drive(circleciJobs(root, at, config), {
    files: Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text])),
    process: (ask) => processor(ask.path, ask.text, ask.parameters),
    changed: () => changed,
  })

const byKey = (list: Job[], key: string) => {
  const job = list.find((j) => j.key === key)
  assert.ok(job, `no job ${key} in ${list.map((j) => j.key).join(', ')}`)
  return job
}

describe('circleciJobs', () => {
  it('no .circleci/config.yml, no jobs', async () => {
    assert.deepStrictEqual(await jobsOf({}, event('pull_request', 'main')), [])
  })

  it('steps are mapped, secondary images and filters reported, a context blocks the job', async () => {
    const list = await jobsOf({ '.circleci/config.yml': SIMPLE }, event('pull_request', 'main'))
    const job = byKey(list, 'circleci/test')
    assert.deepStrictEqual(job.state, { state: 'run' })
    assert.deepStrictEqual(
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
    assert.deepStrictEqual(tests.env, { FOO: 'bar', SMOKE: '1' })
    assert.deepStrictEqual(tests.shell, ['/bin/bash', '-eo', 'pipefail', '-c'])
    assert.deepStrictEqual(job.steps[4].condition?.decide(false), { known: true, value: false })
    assert.deepStrictEqual(job.steps[4].condition?.decide(true), { known: true, value: true })
    assert.match(job.notes.join('\n'), /cimg\/postgres:17\.0/)
    // deploy only runs on main: the pull request's branch is feat/x.
    assert.strictEqual(byKey(list, 'circleci/deploy').state.state, 'skipped')
  })

  it('a job with a context is blocked unless cloud-only', async () => {
    const files = { '.circleci/config.yml': SIMPLE }
    const push = event('push', 'main')
    const deploy = byKey(await jobsOf(files, push), 'circleci/deploy')
    assert.strictEqual(deploy.state.state, 'blocked')
    assert.match(deploy.state.state === 'blocked' ? deploy.state.reason : '', /context production/)
    const config = emptyConfig()
    config.cloudOnly = { 'circleci/deploy': 'deploys to production' }
    assert.strictEqual(byKey(await jobsOf(files, push, config), 'circleci/deploy').state.state, 'cloud-only')
  })

  it('dynamic config: a pull request into main follows the full continuation, with the mapped parameters', async () => {
    const files = {
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    }
    const seen: Array<{ path: string; parameters: Record<string, unknown> }> = []
    const list = await jobsOf(files, event('pull_request', 'main'), emptyConfig(), fakeProcessor(seen))
    const choose = byKey(list, 'circleci/choose').state
    assert.strictEqual(choose.state, 'cloud-only')
    assert.match(choose.state === 'cloud-only' ? choose.reason : '', /\.circleci\/full\.yml.*run-ci=true/)
    assert.deepStrictEqual(byKey(list, 'circleci/test').state, { state: 'run' })
    assert.strictEqual(
      list.some((j) => j.key === 'circleci/lint'),
      false,
    )
    assert.deepStrictEqual(seen.find((s) => s.path.endsWith('full.yml'))?.parameters, { 'run-ci': true })
  })

  it('dynamic config: a pull request into a candidate follows the minimal continuation', async () => {
    const files = {
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    }
    const list = await jobsOf(files, event('pull_request', 'candidate/2'))
    assert.deepStrictEqual(byKey(list, 'circleci/lint').state, { state: 'run' })
    assert.strictEqual(
      list.some((j) => j.key === 'circleci/test'),
      false,
    )
  })

  it('dynamic config: a change to docs only sets no parameter, and the continuation runs nothing', async () => {
    const files = {
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    }
    const list = await jobsOf(files, event('pull_request', 'main'), emptyConfig(), fakeProcessor([]), ['docs/a.md'])
    assert.strictEqual(byKey(list, 'circleci/test').state.state, 'skipped')
  })
})
