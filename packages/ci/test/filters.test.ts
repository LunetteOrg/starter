import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { branchFilter, globToRegExp, pathFilter } from '../src/filters.ts'

describe('globToRegExp', () => {
  test('* stops at a slash, ** crosses it', () => {
    assert.equal(globToRegExp('docs/*').test('docs/a.md'), true)
    assert.equal(globToRegExp('docs/*').test('docs/a/b.md'), false)
    assert.equal(globToRegExp('docs/**').test('docs/a/b.md'), true)
    assert.equal(globToRegExp('**/*.md').test('README.md'), true)
    assert.equal(globToRegExp('**/*.md').test('a/b/c.md'), true)
  })

  test('dots and other regex characters are literal', () => {
    assert.equal(globToRegExp('a.b').test('axb'), false)
    assert.equal(globToRegExp('release/*').test('release/12'), true)
  })
})

describe('branchFilter', () => {
  test('no filter matches every branch', () => {
    assert.deepEqual(branchFilter({}, 'main'), { match: true })
  })

  test('branches, with a later negation winning', () => {
    assert.equal(branchFilter({ branches: ['main'] }, 'main').match, true)
    assert.equal(branchFilter({ branches: ['main'] }, 'candidate/3').match, false)
    assert.equal(branchFilter({ branches: ['candidate/*', '!candidate/9'] }, 'candidate/9').match, false)
  })

  test('branches-ignore', () => {
    assert.equal(branchFilter({ 'branches-ignore': ['main'] }, 'main').match, false)
    assert.equal(branchFilter({ 'branches-ignore': ['main'] }, 'candidate/1').match, true)
  })
})

describe('pathFilter', () => {
  test('no filter, or an unknown diff, matches', () => {
    assert.equal(pathFilter({}, ['a']).match, true)
    assert.deepEqual(pathFilter({ paths: ['src/**'] }, null), { match: true, unknown: true })
  })

  test('paths: at least one changed file is included', () => {
    assert.equal(pathFilter({ paths: ['src/**'] }, ['docs/a.md', 'src/x.ts']).match, true)
    assert.equal(pathFilter({ paths: ['src/**'] }, ['docs/a.md']).match, false)
    assert.equal(pathFilter({ paths: ['src/**', '!src/**/*.md'] }, ['src/a.md']).match, false)
  })

  test('paths-ignore: runs unless every changed file is ignored', () => {
    assert.equal(pathFilter({ 'paths-ignore': ['docs/**'] }, ['docs/a.md']).match, false)
    assert.equal(pathFilter({ 'paths-ignore': ['docs/**'] }, ['docs/a.md', 'b.ts']).match, true)
  })
})
