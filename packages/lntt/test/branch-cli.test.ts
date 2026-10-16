import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let stubs: string
let repo: string

// A fake CLI that prints a fixed answer, whatever it is asked.
function stub(name: string, output: string): void {
  writeFileSync(join(stubs, name), `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`)
  chmodSync(join(stubs, name), 0o755)
}

const ISSUE_77 = JSON.stringify({
  number: 77,
  title: 'Branch names follow type/issue/slug whatever tool creates the worktree',
  labels: [{ name: 'enhancement' }],
  type: null,
})

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

// No Orca or Herdr variables leak from the session running the tests.
function lntt(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM)/.test(k)))
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...clean, PATH: `${stubs}:${process.env.PATH}`, ...env },
  })
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-branch-')))
  stubs = join(tmp, 'bin')
  repo = join(tmp, 'repo')
  mkdirSync(stubs)
  mkdirSync(join(repo, '.agents'), { recursive: true })
  writeFileSync(join(repo, '.agents/config.jsonc'), '{}')
  git('init', '-q', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('lntt branch name', () => {
  test('from the issue: its type, its number, a slug of its title', () => {
    stub('gh', ISSUE_77)
    const r = lntt(['branch', 'name', '--issue', '77'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim(), 'feat/77/branch-names-follow-type')
  })

  test('--type and --slug override what the issue says', () => {
    stub('gh', ISSUE_77)
    const r = lntt(['branch', 'name', '--issue', '77', '--type', 'chore', '--slug', 'orca-names'])
    assert.equal(r.stdout.trim(), 'chore/77/orca-names')
  })

  test('without an issue: type and slug are required', () => {
    assert.equal(
      lntt(['branch', 'name', '--type', 'docs', '--slug', 'version-numbering']).stdout.trim(),
      'docs/no-issue/version-numbering',
    )
    assert.equal(lntt(['branch', 'name', '--type', 'docs']).status, 2)
  })
})

describe('lntt branch name, when the issue gives no usable name', () => {
  test('a title with nothing to slug is a red result (exit 1), not a usage error', () => {
    stub('gh', JSON.stringify({ number: 12, title: '🚀', labels: [], type: null }))
    const r = lntt(['branch', 'name', '--issue', '12'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /slug/)
    assert.doesNotMatch(r.stderr, /usage:/)
  })
})

describe('lntt branch check --pre-push', () => {
  const ZERO = '0000000000000000000000000000000000000000'
  const SHA = '1111111111111111111111111111111111111111'
  const push = (input: string) =>
    spawnSync(process.execPath, [BIN, 'branch', 'check', '--pre-push'], { cwd: repo, encoding: 'utf8', input })

  test('checks the branches being pushed, not the one checked out', () => {
    const r = push(`refs/heads/main ${SHA} refs/heads/wip ${ZERO}\n`)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /wip/)
    assert.equal(push(`refs/heads/x ${SHA} refs/heads/feat/1/ok ${ZERO}\n`).status, 0)
  })

  test('lets tags and branch deletions through', () => {
    git('switch', '-q', '-c', 'badly-named')
    assert.equal(push(`refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}\n`).status, 0)
    assert.equal(push(`(delete) ${ZERO} refs/heads/old-thing ${SHA}\n`).status, 0)
  })
})

describe('lntt branch check', () => {
  test('passes on the convention, fails elsewhere with the expected name', () => {
    git('switch', '-q', '-c', 'feat/77/branch-names')
    assert.equal(lntt(['branch', 'check']).status, 0)
    const r = lntt(['branch', 'check', '--branch', 'ilmeskio/feat-77-branch-names'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /rename it: git branch -m feat\/77\/branch-names/)
  })

  test('lets the base through', () => {
    assert.equal(lntt(['branch', 'check']).status, 0)
  })
})

describe('lntt branch rename', () => {
  test('reads the convention back from a flattened name', () => {
    git('switch', '-q', '-c', 'ilmeskio/chore-98-orca-yaml')
    const r = lntt(['branch', 'rename'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(git('branch', '--show-current'), 'chore/98/orca-yaml')
  })

  test('in Orca, builds the name from the linked issue', () => {
    git('switch', '-q', '-c', 'ilmeskio/probe-a')
    stub('gh', ISSUE_77)
    stub('orca', JSON.stringify({ ok: true, result: { worktree: { linkedIssue: 77 } } }))
    const r = lntt(['branch', 'rename'], { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'r::/p' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(git('branch', '--show-current'), 'feat/77/branch-names-follow-type')
  })

  test('leaves the branch alone when it already follows, or when nothing can be derived', () => {
    git('switch', '-q', '-c', 'feat/77/branch-names')
    assert.equal(lntt(['branch', 'rename']).status, 0)
    assert.equal(git('branch', '--show-current'), 'feat/77/branch-names')

    git('switch', '-q', '-c', 'ilmeskio/probe-b')
    const r = lntt(['branch', 'rename'])
    assert.equal(r.status, 0, 'a setup step must not fail on a name it cannot fix')
    assert.match(r.stderr, /lntt branch name --issue/)
    assert.equal(git('branch', '--show-current'), 'ilmeskio/probe-b')
  })

  test('in Orca, an issue that gives no valid name leaves the branch and the setup alone', () => {
    git('switch', '-q', '-c', 'ilmeskio/probe-c')
    stub('gh', JSON.stringify({ number: 12, title: '🚀', labels: [], type: null }))
    stub('orca', JSON.stringify({ ok: true, result: { worktree: { linkedIssue: 12 } } }))
    const r = lntt(['branch', 'rename'], { TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'r::/p' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /slug/)
    assert.equal(git('branch', '--show-current'), 'ilmeskio/probe-c')
  })

  test('a detached HEAD is reported, not an error', () => {
    git('switch', '-q', '--detach')
    const r = lntt(['branch', 'rename'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /detached/)
  })

  test('never overwrites an existing branch', () => {
    git('branch', 'chore/98/orca-yaml')
    git('switch', '-q', '-c', 'ilmeskio/chore-98-orca-yaml')
    const r = lntt(['branch', 'rename'])
    assert.equal(r.status, 0)
    assert.match(r.stderr, /already exists/)
    assert.equal(git('branch', '--show-current'), 'ilmeskio/chore-98-orca-yaml')
  })
})

describe('lntt worktree start', () => {
  test('in a plain terminal: a git worktree on the issue branch, setup run, the brief printed', () => {
    stub('gh', ISSUE_77)
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo ready > setup-ran\n')
    git('add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'setup')
    const r = lntt(['worktree', 'start', '--issue', '77'])
    assert.equal(r.status, 0, r.stderr)
    const path = join(repo, '.worktrees', 'feat-77-branch-names-follow-type')
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: path, encoding: 'utf8' }).trim(),
      'feat/77/branch-names-follow-type',
    )
    assert.match(r.stdout, /"host":"git"/)
    assert.match(r.stdout, /You are working on issue #77/)
  })

  test('--prompt replaces the brief', () => {
    stub('gh', ISSUE_77)
    const r = lntt(['worktree', 'start', '--issue', '77', '--prompt', 'Just say hello'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Just say hello/)
    assert.doesNotMatch(r.stdout, /You are working on issue/)
  })

  test('a batch reads every issue before creating anything', () => {
    writeFileSync(
      join(stubs, 'gh'),
      `#!/bin/sh\ncase "$*" in *issues/99*) echo 'Not Found' >&2; exit 1;; esac\ncat <<'EOF'\n${ISSUE_77}\nEOF\n`,
    )
    chmodSync(join(stubs, 'gh'), 0o755)
    const r = lntt(['worktree', 'start', '--issue', '77', '--issue', '99'])
    assert.equal(r.status, 1)
    assert.equal(git('worktree', 'list').split('\n').length, 1, 'no worktree for #77 either')
  })

  test('--host forces the adapter; an unknown one is a usage error', () => {
    assert.equal(lntt(['worktree', 'start', '--issue', '77', '--host', 'wave']).status, 2)
    assert.equal(lntt(['worktree', 'start']).status, 2)
  })
})
