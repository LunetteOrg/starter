import { assert, describe, it } from '@effect/vitest'
import { agentAction, chooseViewer, detectHost, noTab, openingOf, viewerCommands } from './viewer.ts'

const has =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name)

describe('detecting where the session runs', () => {
  it('Orca, Wave, Herdr, Claude desktop, or a plain terminal', () => {
    assert.strictEqual(detectHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x' }), 'orca')
    assert.strictEqual(detectHost({ TERM_PROGRAM: 'waveterm' }), 'wave')
    assert.strictEqual(detectHost({ WAVETERM_BLOCKID: 'b' }), 'wave')
    assert.strictEqual(detectHost({ HERDR_ENV: '1' }), 'herdr')
    assert.strictEqual(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'claude-desktop')
    assert.strictEqual(detectHost({ TERM_PROGRAM: 'Apple_Terminal' }), 'terminal')
  })

  it('Herdr inside Orca or Wave is Herdr: its panes inherit the variables of the terminal that started it', () => {
    // As observed in a pane of herdr 0.9.3 whose server was started with ORCA_* and WAVETERM_* set.
    const pane = { TERM_PROGRAM: 'herdr', HERDR_ENV: '1', ORCA_WORKTREE_ID: 'x', WAVETERM_BLOCKID: 'b' }
    assert.strictEqual(detectHost(pane), 'herdr')
    assert.strictEqual(detectHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x', HERDR_ENV: '1' }), 'herdr')
  })

  it('Claude desktop by the entrypoints Claude Code itself counts as desktop', () => {
    for (const entrypoint of ['claude-desktop', 'claude-desktop-3p', 'local-agent'])
      assert.strictEqual(detectHost({ CLAUDE_CODE_ENTRYPOINT: entrypoint }), 'claude-desktop', entrypoint)
    for (const entrypoint of ['cli', 'claude-vscode', 'sdk-ts'])
      assert.strictEqual(detectHost({ CLAUDE_CODE_ENTRYPOINT: entrypoint }), 'terminal', entrypoint)
    // The app sets it on the claude it starts, whatever the variables it inherited.
    assert.strictEqual(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HERDR_ENV: '1' }), 'claude-desktop')
  })
})

describe('choosing the viewer', () => {
  it('the first preference available in this session wins', () => {
    const env = { TERM_PROGRAM: 'Orca' }
    const choice = chooseViewer({
      env,
      preferences: ['wave', 'orca', 'browser'],
      platform: 'darwin',
      has: has('orca', 'open', 'xdg-open'),
    })
    assert.strictEqual(choice.viewer, 'orca')
    assert.match(choice.reason, /preference/)
  })

  it('a preference that is not available here is skipped: Orca outside Orca', () => {
    const choice = chooseViewer({
      env: {},
      preferences: ['orca', 'browser'],
      platform: 'darwin',
      has: has('orca', 'open', 'xdg-open'),
    })
    assert.strictEqual(choice.viewer, 'browser')
  })

  it('with no preference, the host the session runs in', () => {
    assert.strictEqual(
      chooseViewer({ env: { TERM_PROGRAM: 'Orca' }, preferences: [], platform: 'darwin', has: has('orca') }).viewer,
      'orca',
    )
  })

  it('Claude desktop and Chrome are agent actions: the script names the call, it cannot make it', () => {
    const desktop = chooseViewer({
      env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      preferences: [],
      platform: 'darwin',
      has: has(),
    })
    assert.deepStrictEqual([desktop.viewer, desktop.agentCall], ['claude-desktop', 'preview_start'])
    const chrome = chooseViewer({ env: {}, preferences: ['chrome'], platform: 'darwin', has: has('open', 'xdg-open') })
    assert.deepStrictEqual([chrome.viewer, chrome.agentCall], ['chrome', 'navigate'])
  })

  it('Playwright opens with its CLI when on PATH, else through its MCP: an agent call', () => {
    const cli = chooseViewer({ env: {}, preferences: ['playwright'], platform: 'darwin', has: has('playwright') })
    assert.deepStrictEqual([cli.viewer, cli.agentCall], ['playwright', undefined])
    const mcp = chooseViewer({
      env: {},
      preferences: ['playwright', 'browser'],
      platform: 'darwin',
      has: has('open', 'xdg-open'),
    })
    assert.deepStrictEqual([mcp.viewer, mcp.agentCall], ['playwright', 'browser_navigate'])
  })

  it('nothing at all: no viewer, curl only', () => {
    assert.strictEqual(chooseViewer({ env: {}, preferences: [], platform: 'darwin', has: has() }).viewer, 'none')
  })
})

describe('opening the page', () => {
  const choose = (
    env: Record<string, string>,
    preferences: Parameters<typeof chooseViewer>[0]['preferences'],
    on: string[],
    platform = 'darwin',
  ) => chooseViewer({ env, preferences, has: has(...on), platform })

  it('in Orca: goto in the browser of this worktree, and a tab on the page when it has none', () => {
    const opening = openingOf(choose({ TERM_PROGRAM: 'Orca' }, [], ['orca']), 'http://localhost:5183/', '/w', 'darwin')
    assert.deepStrictEqual(opening, {
      kind: 'orca',
      goto: ['goto', '--url', 'http://localhost:5183/', '--worktree', 'path:/w', '--json'],
      tab: ['tab', 'create', '--url', 'http://localhost:5183/', '--worktree', 'path:/w', '--json'],
    })
    assert.isTrue(noTab('{"ok":false,"error":{"code":"browser_no_tab"}}'))
    assert.isFalse(noTab('{"ok":false,"error":{"code":"runtime_unavailable"}}'))
  })

  it('Wave runs its command to the end; Playwright and the system browser start detached', () => {
    assert.deepStrictEqual(openingOf(choose({ TERM_PROGRAM: 'waveterm' }, [], ['wsh']), 'u', '/w', 'darwin'), {
      kind: 'run',
      command: 'wsh',
      args: ['web', 'open', 'u'],
    })
    assert.deepStrictEqual(openingOf(choose({}, ['playwright'], ['playwright']), 'u', '/w', 'darwin'), {
      kind: 'detached',
      command: 'playwright',
      args: ['open', 'u'],
    })
    assert.deepStrictEqual(openingOf(choose({}, [], ['xdg-open'], 'linux'), 'u', '/w', 'linux'), {
      kind: 'detached',
      command: 'xdg-open',
      args: ['u'],
    })
    assert.deepStrictEqual(viewerCommands('linux'), ['orca', 'wsh', 'playwright', 'xdg-open'])
  })

  it('an agent action, or no viewer, is not opened: the agent’s call is printed with the page', () => {
    const desktop = choose({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, [], [])
    assert.strictEqual(openingOf(desktop, 'u', '/w', 'darwin'), null)
    assert.deepStrictEqual(agentAction(desktop, 'u'), { viewer: 'claude-desktop', call: 'preview_start', url: 'u' })
    const none = choose({}, [], [])
    assert.strictEqual(openingOf(none, 'u', '/w', 'darwin'), null)
    assert.deepStrictEqual(agentAction(none, 'u'), { viewer: 'none', url: 'u' })
  })
})
