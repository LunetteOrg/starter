import { assert, describe, it } from '@effect/vitest'
import { keptFiles } from './files.ts'

describe('the files a check reads', () => {
  it("leave out a nested project, with a configuration of its own, and the shared skills' stubs, sorted", () => {
    const listed = [
      'src/b.ts',
      'src/a.ts',
      'templates/web/.agents/config.jsonc',
      'templates/web/README.md',
      'templates/web-other/README.md',
      '.claude/skills/review/SKILL.md',
      '.claude/skills/issues/SKILL.md',
      'src/a.ts',
    ]
    assert.deepStrictEqual(keptFiles(listed, ['.claude/skills/review']), [
      '.claude/skills/issues/SKILL.md',
      'src/a.ts',
      'src/b.ts',
      'templates/web-other/README.md',
    ])
  })
})
