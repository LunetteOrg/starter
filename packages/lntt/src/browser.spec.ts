import { assert, describe, it } from '@effect/vitest'
import { BROWSER_OPERATIONS, browserApp, browserPlan, chooseDriver, formatPlan } from './browser.ts'
import type { LocalApp } from './local.ts'

const has =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name)

describe('choosing the driver', () => {
  it('the first preferred browser usable in this session wins', () => {
    const choice = chooseDriver({
      env: { TERM_PROGRAM: 'Orca' },
      preferences: ['claude-desktop', 'orca'],
      has: has('orca'),
    })
    assert.deepStrictEqual([choice.host, choice.driver], ['orca', 'orca'])
    assert.match(choice.reason, /workspace\.browsers/)
  })

  it('Orca outside Orca is skipped: its browser belongs to a worktree', () => {
    assert.strictEqual(chooseDriver({ env: {}, preferences: ['orca', 'chrome'], has: has('orca') }).driver, 'chrome')
  })

  it('with no preference, the host the session runs in', () => {
    const orca = chooseDriver({ env: { ORCA_WORKTREE_ID: 'x' }, preferences: [], has: has('orca') })
    assert.deepStrictEqual([orca.driver, orca.reason], ['orca', 'the session runs in orca'])
    const desktop = chooseDriver({ env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, preferences: [], has: has() })
    assert.strictEqual(desktop.driver, 'claude-desktop')
  })

  it('Orca without its CLI, Wave, Herdr and a terminal fall to Playwright', () => {
    const orca = chooseDriver({ env: { TERM_PROGRAM: 'Orca' }, preferences: [], has: has() })
    assert.deepStrictEqual([orca.driver, orca.reason], ['playwright', 'orca is not on PATH; playwright through npx'])
    for (const env of [{ TERM_PROGRAM: 'waveterm' }, { HERDR_ENV: '1' }, {}]) {
      const choice = chooseDriver({ env, preferences: [], has: has('wsh') })
      assert.strictEqual(choice.driver, 'playwright')
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
  it('every driver covers the same operations, in order', () => {
    assert.deepStrictEqual(BROWSER_OPERATIONS, [
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
      assert.deepStrictEqual(Object.keys(plan.operations), [...BROWSER_OPERATIONS])
    }
  })

  it('orca: commands on the browser of this worktree, a tab and a capture first', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'orca', driver: 'orca', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.strictEqual(plan.kind, 'shell')
    assert.deepStrictEqual(
      plan.setup?.map((s) => ('command' in s ? s.command : '')),
      ['orca tab create --url about:blank --worktree path:/w --json', 'orca capture start --worktree path:/w --json'],
    )
    assert.deepStrictEqual(plan.operations.open, {
      command: 'orca goto --url http://localhost:5183 --worktree path:/w --json',
    })
    assert.strictEqual(
      (plan.operations.click as { command: string }).command,
      'orca click --element @<ref> --worktree path:/w --json',
    )
    assert.strictEqual(
      (plan.operations.screenshot as { command: string }).command,
      `orca exec --command 'screenshot "<file>"' --worktree path:/w --json`,
    )
    assert.strictEqual(
      (plan.operations.type as { command: string }).command,
      "orca fill --element @<ref> --value '<text>' --worktree path:/w --json",
    )
    assert.match((plan.operations.requests as { note: string }).note, />= 400/)
    assert.deepStrictEqual(plan.operations.close, {
      command: 'orca tab close --page <browserPageId> --worktree path:/w --json',
      note: 'browserPageId from tab create; then orca capture stop --worktree path:/w --json',
    })
  })

  it('playwright: an app name a shell would split becomes a safe session name', () => {
    const plan = browserPlan({
      app: app({ name: "my app/it's" }),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.deepStrictEqual(plan.operations.close, {
      command:
        'PLAYWRIGHT_MCP_OUTPUT_DIR=/t/lntt-my-app-it-s-5183 npx -y @playwright/cli@0.1.22 -s=lntt-my-app-it-s-5183 close',
    })
  })

  it('the quoting branch: a worktree path and a URL a shell would split', () => {
    const plan = browserPlan({
      app: app({ url: 'http://localhost:5183/?a=1&b=2' }),
      choice: { host: 'orca', driver: 'orca', reason: 'r' },
      worktree: "/w x's",
      tmp: '/t',
    })
    assert.deepStrictEqual(plan.operations.open, {
      command: `orca goto --url 'http://localhost:5183/?a=1&b=2' --worktree 'path:/w x'\\''s' --json`,
    })
  })

  it('playwright: one session per app and port, its output outside the worktree', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    const pw = 'PLAYWRIGHT_MCP_OUTPUT_DIR=/t/lntt-web-5183 npx -y @playwright/cli@0.1.22 -s=lntt-web-5183'
    assert.strictEqual(plan.kind, 'shell')
    assert.deepStrictEqual(plan.operations.open, { command: `${pw} goto http://localhost:5183` })
    assert.deepStrictEqual(plan.setup?.[0] && 'command' in plan.setup[0] && plan.setup[0].command, `${pw} open`)
    assert.deepStrictEqual(plan.operations.type, { command: `${pw} fill <ref> '<text>'` })
    assert.deepStrictEqual(
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

  it('playwright: an app with a sign-in test is told how to load its storage state', () => {
    const plan = browserPlan({
      app: app({ signIn: { test: 'apps/web/e2e/auth.setup.ts' } }),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.match(plan.setup?.[0]?.note ?? '', /state-load <file>.*auth\.setup\.ts/)
  })

  it('chrome: tool calls only the agent can make, loaded in one ToolSearch', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'orca', driver: 'chrome', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.strictEqual(plan.kind, 'agent')
    const [load] = plan.setup ?? []
    assert.isOk(load && 'call' in load)
    assert.strictEqual(load.call.tool, 'ToolSearch')
    assert.match(String(load.call.input.query), /^select:mcp__claude-in-chrome__tabs_context_mcp,/)
    assert.deepStrictEqual(
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
    assert.deepStrictEqual(calls, {
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

  it('claude-desktop: preview_start opens the page', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'claude-desktop', driver: 'claude-desktop', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    assert.strictEqual(plan.kind, 'agent')
    assert.deepStrictEqual(plan.operations.open, {
      call: { tool: 'mcp__Claude_Browser__preview_start', input: { url: 'http://localhost:5183' } },
    })
    assert.deepStrictEqual(
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
    assert.deepStrictEqual(plan.operations.close, { lacks: 'the pane keeps its tabs' })
    assert.match(formatPlan(plan), /^close {7}\(cannot: the pane keeps its tabs\)$/m)
  })
})

describe('the temporary directory', () => {
  it('a trailing slash of the temporary directory is not doubled in the output folder', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'terminal', driver: 'playwright', reason: 'r' },
      worktree: '/w',
      tmp: '/t/',
    })
    assert.match(JSON.stringify(plan.operations.open), /"command":"PLAYWRIGHT_MCP_OUTPUT_DIR=\/t\/lntt-web-5183 /)
  })
})

describe('the app to drive', () => {
  const web = { port: 5173, url: 'http://localhost:{port}', commands: {} }

  it('the one named, else the only one local.apps has; with several or none, the app must be named', () => {
    assert.strictEqual(browserApp({ local: { apps: { web, admin: web } } }, 'admin'), 'admin')
    assert.strictEqual(browserApp({ local: { apps: { web } } }), 'web')
    assert.throws(
      () => browserApp({ local: { apps: { web, admin: web } } }),
      /^name the app: pnpm exec lntt browser <app> \(local\.apps: web, admin\)$/,
    )
    assert.throws(() => browserApp({}), /\(local\.apps: none configured\)$/)
  })

  it('an agent driver is a document of tool calls, its placeholders JSON strings', () => {
    const plan = browserPlan({
      app: app(),
      choice: { host: 'claude-desktop', driver: 'claude-desktop', reason: 'r' },
      worktree: '/w',
      tmp: '/t',
    })
    const text = formatPlan(plan)
    assert.match(text, /tool call/)
    assert.match(text, /mcp__Claude_Browser__preview_start/)
    assert.match(text, /they are JSON strings\.$/m)
  })
})
