import { assert, describe, it } from '@effect/vitest'
import { clashes, isStub, skillState, stub, stubNames } from './skills.ts'

const SKILL = '---\nname: review\ndescription: Review a change.\n---\n\n# Review\n\nA long guide.\n'

describe('a stub', () => {
  it("keeps the skill's frontmatter and only says to load the guide", () => {
    const text = stub('review', SKILL) as string
    assert.isTrue(text.startsWith('---\nname: review\ndescription: Review a change.\n---\n'), text)
    assert.match(text, /installed by lntt sync from @lntt\/lntt/)
    assert.match(text, /\npnpm exec lntt guide review\n/)
    assert.notInclude(text, 'A long guide.')
  })

  it('is none for a skill with no frontmatter; one checked out with CRLF line endings gives the same stub', () => {
    assert.strictEqual(stub('review', '# Review\n'), null)
    assert.strictEqual(stub('review', SKILL.replaceAll('\n', '\r\n')), stub('review', SKILL))
  })

  it('is told by the marker right after the frontmatter, not by a quote of it further down', () => {
    const text = stub('review', SKILL) as string
    assert.isTrue(isStub(text))
    assert.isTrue(isStub(text.replaceAll('\n', '\r\n')))
    assert.isFalse(isStub(`---\nname: mine\n---\n# Mine\n\n${text.split('\n')[4]}\n`))
  })
})

describe("a shared skill's folder", () => {
  const written = stub('review', SKILL) as string

  it('is in step holding the stub alone, a hidden file beside it; edited with anything else', () => {
    assert.strictEqual(skillState({ names: ['SKILL.md'], skill: written }, written), 'ok')
    assert.strictEqual(skillState({ names: ['.DS_Store', 'SKILL.md'], skill: written }, written), 'ok')
    assert.strictEqual(skillState({ names: ['SKILL.md', 'notes.md'], skill: written }, written), 'edited')
    assert.strictEqual(skillState({ names: ['SKILL.md'], skill: `${written}More.\n` }, written), 'edited')
  })

  it('is missing with no folder or no SKILL.md; a folder of the project that holds a file is a clash', () => {
    assert.strictEqual(skillState(null, written), 'missing')
    assert.strictEqual(skillState({ names: ['.DS_Store'], skill: null }, written), 'missing')
    assert.strictEqual(skillState({ names: ['notes.md'], skill: null }, written), 'clash')
    assert.strictEqual(skillState({ names: ['SKILL.md'], skill: 'our own\n' }, written), 'clash')
    assert.isFalse(clashes({ names: [], skill: null }))
    assert.isFalse(clashes(null))
  })

  it('the stubs of a directory are its folders holding one, sorted', () => {
    assert.deepStrictEqual(
      stubNames({
        review: { names: ['SKILL.md'], skill: written },
        gone: { names: ['SKILL.md'], skill: written },
        ours: { names: ['SKILL.md'], skill: 'ours\n' },
        empty: null,
      }),
      ['gone', 'review'],
    )
  })
})
