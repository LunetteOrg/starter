// The Promise form of the base (src/base.ts) runs git in the directory it is given, not in the
// process's: against a real clone in a temp dir.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { defaultBranch, localRef, projectBase, remoteRef } from '../src/base.ts'
import { type Clone, clone } from './clone.ts'

let tmp: string
let c: Clone

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-base-')))
  c = clone(tmp)
  // A branch that only this clone has: the directory the tests run from does not.
  c.git('update-ref', 'refs/remotes/origin/only-in-this-clone', c.main)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('the base in the directory it is given', () => {
  test('remoteRef and localRef answer for that repository, not for the process directory', async () => {
    assert.notEqual(realpathSync(process.cwd()), c.repo)
    assert.equal(await remoteRef(c.repo, 'only-in-this-clone'), 'origin/only-in-this-clone')
    assert.equal(await localRef(c.repo, 'only-in-this-clone'), 'origin/only-in-this-clone')
    // The same names asked in the process directory find nothing there.
    await assert.rejects(remoteRef(process.cwd(), 'only-in-this-clone'), /no origin\/only-in-this-clone/)
    assert.equal(await localRef(process.cwd(), 'only-in-this-clone'), null)
  })

  test('the default branch is the one origin/HEAD of that repository names', async () => {
    c.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/only-in-this-clone')
    assert.equal(await defaultBranch(c.repo, null), 'only-in-this-clone')
  })

  test('a project base is resolved in that repository, the same on a second call', async () => {
    const first = await projectBase(c.repo, 'head')
    const second = await projectBase(c.repo, 'head')
    assert.deepEqual(second, first)
    assert.equal(first.ref, 'origin/main')
  })
})
