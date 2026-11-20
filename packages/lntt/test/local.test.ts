import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The main path of lntt local app through the CLI, on real worktrees: git lists them and the slots
// live in the common directory. The resolution and the slots: src/local.spec.ts,
// src/local/command.spec.ts.

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let main: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function worktree(name: string): string {
  const path = join(tmp, name)
  git(main, 'worktree', 'add', '-q', '--detach', path)
  return path
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-local-')))
  main = join(tmp, 'main')
  mkdirSync(join(main, '.agents'), { recursive: true })
  writeFileSync(
    join(main, '.agents/config.jsonc'),
    JSON.stringify({
      local: {
        apps: {
          web: {
            port: 5173,
            url: 'http://localhost:{port}',
            commands: { start: { run: 'pnpm dev --port {port}' } },
            env: { APP_ORIGIN: 'http://localhost:{port}' },
          },
        },
      },
    }),
  )
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const app = (cwd: string) => JSON.parse(execFileSync('node', [BIN, 'local', 'app', 'web'], { cwd, encoding: 'utf8' }))

describe('the command line', () => {
  test('local app prints the app resolved for each worktree, its slot stable and freed when it goes', () => {
    assert.equal(app(main).url, 'http://localhost:5173')
    const a = worktree('a')
    const b = worktree('b')
    const first = app(a)
    assert.equal(first.url, 'http://localhost:5183')
    assert.equal(first.env.APP_ORIGIN, 'http://localhost:5183')
    assert.equal(app(b).port, 5193)
    assert.equal(app(a).port, 5183)
    git(main, 'worktree', 'remove', '--force', a)
    assert.equal(app(worktree('c')).port, 5183)
  })
})
