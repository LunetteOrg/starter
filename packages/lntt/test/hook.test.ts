import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-hook-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const lntt = (...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', input: '' })

// The typecheck is the pre-commit's alone (docs/adr/agent-layer.md). The Stop line a sync of
// 0.6.4 wrote still runs `lntt hook typecheck` until the project syncs again; for one release
// the command answers it with what to do, where a usage error would have the line say to
// upgrade an lntt that is already current.
describe('lntt hook typecheck, removed in 0.6.5', () => {
  test('exits 0 and tells the agent what to do, as a systemMessage', () => {
    const r = lntt('hook', 'typecheck')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stderr, '')
    assert.equal(
      JSON.parse(r.stdout).systemMessage,
      "lntt hook typecheck was removed in 0.6.5: run pnpm exec lntt sync, the typecheck is the pre-commit's",
    )
  })
})

describe('lntt hook usage', () => {
  for (const args of [['hook', 'typecheck', 'extra'], ['hook', 'format'], ['hook', 'lint'], ['hook']]) {
    test(`lntt ${args.join(' ')} is a usage error, exit 2`, () => {
      const r = lntt(...args)
      assert.equal(r.status, 2)
      assert.match(r.stderr, /usage: lntt hook/)
    })
  }

  // What an lntt older than `hook` does with it.
  test('a command lntt does not know is a usage error, exit 2', () => {
    assert.equal(lntt('frobnicate', 'typecheck').status, 2)
  })
})
