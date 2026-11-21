import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { circleciJobs } from '../../src/ci/circleci.ts'
import { emptyConfig } from '../../src/ci/config.ts'
import { localEvent } from '../../src/ci/event.ts'
import { runAsks } from '../../src/ci/host.ts'
import type { Job } from '../../src/ci/plan.ts'
import { gitAt } from '../../src/git/git.ts'
import { SpawnerLive } from '../../src/spawner.ts'
import { repo } from './helpers.ts'

// The real circleci CLI, through the loaders lntt ci local runs (src/ci/host.ts) on the machine:
// where it runs and its login is valid. What the CLI's failures say is src/ci/host.spec.ts's, the
// loader's logic src/ci/circleci.spec.ts's.

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
  test('the real circleci CLI processes the same dynamic config', { skip: realCliSkip() }, async () => {
    root = repo({
      '.circleci/config.yml': SETUP,
      '.circleci/full.yml': continuation('test'),
      '.circleci/minimal.yml': continuation('lint'),
    })
    const load = Effect.gen(function* () {
      const event = yield* localEvent('pull_request', 'main')
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: 'lntt-ci-' })
      return yield* runAsks(circleciJobs(root, event, emptyConfig()), { node: process.version, root, dir })
    })
    const list = await Effect.runPromise(
      load.pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(gitAt(root).pipe(Layer.provide(SpawnerLive)), SpawnerLive, NodeFileSystem.layer)),
      ),
    )
    const job = byKey(list, 'circleci/test')
    assert.deepEqual(job.state, { state: 'run' })
    assert.deepEqual(
      job.steps.map((s) => s.label),
      ['checkout', 'run: pnpm test'],
    )
  })
})

// Why the real-CLI test cannot run on this machine, or false: the CLI does not run from a
// temporary repo (where the test runs it), or its stored login is rejected, which a trivial
// `config process` shows. It runs when the file loads, since `skip` is decided at declaration;
// the call is one request to CircleCI, made only where the CLI is.
function realCliSkip(): string | false {
  const dir = repo({ 'probe.yml': PROBE })
  try {
    const r = spawnSync('circleci', ['config', 'process', 'probe.yml'], { cwd: dir, encoding: 'utf8' })
    if (r.error) return 'the circleci CLI is not installed'
    if (r.status !== 0) return `circleci config process failed here: ${(r.stderr || r.stdout).trim().split('\n')[0]}`
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
