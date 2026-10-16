import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { git, repo, write } from './helpers.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/lntt.ts')

const CI = `
on:
  pull_request:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: echo lint >> "$RUNNER_LOG"
      - run: test -f must-exist
`

const RELEASE = `
on: [pull_request]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: echo published >> "$RUNNER_LOG"
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

function ci(...args: string[]) {
  return spawnSync(process.execPath, [BIN, 'ci', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_LOG: join(root, '.git', 'runner.log') },
  })
}

describe('lntt ci local', () => {
  test('--list shows each job, what the cloud runs and what runs locally', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    const out = ci('local', '--list')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /pull request feat\/x → main/)
    assert.match(out.stdout, /ci\.yml\/ci .* runs locally/)
    assert.match(out.stdout, /uses: actions\/checkout@v7\n\s+→ no-op: the working tree is the checkout/)
  })

  test('refuses a dirty working tree', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    writeFileSync(join(root, 'dirty'), 'x')
    const out = ci('local')
    assert.equal(out.status, 1)
    assert.match(out.stderr, /uncommitted changes/)
  })

  test('a red step fails the run, and the report says which', () => {
    root = repo({ '.github/workflows/ci.yml': CI })
    const out = ci('local')
    assert.equal(out.status, 1)
    assert.match(out.stdout, /✖ ci\.yml\/ci/)
    assert.match(out.stdout, /✖ run: test -f must-exist/)
  })

  test('green, with an undeclared secret reported as not run; --strict fails on it; cloud-only passes', () => {
    root = repo({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE, 'must-exist': '' })
    let out = ci('local')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /⚠ run: echo published .*secrets\.NPM_TOKEN/)
    assert.equal(ci('local', '--strict').status, 1)

    write(root, {
      '.agents/config.jsonc': JSON.stringify({ ci: { local: { cloudOnly: { 'release.yml': 'publishes to npm' } } } }),
    })
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'config')
    out = ci('local', '--strict')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /☁ release\.yml\/release {2}cloud-only: publishes to npm/)
  })

  test('--job runs one job; an unknown one is a usage error', () => {
    root = repo({ '.github/workflows/ci.yml': CI, 'must-exist': '' })
    assert.equal(ci('local', '--job', 'ci.yml/ci').status, 0)
    const out = ci('local', '--job', 'nope')
    assert.equal(out.status, 2)
    assert.match(out.stderr, /no job nope \(ci\.yml\/ci\)/)
  })

  test('a usage error exits 2', () => {
    root = repo({})
    assert.equal(ci('nothing').status, 2)
    assert.equal(ci('local', '--event', 'release').status, 2)
  })
})

describe('lntt ci candidate', () => {
  const CONFIG = { delivery: { candidate: { prefix: 'candidate/' } } }

  function candidate(event: unknown, ...args: string[]) {
    write(root, { '.git/event.json': JSON.stringify(event) })
    // A gh that answers the open-candidate query and records every call.
    write(root, {
      '.git/bin/gh': `#!/bin/sh\necho "$*" >> "${root}/.git/gh.log"\ncase "$*" in *"--state open"*) echo '[{"number":40,"headRefName":"candidate/4","body":""}]';; esac\n`,
    })
    execFileSync('chmod', ['+x', join(root, '.git/bin/gh')])
    return spawnSync(process.execPath, [BIN, 'ci', 'candidate', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, '.git/bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_PATH: join(root, '.git/event.json'),
      },
    })
  }

  const opened = (fields = {}) => ({
    action: 'opened',
    pull_request: {
      number: 7,
      title: 't',
      body: 'Closes #3',
      base: { ref: 'main' },
      head: { ref: 'feat/3/x' },
      labels: [],
      ...fields,
    },
  })

  test('without delivery.candidate it does nothing, with a notice', () => {
    root = repo({})
    const out = candidate(opened())
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /::notice::no delivery\.candidate/)
  })

  test('a pull request opened into main moves onto the open candidate (dry run)', () => {
    root = repo({ '.agents/config.jsonc': JSON.stringify(CONFIG) })
    const out = candidate(opened(), '--dry-run')
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\[dry-run\] gh pr edit 7 --repo o\/r --base candidate\/4/)
    assert.match(out.stdout, /\[dry-run\] gh pr comment 7/)
  })

  test('a hotfix stays on main and reads nothing', () => {
    root = repo({ '.agents/config.jsonc': JSON.stringify(CONFIG) })
    const out = candidate(opened({ head: { ref: 'hotfix/login' } }))
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /it stays, a hotfix stays on main/)
  })
})

describe('reporting', () => {
  test('--list says which steps the event skips', () => {
    root = repo({
      '.github/workflows/ci.yml': `
on: pull_request
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - if: github.base_ref == 'main'
        run: pnpm test
`,
    })
    assert.match(ci('local', '--list').stdout, /pnpm test .*\n\s+→ runs on the host/)
    assert.match(
      ci('local', '--list', '--base', 'candidate/1').stdout,
      /pnpm test .*\n\s+→ skipped: the condition is false for this event/,
    )
  })

  test('the summary names jobs left out by --job as not selected', () => {
    root = repo({ '.github/workflows/ci.yml': CI, '.github/workflows/release.yml': RELEASE, 'must-exist': '' })
    const out = ci('local', '--job', 'ci.yml/ci')
    assert.equal(out.status, 0, out.stdout + out.stderr)
    assert.match(out.stdout, /1 passed, 0 failed, 0 cloud only, 0 skipped, 1 not selected with --job/)
  })
})
