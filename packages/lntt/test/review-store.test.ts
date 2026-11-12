import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { branchesIn, branchKey, keyBranch } from '../src/review-store.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-store-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a branch name as a file name', () => {
  test('is percent-encoded, a capital as % and its lower-case hexadecimal code', () => {
    assert.equal(branchKey('feat/1/x'), 'feat%2F1%2Fx')
    assert.equal(branchKey('Fix/A'), '%46ix%2F%41')
    assert.equal(branchKey('J'), '%4a')
    assert.equal(branchKey('release/1.2_é'), 'release%2F1.2_%C3%A9')
  })

  test('reads back, and a name that is not valid percent-encoding is no branch', () => {
    for (const branch of ['feat/1/x', 'Fix/A', 'release/1.2_é', '100%']) {
      assert.equal(keyBranch(branchKey(branch)), branch)
    }
    assert.equal(keyBranch('%E0'), null)
  })

  test('is the only name of the branch: another encoding of it names no branch', () => {
    mkdirSync(join(dir, 'state'))
    for (const name of ['feat%2F1%2Fx', 'Fix%2FA', '%4A', 'a%2fb', '%E0'])
      writeFileSync(join(dir, 'state', `${name}.json`), '{}')
    mkdirSync(join(dir, 'ledger'))
    writeFileSync(join(dir, 'ledger', 'feat%2F1%2Fx.json'), '{}')
    assert.deepEqual(branchesIn(dir), ['feat/1/x'])
  })
})
