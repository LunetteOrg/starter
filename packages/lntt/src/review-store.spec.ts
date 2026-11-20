import { assert, describe, it } from '@effect/vitest'
import { branchesIn, branchKey, keyBranch, parseRefs, pruneReason } from './review-store.ts'

describe('a branch name as a file name', () => {
  it('is percent-encoded, a capital as % and its lower-case hexadecimal code', () => {
    assert.strictEqual(branchKey('feat/1/x'), 'feat%2F1%2Fx')
    assert.strictEqual(branchKey('Fix/A'), '%46ix%2F%41')
    assert.strictEqual(branchKey('J'), '%4a')
    assert.strictEqual(branchKey('release/1.2_é'), 'release%2F1.2_%C3%A9')
  })

  it('reads back, and a name that is not valid percent-encoding is no branch', () => {
    for (const branch of ['feat/1/x', 'Fix/A', 'release/1.2_é', '100%']) {
      assert.strictEqual(keyBranch(branchKey(branch)), branch)
    }
    assert.strictEqual(keyBranch('%E0'), null)
  })

  it('is the only name of the branch: another encoding of it names no branch', () => {
    const state = ['feat%2F1%2Fx', 'Fix%2FA', '%4A', 'a%2fb', '%E0'].map((name) => `${name}.json`)
    assert.deepStrictEqual(branchesIn([...state, 'notes.txt'], ['feat%2F1%2Fx.json']), ['feat/1/x'])
  })
})

describe('the branches a prune leaves', () => {
  const refs = parseRefs(
    [
      'refs/heads/main\t',
      'refs/heads/feat/1/merged\t[gone]',
      'refs/heads/feat/2/open\t[ahead 1]',
      'refs/remotes/origin/HEAD\t',
      'refs/remotes/origin/feat/3/remote\t',
    ].join('\n'),
    'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w\nHEAD def\nbranch refs/heads/feat/4/here\n',
  )

  it('a branch checked out in a worktree stays; a local one whose upstream is gone goes', () => {
    assert.strictEqual(pruneReason('feat/4/here', refs), null)
    assert.strictEqual(pruneReason('main', refs), null)
    assert.strictEqual(pruneReason('feat/1/merged', refs), 'its upstream is gone')
  })

  it('a branch left locally or on a remote stays; one with no branch of its name goes', () => {
    assert.strictEqual(pruneReason('feat/2/open', refs), null)
    assert.strictEqual(pruneReason('feat/3/remote', refs), null)
    assert.strictEqual(pruneReason('feat/5/gone', refs), 'no branch of that name is left')
  })
})
