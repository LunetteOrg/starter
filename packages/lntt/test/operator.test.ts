import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

// The lookup of the profile is specified in src/config/load.spec.ts; here, the command line on a
// real git clone.
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
