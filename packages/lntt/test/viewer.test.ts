import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chooseViewer, detectHost } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

let tmp: string
let stubs: string
let repo: string
let home: string

// A fake CLI that records its arguments, so `open` can be checked without a real app.
function stub(name: string): string {
  const log = join(tmp, `${name}.log`)
  writeFileSync(join(stubs, name), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`)
  chmodSync(join(stubs, name), 0o755)
  return log
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-viewer-')))
  stubs = join(tmp, 'bin')
  repo = join(tmp, 'repo')
  home = join(tmp, 'home')
  mkdirSync(stubs)
  mkdirSync(home)
  mkdirSync(join(repo, '.agents'), { recursive: true })
  writeFileSync(join(repo, '.agents/config.jsonc'), '{}')
  execFileSync('git', ['init', '-q'], { cwd: repo })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const has =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name)

describe('detecting where the session runs', () => {
  test('Orca, Wave, Herdr, Claude desktop, or a plain terminal', () => {
    assert.equal(detectHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x' }), 'orca')
    assert.equal(detectHost({ TERM_PROGRAM: 'waveterm' }), 'wave')
    assert.equal(detectHost({ WAVETERM_BLOCKID: 'b' }), 'wave')
    assert.equal(detectHost({ HERDR_ENV: '1' }), 'herdr')
    assert.equal(detectHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'claude-desktop')
    assert.equal(detectHost({ TERM_PROGRAM: 'Apple_Terminal' }), 'terminal')
  })

  test('Herdr inside Orca or Wave is Herdr: its panes inherit the variables of the terminal that started it', () => {
    // As observed in a pane of herdr 0.9.3 whose server was started with ORCA_* and WAVETERM_* set.
    const pane = { TERM_PROGRAM: 'herdr', HERDR_ENV: '1', ORCA_WORKTREE_ID: 'x', WAVETERM_BLOCKID: 'b' }
    assert.equal(detectHost(pane), 'herdr')
    assert.equal(detectHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x', HERDR_ENV: '1' }), 'herdr')
  })

  test('Claude desktop by the entrypoints Claude Code itself counts as desktop', () => {
    for (const entrypoint of ['claude-desktop', 'claude-desktop-3p', 'local-agent'])
      assert.equal(detectHost({ CLAUDE_CODE_ENTRYPOINT: entrypoint }), 'claude-desktop', entrypoint)
    for (const entrypoint of ['cli', 'claude-vscode', 'sdk-ts'])
      assert.equal(detectHost({ CLAUDE_CODE_ENTRYPOINT: entrypoint }), 'terminal', entrypoint)
  })
})

describe('choosing the viewer', () => {
  test('the first preference available in this session wins', () => {
    const env = { TERM_PROGRAM: 'Orca' }
    const choice = chooseViewer({ env, preferences: ['wave', 'orca', 'browser'], has: has('orca', 'open', 'xdg-open') })
    assert.equal(choice.viewer, 'orca')
    assert.match(choice.reason, /preference/)
  })

  test('a preference that is not available here is skipped: Orca outside Orca', () => {
    const choice = chooseViewer({ env: {}, preferences: ['orca', 'browser'], has: has('orca', 'open', 'xdg-open') })
    assert.equal(choice.viewer, 'browser')
  })

  test('with no preference, the host the session runs in', () => {
    assert.equal(chooseViewer({ env: { TERM_PROGRAM: 'Orca' }, preferences: [], has: has('orca') }).viewer, 'orca')
  })

  test('Claude desktop and Chrome are agent actions: the script names the call, it cannot make it', () => {
    const desktop = chooseViewer({ env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, preferences: [], has: has() })
    assert.deepEqual([desktop.viewer, desktop.agentCall], ['claude-desktop', 'preview_start'])
    const chrome = chooseViewer({ env: {}, preferences: ['chrome'], has: has('open', 'xdg-open') })
    assert.deepEqual([chrome.viewer, chrome.agentCall], ['chrome', 'navigate'])
  })

  test('Playwright opens with its CLI when on PATH, else through its MCP: an agent call', () => {
    const cli = chooseViewer({ env: {}, preferences: ['playwright'], has: has('playwright') })
    assert.deepEqual([cli.viewer, cli.agentCall], ['playwright', undefined])
    const mcp = chooseViewer({ env: {}, preferences: ['playwright', 'browser'], has: has('open', 'xdg-open') })
    assert.deepEqual([mcp.viewer, mcp.agentCall], ['playwright', 'browser_navigate'])
  })

  test('nothing at all: no viewer, curl only', () => {
    assert.equal(chooseViewer({ env: {}, preferences: [], has: has() }).viewer, 'none')
  })
})

describe('the command line', () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync('node', [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, ...env },
    })

  test('viewer open in Orca opens the page in the browser of this worktree', () => {
    const log = stub('orca')
    const result = run(['viewer', 'open', 'http://localhost:5183/'], { TERM_PROGRAM: 'Orca' })
    assert.equal(result.status, 0)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'goto',
      '--url',
      'http://localhost:5183/',
      '--worktree',
      `path:${repo}`,
      '--json',
    ])
  })

  test('viewer open in Orca with no browser tab in the worktree opens one on the page', () => {
    const log = join(tmp, 'orca.log')
    writeFileSync(
      join(stubs, 'orca'),
      `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = goto ] && { echo '{"ok":false,"error":{"code":"browser_no_tab"}}'; exit 1; }\nexit 0\n`,
    )
    chmodSync(join(stubs, 'orca'), 0o755)
    const result = run(['viewer', 'open', 'http://localhost:5183/'], { TERM_PROGRAM: 'Orca' })
    assert.equal(result.status, 0)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      `goto --url http://localhost:5183/ --worktree path:${repo} --json`,
      `tab create --url http://localhost:5183/ --worktree path:${repo} --json`,
    ])
  })

  test('viewer open in Orca: another goto failure is reported, no tab is opened', () => {
    const log = join(tmp, 'orca.log')
    writeFileSync(
      join(stubs, 'orca'),
      `#!/bin/sh\necho "$*" >> "${log}"\necho '{"ok":false,"error":{"code":"runtime_unavailable"}}'\nexit 1\n`,
    )
    chmodSync(join(stubs, 'orca'), 0o755)
    const result = run(['viewer', 'open', 'http://localhost:5183/'], { TERM_PROGRAM: 'Orca' })
    assert.notEqual(result.status, 0)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      `goto --url http://localhost:5183/ --worktree path:${repo} --json`,
    ])
  })

  // A PATH with the stubs and links to sh, node and git only, so a Playwright installed
  // on this machine (next to node, with a global npm install) does not count.
  const onlyStubs = (): string => {
    const tools = join(tmp, 'tools')
    mkdirSync(tools)
    for (const name of ['sh', 'git'])
      symlinkSync(execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim(), join(tools, name))
    symlinkSync(process.execPath, join(tools, 'node'))
    return `${stubs}:${tools}`
  }
  const preferPlaywright = () => {
    mkdirSync(join(home, '.agents'))
    writeFileSync(join(home, '.agents/operator.jsonc'), '{"workspace":{"viewers":["playwright"]}}')
  }

  test('viewer open with the Playwright CLI on PATH opens the page with it', async () => {
    preferPlaywright()
    const log = stub('playwright')
    const result = run(['viewer', 'open', 'http://localhost:5173/'], { PATH: onlyStubs() })
    assert.equal(result.status, 0)
    // The CLI is started detached: wait for its log.
    for (let i = 0; i < 50 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['open', 'http://localhost:5173/'])
  })

  test('viewer open with Playwright and no CLI prints the MCP call and exits 3', () => {
    preferPlaywright()
    const result = run(['viewer', 'open', 'http://localhost:5173/'], { PATH: onlyStubs() })
    assert.equal(result.status, 3)
    assert.deepEqual(JSON.parse(result.stdout), {
      viewer: 'playwright',
      call: 'browser_navigate',
      url: 'http://localhost:5173/',
    })
  })

  test('viewer open for an agent action prints it and exits 3', () => {
    const result = run(['viewer', 'open', 'http://localhost:5173/'], { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })
    assert.equal(result.status, 3)
    assert.deepEqual(JSON.parse(result.stdout), {
      viewer: 'claude-desktop',
      call: 'preview_start',
      url: 'http://localhost:5173/',
    })
  })

  test('viewer detect reports the host, the choice and why', () => {
    stub('orca')
    const out = JSON.parse(run(['viewer', 'detect'], { TERM_PROGRAM: 'Orca' }).stdout)
    assert.equal(out.host, 'orca')
    assert.equal(out.viewer, 'orca')
    assert.equal(typeof out.reason, 'string')
  })
})
