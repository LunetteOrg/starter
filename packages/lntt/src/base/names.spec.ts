import { assert, describe, it } from '@effect/vitest'
import { candidateNumber, candidateRules, defaultOf, highestCandidate, localRefs, openCandidateOf } from './names.ts'

describe('the names the base reads', () => {
  it('delivery.candidate gives the base, main by default, and the prefix; no section is no candidate', () => {
    assert.deepStrictEqual(candidateRules({ delivery: { candidate: { prefix: 'rc/' } } }), {
      base: 'main',
      prefix: 'rc/',
    })
    assert.deepStrictEqual(candidateRules({ delivery: { candidate: { base: 'trunk', prefix: 'candidate/' } } }), {
      base: 'trunk',
      prefix: 'candidate/',
    })
    assert.strictEqual(candidateRules({}), null)
  })

  it("the default branch is origin/HEAD's without origin/, else main", () => {
    assert.strictEqual(defaultOf('origin/trunk'), 'trunk')
    assert.strictEqual(defaultOf(null), 'main')
    assert.strictEqual(defaultOf(''), 'main')
  })

  it('a candidate is the prefix and a number, nothing more', () => {
    assert.strictEqual(candidateNumber('candidate/', 'candidate/13'), 13)
    assert.strictEqual(candidateNumber('candidate/', 'candidate/13x'), null)
    assert.strictEqual(candidateNumber('candidate/', 'candidate/'), null)
    assert.strictEqual(candidateNumber('candidate/', 'rc/13'), null)
    assert.strictEqual(candidateNumber('candidate/', undefined), null)
  })

  it('among refs, the highest candidate; among open pull requests, the lowest', () => {
    const refs = [
      'refs/remotes/origin/candidate/9',
      'refs/remotes/origin/candidate/13',
      'refs/remotes/origin/candidate/x',
    ]
    assert.strictEqual(highestCandidate(refs, 'candidate/'), 'candidate/13')
    assert.strictEqual(highestCandidate([], 'candidate/'), null)
    const prs = [{ headRefName: 'candidate/13' }, { headRefName: 'candidate/9' }, { headRefName: 'feat/1/x' }]
    assert.deepStrictEqual(openCandidateOf(prs, 'candidate/'), { headRefName: 'candidate/9' })
    assert.strictEqual(openCandidateOf([{ headRefName: 'feat/1/x' }], 'candidate/'), null)
  })

  it('--base is tried as the remote copy first, then as a local branch', () => {
    assert.deepStrictEqual(localRefs('candidate/13'), ['origin/candidate/13', 'candidate/13'])
  })
})
