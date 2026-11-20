import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BROWSER_OPERATIONS } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let main: string
let stubs: string
let home: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function writeApps(apps: Record<string, unknown>): void {
  writeFileSync(join(main, '.agents/config.jsonc'), JSON.stringify({ local: { apps } }))
}

const web = { port: 5173, url: 'http://localhost:{port}', commands: { start: { run: 'pnpm dev --port {port}' } } }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-browser-')))
  main = join(tmp, 'main')
  stubs = join(tmp, 'bin')
  home = join(tmp, 'home')
  mkdirSync(stubs)
  mkdirSync(home)
  mkdirSync(join(main, '.agents'), { recursive: true })
  writeApps({ web })
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'add', '.')
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function stub(name: string): void {
  writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n')
  chmodSync(join(stubs, name), 0o755)
}

// The main paths of lntt browser through the CLI, on a real worktree and PATH; the drivers and the
// plans: src/browser.spec.ts, src/local/command.spec.ts.
describe('the command line', () => {
  const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync('node', [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, ...env },
    })

  function worktree(name: string): string {
    const path = join(tmp, name)
    git(main, 'worktree', 'add', '-q', '--detach', path)
    return path
  }

  test('--json in an Orca worktree: the orca driver, on the worktree port and browser', () => {
    stub('orca')
    const a = worktree('a')
    const result = run(a, ['browser', 'web', '--json'], { TERM_PROGRAM: 'Orca' })
    assert.equal(result.status, 0, result.stderr)
    const plan = JSON.parse(result.stdout)
    assert.deepEqual(
      [plan.host, plan.driver, plan.app, plan.url, plan.kind],
      ['orca', 'orca', 'web', 'http://localhost:5183', 'shell'],
    )
    assert.equal(plan.operations.open.command, `orca goto --url http://localhost:5183 --worktree path:${a} --json`)
  })

  test('the default is a document an agent can follow: driver, why, URL, one line per operation', () => {
    const result = run(main, ['browser'])
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout.split('\n')
    assert.match(lines[0] ?? '', /playwright.*terminal.*http:\/\/localhost:5173/)
    const ops = lines.map((l) => l.split(/\s+/)[0])
    for (const op of ['setup', ...BROWSER_OPERATIONS]) assert.ok(ops.includes(op), `${op} in\n${result.stdout}`)
    assert.ok(lines.some((l) => /^open\s+PLAYWRIGHT_MCP_OUTPUT_DIR=.* goto http:\/\/localhost:5173$/.test(l)))
    assert.ok(lines.some((l) => l.includes(`such as e3`) && l.endsWith(`write a ' in them as '\\''.`)))
  })

  test('the operator preference is read from workspace.browsers', () => {
    mkdirSync(join(home, '.agents'))
    writeFileSync(join(home, '.agents/operator.jsonc'), JSON.stringify({ workspace: { browsers: ['chrome'] } }))
    const plan = JSON.parse(run(main, ['browser', '--json']).stdout)
    assert.equal(plan.driver, 'chrome')
    assert.match(plan.reason, /assumed, no shell can tell whether this session has its tools$/)
  })

  test('--json before the app name', () => {
    writeApps({ web, admin: { ...web, port: 5174 } })
    const result = run(main, ['browser', '--json', 'web'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).app, 'web')
  })

  test('an unknown app exits 1, naming the known ones; --query prints a part of the plan', () => {
    const unknown = run(main, ['browser', 'nope'])
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /^lntt: no app nope in local\.apps \(web\)$/m)
    const query = run(main, ['browser', '--query', '.url'])
    assert.equal(query.status, 0, query.stderr)
    assert.equal(query.stdout, 'http://localhost:5173\n')
  })

  test('more than one app, or an unknown flag, is a usage error', () => {
    for (const args of [['web', 'admin'], ['--json', 'web', 'admin'], ['web', '--json', 'x'], ['-x']]) {
      assert.equal(run(main, ['browser', ...args]).status, 2, args.join(' '))
    }
  })
})
