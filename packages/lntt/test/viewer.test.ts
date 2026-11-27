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

// The main paths of lntt viewer through the CLI, on real processes and the real PATH: Orca's goto,
// a detached Playwright, an agent's call. The choice and the openings: src/viewer.spec.ts,
// src/local/command.spec.ts.
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

  test('viewer detect reports the host, the choice and why', () => {
    stub('orca')
    const out = JSON.parse(run(['viewer', 'detect'], { TERM_PROGRAM: 'Orca' }).stdout)
    assert.equal(out.host, 'orca')
    assert.equal(out.viewer, 'orca')
    assert.equal(typeof out.reason, 'string')
  })
})
