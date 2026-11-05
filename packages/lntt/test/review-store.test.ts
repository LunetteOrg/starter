import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { branchesIn, branchKey, keyBranch, move, resolvePlace } from '../src/review-store.ts'

let dir: string

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-store-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const exdev = () => {
  throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
}

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

describe('moving a file to the place', () => {
  const files = () => {
    const from = join(dir, 'old.json')
    const to = join(dir, 'place', 'new.json')
    mkdirSync(join(dir, 'place'))
    writeFileSync(from, '{"branch":"x"}')
    return { from, to }
  }

  test('renames when it can', () => {
    const { from, to } = files()
    move(from, to)
    assert.equal(readFileSync(to, 'utf8'), '{"branch":"x"}')
    assert.equal(existsSync(from), false)
  })

  test('across filesystems copies beside the destination, renames it in place and removes the source', () => {
    const { from, to } = files()
    move(from, to, exdev)
    assert.equal(readFileSync(to, 'utf8'), '{"branch":"x"}')
    assert.equal(existsSync(from), false, 'the source is gone, so it is not read again')
    assert.deepEqual(readdirSync(join(dir, 'place')), ['new.json'], 'no partial file is left')
  })

  test('any other failure is the caller’s', () => {
    const { from, to } = files()
    const denied = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }
    assert.throws(() => move(from, to, denied), /permission denied/)
    assert.equal(existsSync(from), true, 'the source stays')
    assert.equal(existsSync(to), false)
  })
})

describe('the place', () => {
  const input = { common: '/repo/.git', main: '/repo', operator: undefined, project: undefined, home: '/home/me' }

  test('an origin segment of . or .. leaves no way out of the place', () => {
    for (const slug of ['../proj', './proj', 'org/..', 'org/.']) {
      const { dir: placed } = resolvePlace({ ...input, slug, project: '/store' })
      assert.match(placed, /^\/store\/local\/[0-9a-f]{12}$/, slug)
    }
    assert.equal(resolvePlace({ ...input, slug: 'org/proj', project: '/store' }).dir, '/store/org/proj')
  })
})
