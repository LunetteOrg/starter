import { assert, describe, it } from '@effect/vitest'
import { retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import {
  agentsMdResults,
  pluginResults,
  retrospectiveResults,
  skillsResults,
  templatePath,
  templateResult,
} from './areas.ts'

describe("lntt sync's areas", () => {
  it('the managed block passes when it matches its source, and says how to fix it when not', () => {
    assert.strictEqual(agentsMdResults(true)[0]?.status, 'PASS')
    assert.match(agentsMdResults(false)[0]?.message ?? '', /run pnpm exec lntt sync/)
  })

  it('a skill installed as lntt sync writes it passes; each one that is not says why, by its path', () => {
    assert.deepStrictEqual(
      skillsResults([{ path: '.agents/skills/review', state: 'ok' }]).map((r) => r.status),
      ['PASS'],
    )
    assert.deepStrictEqual(
      skillsResults([
        { path: '.agents/skills/review', state: 'ok' },
        { path: '.claude/skills/review', state: 'missing' },
        { path: '.claude/skills/old', state: 'unknown' },
        { path: '.agents/skills/decisions', state: 'clash' },
      ]).map((r) => `${r.status} ${r.path} ${r.message.split(';')[0]}`),
      [
        'FAIL .claude/skills/review not installed',
        'FAIL .claude/skills/old a stub of a skill @lntt/lntt does not have',
        "FAIL .agents/skills/decisions a skill of the project's own with the name of a shared skill",
      ],
    )
  })

  it("the plugin's settings pass when every entry is in step; an entry that is not names its key", () => {
    assert.strictEqual(pluginResults([{ key: 'enabledPlugins', state: 'ok' }])[0]?.status, 'PASS')
    assert.deepStrictEqual(
      pluginResults([{ key: 'enabledPlugins', state: 'off' }]).map((r) => r.message),
      ['enabledPlugins is not enabled; run pnpm exec lntt sync'],
    )
  })
})

describe('the body of a pull request', () => {
  const data = {}
  const block = retrospectiveBlock(retrospectiveRules(data))

  it('with no body given, the retrospective is NOT RUN; a body with every label filled passes', () => {
    assert.strictEqual(retrospectiveResults({ data })[0]?.status, 'NOT RUN')
    const filled = block.replace(/:\*\*.*$/gm, ':** none')
    assert.strictEqual(retrospectiveResults({ data, body: { text: filled, from: 'stdin' } })[0]?.status, 'PASS')
  })

  it('the template holds the block lntt pr block prints; one edited fails, none is NOT RUN', () => {
    assert.strictEqual(templatePath({}), '.github/pull_request_template.md')
    assert.strictEqual(templatePath({ delivery: { pullRequest: { template: 'docs/pr.md' } } }), 'docs/pr.md')
    assert.strictEqual(templateResult('t.md', null, data).status, 'NOT RUN')
    assert.strictEqual(templateResult('t.md', `## Why\n\n${block.replaceAll('\n', '\r\n')}`, data).status, 'PASS')
    const edited = templateResult('t.md', block.replace(/\*\*[^*]+\*\*/, '**Other:**'), data)
    assert.strictEqual(edited.status, 'FAIL')
    assert.match(edited.message, /differs from the configuration/)
  })
})
