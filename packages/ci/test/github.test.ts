import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { afterEach, describe, test } from 'node:test'
import { emptyConfig } from '../src/config.ts'
import { localEvent } from '../src/event.ts'
import { githubJobs } from '../src/github.ts'
import type { Job } from '../src/plan.ts'
import { repo } from './helpers.ts'

const CI = `
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
env:
  TOP: top
jobs:
  ci:
    if: \${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
      - run: pnpm lint
      - if: github.event_name == 'pull_request'
        run: sh check.sh origin/\${{ github.base_ref }}
      - name: tests
        run: pnpm test
        working-directory: packages/a
        env:
          SMOKE: '1'
`

const RELEASE = `
on:
  release:
    types: [published]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function jobs(
  files: Record<string, string>,
  config = emptyConfig(),
  name: 'pull_request' | 'push' = 'pull_request',
) {
  root = repo({ '.nvmrc': '24\n', ...files })
  return githubJobs(root, localEvent(root, name, 'main'), config)
}

const byKey = (list: Job[], key: string) => {
  const job = list.find((j) => j.key === key)
  assert.ok(job, `no job ${key}`)
  return job
}

describe('githubJobs', () => {
  test('a pull request into main runs ci, in order, with each step mapped', async () => {
    const list = await jobs({ '.github/workflows/ci.yml': CI })
    const ci = byKey(list, 'ci.yml/ci')
    assert.deepEqual(ci.state, { state: 'run' })
    assert.deepEqual(
      ci.steps.map((s) => [s.label, s.local.kind]),
      [
        ['uses: actions/checkout@v7', 'noop'],
        ['uses: actions/setup-node@v6', 'check'],
        ['run: pnpm lint', 'run'],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own text, not a JS template
        ['run: sh check.sh origin/${{ github.base_ref }}', 'run'],
        ['tests (run: pnpm test)', 'run'],
      ],
    )
    const check = ci.steps[3]
    assert.equal(check.condition?.text, "success() && (github.event_name == 'pull_request')")
    assert.deepEqual(check.condition?.decide(false), { known: true, value: true })
    assert.deepEqual(check.condition?.decide(true), { known: true, value: false })
    assert.equal(check.local.kind === 'run' && check.local.command, 'sh check.sh origin/main')
    const tests = ci.steps[4].local
    assert.ok(tests.kind === 'run')
    assert.equal(tests.cwd, `${root}/packages/a`)
    assert.deepEqual(tests.env, { TOP: 'top', SMOKE: '1' })
  })

  test('a workflow the event does not trigger is listed as skipped, with the reason', async () => {
    const list = await jobs({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE })
    assert.deepEqual(byKey(list, 'release.yml/release').state, {
      state: 'skipped',
      reason: 'on: release, not pull_request',
    })
  })

  test('a pull request into another branch skips a workflow filtered on main', async () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    const list = await githubJobs(root, localEvent(root, 'pull_request', 'candidate/1'), emptyConfig())
    assert.equal(byKey(list, 'ci.yml/ci').state.state, 'skipped')
  })

  test('a cloud-only job, by job key or by workflow file', async () => {
    const config = emptyConfig()
    config.cloudOnly = { 'ci.yml/ci': 'deploys' }
    assert.deepEqual(byKey(await jobs({ '.github/workflows/ci.yml': CI }, config), 'ci.yml/ci').state, {
      state: 'cloud-only',
      reason: 'deploys',
    })
    rmSync(root, { recursive: true, force: true })
    config.cloudOnly = { 'ci.yml': 'whole workflow' }
    assert.equal(byKey(await jobs({ '.github/workflows/ci.yml': CI }, config), 'ci.yml/ci').state.state, 'cloud-only')
  })

  test('an undeclared secret blocks its step, a fake one is used', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$TOKEN"
        env:
          TOKEN: \${{ secrets.CANARY }}
`
    const blocked = byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/a').steps[0].local
    assert.equal(blocked.kind, 'blocked')
    assert.match(blocked.kind === 'blocked' ? blocked.reason : '', /secrets\.CANARY.*ci\.local\.fake\.secrets/)
    rmSync(root, { recursive: true, force: true })
    const config = emptyConfig()
    config.fake.secrets = { CANARY: 'not-a-secret' }
    const run = byKey(await jobs({ '.github/workflows/a.yml': wf }, config), 'a.yml/a').steps[0].local
    assert.ok(run.kind === 'run')
    assert.equal(run.env.TOKEN, 'not-a-secret')
  })

  test('an unknown action fails, a mapped one runs or is skipped', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: someone/new-action@v1
      - uses: actions/upload-artifact@v4
      - uses: owner/lint@v2
`
    const config = emptyConfig()
    config.actions = {
      'actions/upload-artifact': { skip: 'nothing to upload locally' },
      'owner/lint': { run: 'pnpm lint' },
    }
    const steps = byKey(await jobs({ '.github/workflows/a.yml': wf }, config), 'a.yml/a').steps
    assert.deepEqual(
      steps.map((s) => s.local.kind),
      ['fail', 'noop', 'run'],
    )
  })

  test('a job condition the local run cannot evaluate blocks the job, naming what it reads', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  b:
    needs: a
    if: needs.a.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    const b = byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/b')
    assert.equal(b.state.state, 'blocked')
    assert.deepEqual(b.needs, ['a.yml/a'])
    assert.match(b.state.state === 'blocked' ? b.state.reason : '', /needs\.a\.outputs\.changed/)
  })

  test('a draft-only or push-only condition is evaluated against the event', async () => {
    const wf = `
on: [push, pull_request]
jobs:
  only-push:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    assert.equal(byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/only-push').state.state, 'skipped')
    rmSync(root, { recursive: true, force: true })
    assert.equal(
      byKey(await jobs({ '.github/workflows/a.yml': wf }, emptyConfig(), 'push'), 'a.yml/only-push').state.state,
      'run',
    )
  })

  test('paths-ignore skips a workflow when every changed file is ignored', async () => {
    const wf = `
on:
  pull_request:
    paths-ignore: ['src/**']
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    assert.equal(byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/a').state.state, 'skipped')
  })

  test('services and matrices are reported', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
    steps: [{ run: 'true' }]
  m:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 24]
    steps: [{ run: 'true' }]
`
    const list = await jobs({ '.github/workflows/a.yml': wf })
    assert.match(byKey(list, 'a.yml/a').notes.join('\n'), /services not started locally: postgres/)
    assert.equal(byKey(list, 'a.yml/m').state.state, 'blocked')
  })

  test('a broken workflow is an error, not an empty plan', async () => {
    await assert.rejects(
      jobs({ '.github/workflows/a.yml': 'on: pull_request\njobs:\n  a:\n    runs-on: x\n    steps: 3\n' }),
    )
  })
})

describe('the full and the minimal CI', () => {
  const wf = `
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  ci:
    if: github.event_name == 'push' || !github.event.pull_request.draft
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
      - if: github.event_name == 'push' || github.base_ref == github.event.repository.default_branch
        run: pnpm test
`

  test('a pull request into the default branch runs the tests, one into a candidate does not', async () => {
    root = repo({ '.github/workflows/ci.yml': wf })
    const full = byKey(await githubJobs(root, localEvent(root, 'pull_request', 'main'), emptyConfig()), 'ci.yml/ci')
    assert.deepEqual(full.steps[1].condition?.decide(false), { known: true, value: true })
    const minimal = byKey(
      await githubJobs(root, localEvent(root, 'pull_request', 'candidate/3'), emptyConfig()),
      'ci.yml/ci',
    )
    assert.deepEqual(minimal.state, { state: 'run' })
    assert.deepEqual(minimal.steps[1].condition?.decide(false), { known: true, value: false })
  })
})

describe('review fixes', () => {
  test('an unknown action fails even when its inputs read an undeclared secret', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: some/deploy@v1
        with:
          token: \${{ secrets.DEPLOY }}
`
    const local = byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/a').steps[0].local
    assert.equal(local.kind, 'fail')
  })

  test('without shell: bash -e as GitHub runs it; an explicit shell: bash adds pipefail', async () => {
    const wf = `
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: 'false | true'
      - run: 'false | true'
        shell: bash
`
    const steps = byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/a').steps
    assert.deepEqual(steps[0].local.kind === 'run' && steps[0].local.shell, ['bash', '-e', '-c'])
    assert.deepEqual(steps[1].local.kind === 'run' && steps[1].local.shell, [
      'bash',
      '--noprofile',
      '--norc',
      '-eo',
      'pipefail',
      '-c',
    ])
  })

  test('a job with needs gets its condition decided after them', async () => {
    const wf = `
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  notify:
    needs: build
    if: failure()
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    const notify = byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/notify')
    assert.deepEqual(notify.state, { state: 'run' })
    assert.deepEqual(notify.condition?.decide({ success: false, failure: true }), { known: true, value: true })
    assert.deepEqual(notify.condition?.decide({ success: true, failure: false }), { known: true, value: false })
  })
})
