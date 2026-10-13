import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { localApp } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt-config.ts')

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

describe('ports per worktree', () => {
  test('the main checkout gets the base port, with {port} filled in everywhere', () => {
    assert.deepEqual(localApp(main, 'web'), {
      name: 'web',
      port: 5173,
      url: 'http://localhost:5173',
      readyPath: '/',
      commands: { start: { run: 'pnpm dev --port 5173' } },
      env: { APP_ORIGIN: 'http://localhost:5173' },
    })
  })

  test('each linked worktree gets its own slot, stable across calls', () => {
    const a = worktree('a')
    const b = worktree('b')
    assert.equal(localApp(a, 'web').port, 5183)
    assert.equal(localApp(b, 'web').port, 5193)
    assert.equal(localApp(a, 'web').port, 5183)
    assert.equal(localApp(main, 'web').port, 5173)
  })

  test('a removed worktree frees its slot for the next one', () => {
    const a = worktree('a')
    assert.equal(localApp(a, 'web').port, 5183)
    git(main, 'worktree', 'remove', '--force', a)
    const c = worktree('c')
    assert.equal(localApp(c, 'web').port, 5183)
  })

  test('an unknown app names the ones that exist', () => {
    assert.throws(() => localApp(main, 'admin'), /admin.*web/)
  })
})

describe('the command line', () => {
  test('local app prints the resolved app as JSON', () => {
    const a = worktree('a')
    const out = JSON.parse(execFileSync('node', [BIN, 'local', 'app', 'web'], { cwd: a, encoding: 'utf8' }))
    assert.equal(out.url, 'http://localhost:5183')
    assert.equal(out.env.APP_ORIGIN, 'http://localhost:5183')
  })
})
