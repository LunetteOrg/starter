import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadOperator } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let main: string
let worktree: string
let home: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-operator-')))
  main = join(tmp, 'main')
  worktree = join(tmp, 'wt')
  home = join(tmp, 'home')
  mkdirSync(main)
  mkdirSync(home)
  git(main, 'init', '-q', '-b', 'main')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  git(main, 'remote', 'add', 'origin', 'git@github.com:LunetteOrg/demo.git')
  git(main, 'worktree', 'add', '-q', '--detach', worktree)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('finding the operator profile', () => {
  test("from a linked worktree, reads the main checkout's .agents/local/", () => {
    const path = write(join(main, '.agents/local/operator.jsonc'), '{ "handle": "ada" // me\n}')
    const { profile, sources } = loadOperator(worktree, { home })
    assert.equal(profile.handle, 'ada')
    assert.deepEqual(sources, [path])
  })

  test('the project profile wins over the global one, key by key', () => {
    const global = write(
      join(home, '.agents/operator.yml'),
      'language: en\nrole: developer\naccounts:\n  github: ada\n',
    )
    const project = write(
      join(main, '.agents/local/operator.jsonc'),
      '{ "role": "product", "accounts": { "google": "ada@example.org" } }',
    )
    const { profile, sources } = loadOperator(worktree, { home })
    assert.deepEqual(profile, {
      language: 'en',
      role: 'product',
      accounts: { github: 'ada', google: 'ada@example.org' },
    })
    assert.deepEqual(sources, [global, project])
  })

  test('without a main-checkout file, falls back to ~/.agents/projects/<org>/<repo>/', () => {
    const path = write(join(home, '.agents/projects/LunetteOrg/demo/operator.yml'), 'handle: ada\n')
    const { profile, sources } = loadOperator(worktree, { home })
    assert.equal(profile.handle, 'ada')
    assert.deepEqual(sources, [path])
  })

  test('with no profile at all, the speaker is a developer', () => {
    assert.deepEqual(loadOperator(worktree, { home }), { profile: { role: 'developer' }, sources: [] })
  })

  test('outside a git repository, only the global profile counts', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    write(join(home, '.agents/operator.yml'), 'handle: ada\n')
    assert.equal(loadOperator(outside, { home }).profile.handle, 'ada')
  })

  test('refuses both formats in one place, and a profile the schema rejects', () => {
    write(join(main, '.agents/local/operator.jsonc'), '{}')
    write(join(main, '.agents/local/operator.yml'), '{}')
    assert.throws(() => loadOperator(worktree, { home }), /keep one/)
    rmSync(join(main, '.agents/local/operator.yml'))
    write(join(main, '.agents/local/operator.jsonc'), '{ "confidence": { "git": { "level": 9 } } }')
    assert.throws(
      () => loadOperator(worktree, { home }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError)
        assert.match(e.message, /operator\.jsonc/)
        assert.match(e.message, /\/confidence\/git\/level/)
        return true
      },
    )
  })
})

describe('the command line', () => {
  test('operator prints the merged profile, operator get one key', () => {
    write(join(home, '.agents/operator.yml'), 'language: it\n')
    write(join(main, '.agents/local/operator.jsonc'), '{ "handle": "ada" }')
    const env = { ...process.env, HOME: home }
    const all = JSON.parse(execFileSync('node', [BIN, 'operator'], { cwd: worktree, env, encoding: 'utf8' }))
    assert.deepEqual(all, { language: 'it', handle: 'ada' })
    const one = execFileSync('node', [BIN, 'operator', 'get', 'handle'], { cwd: worktree, env, encoding: 'utf8' })
    assert.equal(JSON.parse(one), 'ada')
  })
})
