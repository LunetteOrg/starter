import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { git, repo, write } from './helpers.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt-ci.ts')

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
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_LOG: join(root, '.git', 'runner.log') },
  })
}

describe('lntt-ci local', () => {
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
