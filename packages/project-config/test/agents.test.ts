import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkAgentsBlock, managedBlock, syncAgentsBlock } from '../src/index.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt-config.ts')

let root: string
let agents: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-agents-')))
  mkdirSync(join(root, '.agents'))
  writeFileSync(join(root, '.agents/config.jsonc'), '{}')
  agents = join(root, 'AGENTS.md')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the managed block', () => {
  test('is wrapped in the lunette markers', () => {
    const block = managedBlock()
    assert.match(block, /^<!-- lunette:start/)
    assert.match(block, /<!-- lunette:end -->\n$/)
  })

  test('sync creates AGENTS.md with the block when there is none', () => {
    syncAgentsBlock(root)
    assert.equal(readFileSync(agents, 'utf8'), managedBlock())
  })

  test('sync puts the block on top of an AGENTS.md that has none, keeping its text', () => {
    writeFileSync(agents, '# My project\n\nOur own rule.\n')
    syncAgentsBlock(root)
    assert.equal(readFileSync(agents, 'utf8'), `${managedBlock()}\n# My project\n\nOur own rule.\n`)
  })

  test('sync replaces only what is between the markers', () => {
    writeFileSync(agents, '<!-- lunette:start -->\nold rules\n<!-- lunette:end -->\n\n# Mine\n\nKeep me.\n')
    syncAgentsBlock(root)
    assert.equal(readFileSync(agents, 'utf8'), `${managedBlock()}\n# Mine\n\nKeep me.\n`)
  })

  test('check passes after sync and fails on a hand edit inside the block', () => {
    syncAgentsBlock(root)
    assert.equal(checkAgentsBlock(root), true)
    writeFileSync(agents, readFileSync(agents, 'utf8').replace('Give criteria', 'Give options'))
    assert.equal(checkAgentsBlock(root), false)
  })

  test('check fails when AGENTS.md or the block is missing', () => {
    assert.equal(checkAgentsBlock(root), false)
    writeFileSync(agents, '# Mine\n')
    assert.equal(checkAgentsBlock(root), false)
  })
})

describe('the command line', () => {
  test('agents sync then agents check', () => {
    assert.equal(spawnSync('node', [BIN, 'agents', 'check'], { cwd: root }).status, 1)
    assert.equal(spawnSync('node', [BIN, 'agents', 'sync'], { cwd: root }).status, 0)
    assert.equal(spawnSync('node', [BIN, 'agents', 'check'], { cwd: root }).status, 0)
  })
})
