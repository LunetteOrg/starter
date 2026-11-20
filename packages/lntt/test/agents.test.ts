import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The main path of the managed block through the CLI, from the package's own agents/block.md; what
// it writes and when it is held: src/agents.spec.ts, src/sync/project.spec.ts.

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-agents-')))
  mkdirSync(join(root, '.agents'))
  writeFileSync(join(root, '.agents/config.jsonc'), '{}')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the command line', () => {
  test('sync writes the block from the package, then check passes', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Ours\n')
    assert.equal(spawnSync('node', [BIN, 'check', 'agents-md'], { cwd: root }).status, 1)
    assert.equal(spawnSync('node', [BIN, 'sync'], { cwd: root }).status, 0)
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    assert.ok(text.includes(readFileSync(resolve(HERE, '../agents/block.md'), 'utf8').trimEnd()), text)
    assert.ok(text.endsWith('\n# Ours\n'), text)
    assert.equal(spawnSync('node', [BIN, 'check'], { cwd: root }).status, 0)
  })
})
