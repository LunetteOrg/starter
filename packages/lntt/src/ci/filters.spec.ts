import { assert, describe, it } from '@effect/vitest'
import { branchFilter, globToRegExp, pathFilter } from './filters.ts'

describe('globToRegExp', () => {
  it('* stops at a slash, ** crosses it', () => {
    assert.strictEqual(globToRegExp('docs/*').test('docs/a.md'), true)
    assert.strictEqual(globToRegExp('docs/*').test('docs/a/b.md'), false)
    assert.strictEqual(globToRegExp('docs/**').test('docs/a/b.md'), true)
    assert.strictEqual(globToRegExp('**/*.md').test('README.md'), true)
    assert.strictEqual(globToRegExp('**/*.md').test('a/b/c.md'), true)
  })

  it('dots and other regex characters are literal', () => {
    assert.strictEqual(globToRegExp('a.b').test('axb'), false)
    assert.strictEqual(globToRegExp('release/*').test('release/12'), true)
  })
})

describe('branchFilter', () => {
  it('no filter matches every branch', () => {
    assert.deepStrictEqual(branchFilter({}, 'main'), { match: true })
  })

  it('branches, with a later negation winning', () => {
    assert.strictEqual(branchFilter({ branches: ['main'] }, 'main').match, true)
    assert.strictEqual(branchFilter({ branches: ['main'] }, 'candidate/3').match, false)
    assert.strictEqual(branchFilter({ branches: ['candidate/*', '!candidate/9'] }, 'candidate/9').match, false)
  })

  it('branches-ignore', () => {
    assert.strictEqual(branchFilter({ 'branches-ignore': ['main'] }, 'main').match, false)
    assert.strictEqual(branchFilter({ 'branches-ignore': ['main'] }, 'candidate/1').match, true)
  })
})

describe('pathFilter', () => {
  it('no filter, or an unknown diff, matches', () => {
    assert.strictEqual(pathFilter({}, ['a']).match, true)
    assert.deepStrictEqual(pathFilter({ paths: ['src/**'] }, null), { match: true, unknown: true })
  })

  it('paths: at least one changed file is included', () => {
    assert.strictEqual(pathFilter({ paths: ['src/**'] }, ['docs/a.md', 'src/x.ts']).match, true)
    assert.strictEqual(pathFilter({ paths: ['src/**'] }, ['docs/a.md']).match, false)
    assert.strictEqual(pathFilter({ paths: ['src/**', '!src/**/*.md'] }, ['src/a.md']).match, false)
  })

  it('paths-ignore: runs unless every changed file is ignored', () => {
    assert.strictEqual(pathFilter({ 'paths-ignore': ['docs/**'] }, ['docs/a.md']).match, false)
    assert.strictEqual(pathFilter({ 'paths-ignore': ['docs/**'] }, ['docs/a.md', 'b.ts']).match, true)
  })
})
