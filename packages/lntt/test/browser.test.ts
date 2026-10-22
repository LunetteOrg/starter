import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { BROWSER_OPERATIONS, browserPlan, chooseDriver, formatPlan, type LocalApp } from '../src/index.ts'

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

const has =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name)

function stub(name: string): void {
  writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n')
  chmodSync(join(stubs, name), 0o755)
}

describe('choosing the driver', () => {
  test('the first preferred browser usable in this session wins', () => {
    const choice = chooseDriver({
      env: { TERM_PROGRAM: 'Orca' },
      preferences: ['claude-desktop', 'orca'],
      has: has('orca'),
    })
    assert.deepEqual([choice.host, choice.driver], ['orca', 'orca'])
    assert.match(choice.reason, /workspace\.browsers/)
  })

  test('Orca outside Orca is skipped: its browser belongs to a worktree', () => {
    assert.equal(chooseDriver({ env: {}, preferences: ['orca', 'chrome'], has: has('orca') }).driver, 'chrome')
  })

  test('with no preference, the host the session runs in', () => {
    const orca = chooseDriver({ env: { ORCA_WORKTREE_ID: 'x' }, preferences: [], has: has('orca') })
    assert.deepEqual([orca.driver, orca.reason], ['orca', 'the session runs in orca'])
    const desktop = chooseDriver({ env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, preferences: [], has: has() })
    assert.equal(desktop.driver, 'claude-desktop')
  })

  test('Orca without its CLI, Wave, Herdr and a terminal fall to Playwright', () => {
    const orca = chooseDriver({ env: { TERM_PROGRAM: 'Orca' }, preferences: [], has: has() })
    assert.deepEqual([orca.driver, orca.reason], ['playwright', 'orca is not on PATH; playwright through npx'])
    for (const env of [{ TERM_PROGRAM: 'waveterm' }, { HERDR_ENV: '1' }, {}]) {
      const choice = chooseDriver({ env, preferences: [], has: has('wsh') })
      assert.equal(choice.driver, 'playwright')
      assert.match(choice.reason, /has no browser an agent can drive; playwright through npx$/)
    }
  })
})

const app = (extra: Partial<LocalApp> = {}): LocalApp => ({
  name: 'web',
  port: 5183,
  url: 'http://localhost:5183',
  readyPath: '/',
  commands: {},
  ...extra,
})

describe('the plan for each driver', () => {
  test('every driver covers the same operations, in order', () => {
    assert.deepEqual(BROWSER_OPERATIONS, [
      'open',
      'read',
      'click',
      'type',
      'screenshot',
      'console',
      'requests',
      'close',
    ])
    for (const driver of ['orca', 'playwright', 'chrome', 'claude-desktop'] as const) {
      const plan = browserPlan({
        app: app(),
        choice: { host: 'terminal', driver, reason: 'r' },
        worktree: '/w',
        tmp: '/t',
      })
      assert.deepEqual(Object.keys(plan.operations), BROWSER_OPERATIONS)
    }
  })

  test('orca: commands on the browser of this worktree, a tab and a capture first', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'orca', driver: 'orca', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.equal(plan.kind, 'shell')
    assert.deepEqual(
      plan.setup?.map((s) => ('command' in s ? s.command : '')),
      ['orca tab create --url about:blank --worktree path:/w --json', 'orca capture start --worktree path:/w --json'],
    )
    assert.deepEqual(plan.operations.open, {
      command: 'orca goto --url http://localhost:5183 --worktree path:/w --json',
    })
    assert.equal(
      (plan.operations.click as { command: string }).command,
      'orca click --element @<ref> --worktree path:/w --json',
    )
    assert.equal(
      (plan.operations.screenshot as { command: string }).command,
      `orca exec --command "screenshot '<file>'" --worktree path:/w --json`,
    )
    assert.equal(
      (plan.operations.type as { command: string }).command,
      "orca fill --element @<ref> --value '<text>' --worktree path:/w --json",
    )
    assert.match((plan.operations.requests as { note: string }).note, />= 400/)
    assert.deepEqual(plan.operations.close, {
      command: 'orca tab close --page <browserPageId> --worktree path:/w --json',
      note: 'browserPageId from tab create; then orca capture stop --worktree path:/w --json',
    })
  })

  test('playwright: an app name a shell would split becomes a safe session name', () => {
    const plan = browserPlan({
      app: app({ name: "my app/it's" }),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.deepEqual(plan.operations.close, {
      command:
        'PLAYWRIGHT_MCP_OUTPUT_DIR=/t/lntt-my-app-it-s-5183 npx -y @playwright/cli@0.1.22 -s=lntt-my-app-it-s-5183 close',
    })
  })

  test('the quoting branch: a worktree path and a URL a shell would split', () => {
    const plan = browserPlan({
      app: app({ url: 'http://localhost:5183/?a=1&b=2' }),
      choice: { host: 'orca', driver: 'orca', reason: 'r' },
      worktree: "/w x's",
      tmp: '/t',
    })
    assert.deepEqual(plan.operations.open, {
      command: `orca goto --url 'http://localhost:5183/?a=1&b=2' --worktree 'path:/w x'\\''s' --json`,
    })
  })

  test('playwright: one session per app and port, its output outside the worktree', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    const pw = 'PLAYWRIGHT_MCP_OUTPUT_DIR=/t/lntt-web-5183 npx -y @playwright/cli@0.1.22 -s=lntt-web-5183'
    assert.equal(plan.kind, 'shell')
    assert.deepEqual(plan.operations.open, { command: `${pw} goto http://localhost:5183` })
    assert.deepEqual(plan.setup?.[0] && 'command' in plan.setup[0] && plan.setup[0].command, `${pw} open`)
    assert.deepEqual(plan.operations.type, { command: `${pw} fill <ref> '<text>'` })
    assert.deepEqual(
      BROWSER_OPERATIONS.map((op) => {
        const step = plan.operations[op]
        return 'command' in step ? step.command.replace(`${pw} `, '') : null
      }),
      [
        'goto http://localhost:5183',
        'snapshot',
        'click <ref>',
        "fill <ref> '<text>'",
        "screenshot --filename='<file>'",
        'console error',
        'requests --static',
        'close',
      ],
    )
  })

  test('playwright: an app with a sign-in test is told how to load its storage state', () => {
    const plan = browserPlan({
      app: app({ signIn: { test: 'apps/web/e2e/auth.setup.ts' } }),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.match(plan.setup?.[0]?.note ?? '', /state-load <file>.*auth\.setup\.ts/)
  })

  test('chrome: tool calls only the agent can make, loaded in one ToolSearch', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'orca', driver: 'chrome', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.equal(plan.kind, 'agent')
    const [load] = plan.setup ?? []
    assert.ok(load && 'call' in load)
    assert.equal(load.call.tool, 'ToolSearch')
    assert.match(String(load.call.input.query), /^select:mcp__claude-in-chrome__tabs_context_mcp,/)
    assert.deepEqual(
      plan.setup?.slice(1).map((s) => ('call' in s ? [s.call.tool, s.call.input] : null)),
      [
        ['mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true }],
        ['mcp__claude-in-chrome__read_network_requests', { tabId: '<tabId>' }],
      ],
    )
    const calls = Object.fromEntries(
      BROWSER_OPERATIONS.map((op) => {
        const step = plan.operations[op]
        return [op, 'call' in step ? [step.call.tool.replace('mcp__claude-in-chrome__', ''), step.call.input] : null]
      }),
    )
    const tab = { tabId: '<tabId>' }
    assert.deepEqual(calls, {
      open: ['navigate', { url: 'http://localhost:5183', ...tab }],
      read: ['read_page', { filter: 'all', ...tab }],
      click: ['computer', { action: 'left_click', ref: '<ref>', ...tab }],
      type: ['form_input', { ref: '<ref>', value: '<text>', ...tab }],
      screenshot: ['computer', { action: 'screenshot', save_to_disk: true, ...tab }],
      console: ['read_console_messages', { onlyErrors: true, ...tab }],
      requests: ['read_network_requests', tab],
      close: ['tabs_close_mcp', tab],
    })
  })

  test('claude-desktop: preview_start opens the page', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'claude-desktop', driver: 'claude-desktop', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.equal(plan.kind, 'agent')
    assert.deepEqual(plan.operations.open, {
      call: { tool: 'mcp__Claude_Browser__preview_start', input: { url: 'http://localhost:5183' } },
    })
    assert.deepEqual(
      BROWSER_OPERATIONS.filter((op) => op !== 'close').map((op) => {
        const step = plan.operations[op]
        return 'call' in step ? [step.call.tool.replace('mcp__Claude_Browser__', ''), step.call.input] : null
      }),
      [
        ['preview_start', { url: 'http://localhost:5183' }],
        ['read_page', {}],
        ['computer', { action: 'left_click', ref: '<ref>' }],
        ['form_input', { ref: '<ref>', value: '<text>' }],
        ['computer', { action: 'screenshot' }],
        ['read_console_messages', { onlyErrors: true }],
        ['read_network_requests', {}],
      ],
    )
    assert.deepEqual(plan.operations.close, { lacks: 'the pane keeps its tabs' })
    assert.match(formatPlan(plan), /^close {7}\(cannot: the pane keeps its tabs\)$/m)
  })
})

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
  })

  test('agent drivers are described, never a stop: exit 0', () => {
    const result = run(main, ['browser', 'web'], { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /tool call/)
    assert.match(result.stdout, /mcp__Claude_Browser__preview_start/)
  })

  test('the operator preference is read from workspace.browsers', () => {
    mkdirSync(join(home, '.agents'))
    writeFileSync(join(home, '.agents/operator.jsonc'), JSON.stringify({ workspace: { browsers: ['chrome'] } }))
    const plan = JSON.parse(run(main, ['browser', '--json']).stdout)
    assert.equal(plan.driver, 'chrome')
    assert.match(plan.reason, /assumed, no shell can tell whether this session has its tools$/)
  })

  test('with several apps the app must be named, and the error lists them', () => {
    writeApps({ web, admin: { ...web, port: 5174 } })
    const result = run(main, ['browser'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /web, admin/)
  })

  test('--json before the app name', () => {
    writeApps({ web, admin: { ...web, port: 5174 } })
    const result = run(main, ['browser', '--json', 'web'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).app, 'web')
  })

  test('an unknown app is a configuration error naming the known ones', () => {
    const result = run(main, ['browser', 'nope'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /no app nope in local\.apps \(web\)/)
  })

  test('more than one app, or an unknown flag, is a usage error', () => {
    for (const args of [['web', 'admin'], ['--json', 'web', 'admin'], ['web', '--json', 'x'], ['-x']]) {
      assert.equal(run(main, ['browser', ...args]).status, 2, args.join(' '))
    }
  })
})
