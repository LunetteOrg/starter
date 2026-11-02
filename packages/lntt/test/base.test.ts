import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { type BaseLookup, candidateAt, resolveBase } from '../src/base.ts'
import { type Clone, clone } from './clone.ts'

const CANDIDATE = { base: 'main', prefix: 'candidate/' }

let tmp: string
let c: Clone

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-base-')))
  c = clone(tmp)
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const resolve = (over: Partial<BaseLookup>) =>
  resolveBase({ cwd: c.repo, candidate: CANDIDATE, openCandidate: () => 'candidate/13', for: 'head', ...over })

describe('the base of a branch', () => {
  test('with no candidate: origin/main, never the stale local main, and GitHub is not asked', () => {
    c.git('switch', '-q', '-c', 'feat/6/x', 'origin/main')
    let asked = false
    const base = resolve({
      candidate: null,
      openCandidate: () => {
        asked = true
        return 'candidate/13'
      },
    })
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
    assert.equal(asked, false, 'GitHub asked with no delivery.candidate')
    assert.match(base.reason, /no delivery\.candidate/)
  })

  test('with no candidate open: origin/main', () => {
    const base = resolve({ openCandidate: () => null, for: 'new' })
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
  })

  test('a new branch starts on the open candidate', () => {
    const base = resolve({ for: 'new' })
    assert.deepEqual([base.branch, base.ref], ['candidate/13', 'origin/candidate/13'])
  })

  test('a branch that descends from the open candidate: the candidate, from the fork point', () => {
    c.git('switch', '-q', '-c', 'feat/5/x', 'origin/candidate/13')
    c.git('commit', '-q', '--allow-empty', '-m', 'mine')
    const base = resolve({})
    assert.deepEqual([base.branch, base.ref], ['candidate/13', c.candidate])
  })

  test('a branch started on origin/main while a candidate is open: origin/main', () => {
    c.git('switch', '-q', '-c', 'feat/6/x', 'origin/main')
    c.git('commit', '-q', '--allow-empty', '-m', 'mine')
    const base = resolve({})
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
  })

  test("the candidate's own head goes into main", () => {
    c.git('switch', '-q', '--detach', 'origin/candidate/13')
    const base = resolve({})
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
  })

  test('a branch just started on the candidate, at its head with no commit yet: the candidate', () => {
    c.git('switch', '-q', '-c', 'feat/5/x', 'origin/candidate/13')
    const base = resolve({})
    assert.equal(base.branch, 'candidate/13')
  })

  test('a hotfix starts on origin/main, even with a candidate open, and GitHub is not asked', () => {
    let asked = false
    const base = resolve({
      for: 'hotfix',
      openCandidate: () => {
        asked = true
        return 'candidate/13'
      },
    })
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
    assert.equal(asked, false, 'GitHub asked for a hotfix')
    assert.match(base.reason, /hotfix/)
  })

  test('GitHub unreachable: origin/main, and the reason says the candidate is unknown', () => {
    const base = resolve({
      for: 'new',
      openCandidate: () => {
        throw new Error('gh: not found')
      },
    })
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
    assert.match(base.reason, /open candidate is unknown \(gh: not found\)/)
    assert.match(base.warning ?? '', /give --base/)
  })

  test('the local branch named after the open candidate is the candidate itself: main', () => {
    c.git('switch', '-q', '-c', 'candidate/13', 'origin/candidate/13')
    c.git('commit', '-q', '--allow-empty', '-m', 'squashed here')
    const base = resolve({})
    assert.deepEqual([base.branch, base.ref], ['main', 'origin/main'])
  })

  test('a base not fetched is an error that says to fetch, not the local branch', () => {
    c.git('branch', 'candidate/14')
    assert.throws(
      () => resolve({ for: 'new', openCandidate: () => 'candidate/14' }),
      /no origin\/candidate\/14.*git fetch origin/,
    )
  })
})

describe('the candidate at a detached HEAD', () => {
  test('is the candidate whose origin/ ref points at it; none for another commit', () => {
    c.git('switch', '-q', '--detach', 'origin/candidate/13')
    assert.equal(candidateAt(c.repo, 'candidate/'), 'candidate/13')
    c.git('switch', '-q', '--detach', 'origin/main')
    assert.equal(candidateAt(c.repo, 'candidate/'), null)
  })

  test('the highest by number when several point at it, and names past the prefix that are no number are not candidates', () => {
    for (const name of ['9', '13', 'x']) c.git('update-ref', `refs/remotes/origin/rc/${name}`, 'origin/candidate/13')
    c.git('switch', '-q', '--detach', 'origin/candidate/13')
    assert.equal(candidateAt(c.repo, 'rc/'), 'rc/13')
    c.git('update-ref', '-d', 'refs/remotes/origin/rc/13')
    c.git('update-ref', '-d', 'refs/remotes/origin/rc/9')
    assert.equal(candidateAt(c.repo, 'rc/'), null)
  })
})
