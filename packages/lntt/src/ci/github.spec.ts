import { assert, describe, it } from '@effect/vitest'
import { drive } from '../testing/asks.ts'
import { emptyConfig } from './config.ts'
import type { Event } from './event.ts'
import { githubJobs } from './github.ts'
import type { Job } from './plan.ts'

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

const root = '/repo'

// A pull request of feat/x, which changes src/a.ts, into `base`; or a push to it.
const event = (name: 'pull_request' | 'push', base: string): Event => ({
  name,
  base,
  head: 'feat/x',
  sha: '0123456789abcdef',
  baseRef: `origin/${base}`,
  changed: ['src/a.ts'],
  repository: null,
  defaultBranch: 'main',
})

// The files of the repository, by their paths under the root.
const under = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text]))

async function jobs(
  files: Record<string, string>,
  config = emptyConfig(),
  name: 'pull_request' | 'push' = 'pull_request',
) {
  return drive(githubJobs(root, event(name, 'main'), config), { files: under({ '.nvmrc': '24\n', ...files }) })
}

const byKey = (list: Job[], key: string) => {
  const job = list.find((j) => j.key === key)
  assert.ok(job, `no job ${key}`)
  return job
}

describe('githubJobs', () => {
  it('a pull request into main runs ci, in order, with each step mapped', async () => {
    const list = await jobs({ '.github/workflows/ci.yml': CI })
    const ci = byKey(list, 'ci.yml/ci')
    assert.deepStrictEqual(ci.state, { state: 'run' })
    assert.deepStrictEqual(
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
    assert.strictEqual(check.condition?.text, "success() && (github.event_name == 'pull_request')")
    assert.deepStrictEqual(check.condition?.decide(false), { known: true, value: true })
    assert.deepStrictEqual(check.condition?.decide(true), { known: true, value: false })
    assert.strictEqual(check.local.kind === 'run' && check.local.command, 'sh check.sh origin/main')
    const tests = ci.steps[4].local
    assert.ok(tests.kind === 'run')
    assert.strictEqual(tests.cwd, `${root}/packages/a`)
    assert.deepStrictEqual(tests.env, { TOP: 'top', SMOKE: '1' })
  })

  it('a workflow the event does not trigger is listed as skipped, with the reason', async () => {
    const list = await jobs({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE })
    assert.deepStrictEqual(byKey(list, 'release.yml/release').state, {
      state: 'skipped',
      reason: 'on: release, not pull_request',
    })
  })

  it('a pull request into another branch skips a workflow filtered on main', async () => {
    const list = await drive(githubJobs(root, event('pull_request', 'candidate/1'), emptyConfig()), {
      files: under({ '.github/workflows/ci.yml': CI }),
    })
    assert.strictEqual(byKey(list, 'ci.yml/ci').state.state, 'skipped')
  })

  it('a cloud-only job, by job key or by workflow file', async () => {
    const config = emptyConfig()
    config.cloudOnly = { 'ci.yml/ci': 'deploys' }
    assert.deepStrictEqual(byKey(await jobs({ '.github/workflows/ci.yml': CI }, config), 'ci.yml/ci').state, {
      state: 'cloud-only',
      reason: 'deploys',
    })
    config.cloudOnly = { 'ci.yml': 'whole workflow' }
    assert.strictEqual(
      byKey(await jobs({ '.github/workflows/ci.yml': CI }, config), 'ci.yml/ci').state.state,
      'cloud-only',
    )
  })

  it('an undeclared secret blocks its step, a fake one is used', async () => {
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
    assert.strictEqual(blocked.kind, 'blocked')
    assert.match(blocked.kind === 'blocked' ? blocked.reason : '', /secrets\.CANARY.*ci\.local\.fake\.secrets/)
    const config = emptyConfig()
    config.fake.secrets = { CANARY: 'not-a-secret' }
    const run = byKey(await jobs({ '.github/workflows/a.yml': wf }, config), 'a.yml/a').steps[0].local
    assert.ok(run.kind === 'run')
    assert.strictEqual(run.env.TOKEN, 'not-a-secret')
  })

  it('an unknown action fails, a mapped one runs or is skipped', async () => {
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
    assert.deepStrictEqual(
      steps.map((s) => s.local.kind),
      ['fail', 'noop', 'run'],
    )
  })

  it('a job condition the local run cannot evaluate blocks the job, naming what it reads', async () => {
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
    assert.strictEqual(b.state.state, 'blocked')
    assert.deepStrictEqual(b.needs, ['a.yml/a'])
    assert.match(b.state.state === 'blocked' ? b.state.reason : '', /needs\.a\.outputs\.changed/)
  })

  it('a draft-only or push-only condition is evaluated against the event', async () => {
    const wf = `
on: [push, pull_request]
jobs:
  only-push:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    assert.strictEqual(byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/only-push').state.state, 'skipped')
    assert.strictEqual(
      byKey(await jobs({ '.github/workflows/a.yml': wf }, emptyConfig(), 'push'), 'a.yml/only-push').state.state,
      'run',
    )
  })

  it('paths-ignore skips a workflow when every changed file is ignored', async () => {
    const wf = `
on:
  pull_request:
    paths-ignore: ['src/**']
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
`
    assert.strictEqual(byKey(await jobs({ '.github/workflows/a.yml': wf }), 'a.yml/a').state.state, 'skipped')
  })

  it('services and matrices are reported', async () => {
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
    assert.strictEqual(byKey(list, 'a.yml/m').state.state, 'blocked')
  })

  it('a broken workflow is an error, not an empty plan', async () => {
    const error = await jobs({
      '.github/workflows/a.yml': 'on: pull_request\njobs:\n  a:\n    runs-on: x\n    steps: 3\n',
    }).then(
      () => null,
      (error: Error) => error,
    )
    assert.match(error?.message ?? '', /^\.github\/workflows\/a\.yml: /)
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

  it('a pull request into the default branch runs the tests, one into a candidate does not', async () => {
    const files = { files: under({ '.github/workflows/ci.yml': wf }) }
    const full = byKey(await drive(githubJobs(root, event('pull_request', 'main'), emptyConfig()), files), 'ci.yml/ci')
    assert.deepStrictEqual(full.steps[1].condition?.decide(false), { known: true, value: true })
    const minimal = byKey(
      await drive(githubJobs(root, event('pull_request', 'candidate/3'), emptyConfig()), files),
      'ci.yml/ci',
    )
    assert.deepStrictEqual(minimal.state, { state: 'run' })
    assert.deepStrictEqual(minimal.steps[1].condition?.decide(false), { known: true, value: false })
  })
})

describe('review fixes', () => {
  it('an unknown action fails even when its inputs read an undeclared secret', async () => {
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
    assert.strictEqual(local.kind, 'fail')
  })

  it('without shell: bash -e as GitHub runs it; an explicit shell: bash adds pipefail', async () => {
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
    assert.deepStrictEqual(steps[0].local.kind === 'run' && steps[0].local.shell, ['bash', '-e', '-c'])
    assert.deepStrictEqual(steps[1].local.kind === 'run' && steps[1].local.shell, [
      'bash',
      '--noprofile',
      '--norc',
      '-eo',
      'pipefail',
      '-c',
    ])
  })

  it('a job with needs gets its condition decided after them', async () => {
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
    assert.deepStrictEqual(notify.state, { state: 'run' })
    assert.deepStrictEqual(notify.condition?.decide({ success: false, failure: true }), { known: true, value: true })
    assert.deepStrictEqual(notify.condition?.decide({ success: true, failure: false }), { known: true, value: false })
  })
})
