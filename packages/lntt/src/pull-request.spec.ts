import { assert, describe, it } from '@effect/vitest'
import {
  appendRetro,
  checkBody,
  findLabel,
  retroComment,
  retrospectiveBlock,
  retrospectiveRules,
  upstreamItems,
} from './pull-request.ts'

const DEFAULTS = retrospectiveRules({})

function body(...lines: string[]): string {
  return [
    '## Why',
    '',
    'Because.',
    '',
    '## 🔁 Retrospective',
    '<!-- retro:start -->',
    ...lines,
    '<!-- retro:end -->',
  ].join('\n')
}

const FILLED = [
  '- **Friction:** the review state reset when the worktree changed branch',
  '- **To automate (hook/skill/agent):** none',
  '- **Rule rediscovered (→ ADR/AGENTS.md):** none',
  '- **Rework cause:** none',
]

describe('the retrospective rules', () => {
  it('the defaults the schema documents', () => {
    assert.deepStrictEqual(DEFAULTS, {
      heading: '🔁 Retrospective',
      lines: ['Friction', 'To automate (hook/skill/agent)', 'Rule rediscovered (→ ADR/AGENTS.md)', 'Rework cause'],
      none: 'none',
    })
  })

  it('delivery.pullRequest.retrospective replaces each default it gives', () => {
    const rules = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' } } },
    })
    assert.deepStrictEqual(rules, {
      heading: '🔁 Retrospective',
      lines: ['Attrito', 'Causa di rilavoro'],
      none: 'nessuno',
    })
    const heading = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { heading: '🔁 Retrospettiva' } } },
    })
    assert.strictEqual(heading.heading, '🔁 Retrospettiva')
  })

  it('the empty block: the heading, the markers, one label per line with no value', () => {
    assert.strictEqual(
      retrospectiveBlock({ heading: '🔁 Retro', lines: ['Friction', 'Rework cause'], none: 'none' }),
      '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Rework cause:**\n<!-- retro:end -->\n',
    )
  })
})

describe('checkBody', () => {
  it('a block with every label filled, none included, has nothing to report', () => {
    assert.deepStrictEqual(checkBody(body(...FILLED), DEFAULTS), [])
  })

  it('the empty block as the template gives it reports every label', () => {
    const problems = checkBody(retrospectiveBlock(DEFAULTS), DEFAULTS)
    assert.strictEqual(problems.length, 4)
    assert.match(problems[0] as string, /"Friction" is empty: write none when nothing applies/)
  })

  it('a label whose value is on the lines below it is filled', () => {
    const lines = [
      '- **Friction:**',
      '  - the usage limit stopped a round',
      '  - a lost mailbox watch',
      ...FILLED.slice(1),
    ]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [])
  })

  it('a placeholder left in an HTML comment is no value', () => {
    const lines = ['- **Friction:** <!-- what was harder than it should be -->', ...FILLED.slice(1)]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" is empty: write none when nothing applies',
    ])
  })

  it('a placeholder comment across several lines is no value either', () => {
    const lines = ['- **Friction:** <!--', '  what was harder', '  than it should be -->', ...FILLED.slice(1)]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" is empty: write none when nothing applies',
    ])
  })

  it('an unclosed comment hides the rest of the block', () => {
    const lines = ['- **Friction:** <!-- what was harder', ...FILLED.slice(1)]
    assert.strictEqual(checkBody(body(...lines), DEFAULTS).length, 4)
  })

  it('* bullets are labels too', () => {
    assert.deepStrictEqual(checkBody(body(...FILLED.map((l) => l.replace(/^-/, '*'))), DEFAULTS), [])
  })

  it('an indented bold item belongs to the value above it, not a label', () => {
    const lines = ['- **Friction:**', '  - **Rework cause:** the squash order', ...FILLED.slice(1, 3)]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), ['retrospective: no "Rework cause" line in the block'])
  })

  it('a label written twice is reported, whichever copy is filled', () => {
    const empty = [...FILLED, '- **Friction:**']
    assert.deepStrictEqual(checkBody(body(...empty), DEFAULTS), [
      'retrospective: "Friction" is in the block more than once: keep one',
    ])
    assert.strictEqual(checkBody(body('- **Friction:**', ...FILLED), DEFAULTS).length, 1)
  })

  it('an end marker above the start marker closes nothing', () => {
    const text = ['<!-- retro:end -->', '<!-- retro:start -->', ...FILLED].join('\n')
    assert.deepStrictEqual(checkBody(text, DEFAULTS), [
      'retrospective: no <!-- retro:start --> … <!-- retro:end --> block',
    ])
  })

  it('a missing label is named', () => {
    assert.deepStrictEqual(checkBody(body(...FILLED.slice(0, 3)), DEFAULTS), [
      'retrospective: no "Rework cause" line in the block',
    ])
  })

  it('a body without the markers says the block is missing', () => {
    assert.deepStrictEqual(checkBody('## Why\n\nBecause.\n', DEFAULTS), [
      'retrospective: no <!-- retro:start --> … <!-- retro:end --> block',
    ])
  })

  it('the markers quoted in a sentence or a code span are not the block', () => {
    const quoted = 'The block sits between `<!-- retro:start -->` and `<!-- retro:end -->`.'
    assert.strictEqual(checkBody(quoted, DEFAULTS).length, 1)
  })

  it('the labels and the none of the configuration', () => {
    const rules = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' } } },
    })
    assert.deepStrictEqual(checkBody(body('- **Attrito:** nessuno', '- **Causa di rilavoro:**'), rules), [
      'retrospective: "Causa di rilavoro" is empty: write nessuno when nothing applies',
    ])
  })

  it('CRLF line endings, as a body edited on GitHub has them', () => {
    assert.deepStrictEqual(checkBody(body(...FILLED).replaceAll('\n', '\r\n'), DEFAULTS), [])
  })
})

describe('the upstream marker', () => {
  it('an item that starts with [upstream:<owner/name>], on the label line or as a sub-bullet, is well formed', () => {
    const lines = [
      '- **Friction:**',
      '  - [upstream:LunetteOrg/starter] lntt review lost its state when the worktree changed branch',
      '  - the usage limit stopped a round',
      '- **To automate (hook/skill/agent):** [upstream:remix-run/react-router] the dev server drops HMR',
      ...FILLED.slice(2),
    ]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepStrictEqual(upstreamItems(body(...lines)), [
      {
        label: 'Friction',
        repository: 'LunetteOrg/starter',
        item: 'lntt review lost its state when the worktree changed branch',
      },
      {
        label: 'To automate (hook/skill/agent)',
        repository: 'remix-run/react-router',
        item: 'the dev server drops HMR',
      },
    ])
  })

  it('a marker with no sentence after it is reported, and is no item', () => {
    const lines = ['- **Friction:** [upstream:LunetteOrg/starter]', ...FILLED.slice(1)]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" has a [upstream:LunetteOrg/starter] item with no sentence after the marker',
    ])
    assert.deepStrictEqual(upstreamItems(body(...lines)), [])
  })

  it('a marker whose repository is not owner/name, or joined to what follows, is reported, and is no item', () => {
    for (const marker of [
      '[upstream:starter]',
      '[upstream:]',
      '[upstream:a/b/c]',
      '[upstream:a/b]:',
      '[upstream:a b]',
    ]) {
      const lines = ['- **Friction:**', `  - ${marker} the scaffolder pins an old Node`, ...FILLED.slice(1)]
      const [problem, ...rest] = checkBody(body(...lines), DEFAULTS)
      assert.match(problem ?? '', /^retrospective: "Friction" has an item starting \[upstream:/, marker)
      assert.match(problem ?? '', /write \[upstream:<owner\/name>\], a space, then the sentence$/, marker)
      assert.deepStrictEqual(rest, [], marker)
      assert.deepStrictEqual(upstreamItems(body(...lines)), [], marker)
    }
  })

  it('the repository is kept as written, case included', () => {
    const lines = ['- **Friction:** [upstream:lunetteorg/Starter] a', ...FILLED.slice(1)]
    assert.deepStrictEqual(upstreamItems(body(...lines)), [
      { label: 'Friction', repository: 'lunetteorg/Starter', item: 'a' },
    ])
  })

  it('a bracketed path or owner/name with no upstream: is plain text', () => {
    for (const text of ['[src/app] fix the loader', '[LunetteOrg/starter] lntt review', 'the [upstream:a/b] repo']) {
      const lines = ['- **Friction:**', `  - ${text}`, ...FILLED.slice(1)]
      assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [], text)
      assert.deepStrictEqual(upstreamItems(body(...lines)), [], text)
    }
    assert.deepStrictEqual(upstreamItems(`- [upstream:LunetteOrg/starter] outside\n${body(...FILLED)}`), [])
  })

  it('several markers, a bullet nested deeper or not indented, an item wrapped on two lines', () => {
    const lines = [
      '- **Friction:**',
      '  - [upstream:LunetteOrg/starter] lntt review lost its state',
      '    - [upstream:LunetteOrg/starter] nested deeper',
      '- [upstream:LunetteOrg/starter] not indented',
      '  - [upstream:LunetteOrg/starter] a long item',
      '    wrapped on the next line',
      ...FILLED.slice(1),
    ]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepStrictEqual(
      upstreamItems(body(...lines)).map((i) => i.item),
      ['lntt review lost its state', 'nested deeper', 'not indented', 'a long item wrapped on the next line'],
    )
  })

  it('a line that is no bullet under a label left empty on its line is an item of that label', () => {
    const lines = [
      '- **Friction:** none',
      '- **To automate (hook/skill/agent):**',
      '[upstream:LunetteOrg/starter] a hook',
      ...FILLED.slice(2),
    ]
    assert.deepStrictEqual(upstreamItems(body(...lines)), [
      { label: 'To automate (hook/skill/agent)', repository: 'LunetteOrg/starter', item: 'a hook' },
    ])
  })

  it('a marker inside an HTML comment is no item', () => {
    const lines = ['- **Friction:** none <!-- [upstream:LunetteOrg/starter] -->', ...FILLED.slice(1)]
    assert.deepStrictEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepStrictEqual(upstreamItems(body(...lines)), [])
  })
})

// The retrospective block's labels, the append and the comment that holds it: what lntt retro add
// writes (src/retro/command.ts).
const RULES = retrospectiveRules({})
const EMPTY = retrospectiveBlock(RULES)

describe('findLabel', () => {
  it('the configured label equal ignoring case, else the only one it starts', () => {
    assert.strictEqual(findLabel(RULES, 'friction'), 'Friction')
    assert.strictEqual(findLabel(RULES, 'to automate'), 'To automate (hook/skill/agent)')
    assert.strictEqual(findLabel(RULES, 'R'), null, 'Rule rediscovered and Rework cause both start with R')
    assert.strictEqual(findLabel(RULES, 'cost'), null)
    assert.strictEqual(findLabel(RULES, ' '), null)
  })
})

describe('appendRetro', () => {
  it('an empty label takes the item on its line; the markers and the other labels stay', () => {
    const next = appendRetro(EMPTY, 'Friction', 'the review did not converge', RULES)
    assert.strictEqual(next, EMPTY.replace('- **Friction:**', '- **Friction:** the review did not converge'))
    assert.deepStrictEqual(
      checkBody(next, RULES).map((p) => p.replace(/"(.+)" is empty.*/, '$1')),
      [
        'retrospective: To automate (hook/skill/agent)',
        'retrospective: Rule rediscovered (→ ADR/AGENTS.md)',
        'retrospective: Rework cause',
      ],
    )
  })

  it('a label with one item gets sub-bullets, the first item kept first', () => {
    const one = appendRetro(EMPTY, 'Friction', 'first', RULES)
    const two = appendRetro(one, 'Friction', 'second', RULES)
    assert.match(two, /- \*\*Friction:\*\*\n {2}- first\n {2}- second\n- \*\*To automate/)
  })

  it('a label with sub-bullets gets one more, after the last one', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:**\n  - first\n  - second')
    const next = appendRetro(text, 'Friction', 'third', RULES)
    assert.match(next, /- \*\*Friction:\*\*\n {2}- first\n {2}- second\n {2}- third\n- \*\*To automate/)
  })

  it('the last label, right above the end marker', () => {
    const next = appendRetro(EMPTY, 'Rework cause', 'the squash order', RULES)
    assert.match(next, /- \*\*Rework cause:\*\* the squash order\n<!-- retro:end -->/)
  })

  it('none and a placeholder comment are replaced by the item', () => {
    const none = EMPTY.replace('- **Friction:**', '- **Friction:** none')
    assert.match(appendRetro(none, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n/)
    const placeholder = EMPTY.replace('- **Friction:**', '- **Friction:** <!-- what was hard -->')
    assert.match(appendRetro(placeholder, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n/)
  })

  it('a placeholder comment across lines, or left open, is no value either', () => {
    for (const placeholder of ['- **Friction:** <!--\n  what was hard\n  -->', '- **Friction:** <!-- what was hard']) {
      const text = EMPTY.replace('- **Friction:**', placeholder)
      assert.match(appendRetro(text, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n- \*\*To automate/)
    }
  })

  it('none on the label line with sub-bullets below: none goes, the sub-bullets stay, one more', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** none\n  - first')
    assert.match(appendRetro(text, 'Friction', 'x', RULES), /- \*\*Friction:\*\*\n {2}- first\n {2}- x\n/)
  })

  it('none on the label line with free text and a placeholder below: none goes, the text stays', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** none\n  the review stalled\n  <!-- more -->')
    assert.match(
      appendRetro(text, 'Friction', 'x', RULES),
      /- \*\*Friction:\*\*\n {2}the review stalled\n {2}<!-- more -->\n {2}- x\n- \*\*To/,
    )
  })

  it('an empty label line with a value on the lines below: the item after them', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:**\n  the review stalled\n  twice')
    assert.match(
      appendRetro(text, 'Friction', 'x', RULES),
      /:\*\*\n {2}the review stalled\n {2}twice\n {2}- x\n- \*\*To/,
    )
  })

  it('a value on the label line with more below: the value becomes the first sub-bullet', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** first\n  - second')
    assert.match(appendRetro(text, 'Friction', 'third', RULES), /:\*\*\n {2}- first\n {2}- second\n {2}- third\n/)
  })

  it('text around the block, and CRLF line endings, are kept', () => {
    const text = `Lead.\r\n\r\n${EMPTY.replaceAll('\n', '\r\n')}After.`
    const next = appendRetro(text, 'Friction', 'x', RULES)
    assert.ok(next.startsWith('Lead.\r\n\r\n## 🔁 Retrospective\r\n'))
    assert.ok(next.endsWith('<!-- retro:end -->\r\nAfter.'))
    assert.ok(next.includes('- **Friction:** x\r\n'))
  })

  it('no block, or a block without the label, is refused', () => {
    assert.throws(
      () => appendRetro('no block', 'Friction', 'x', RULES),
      /no <!-- retro:start --> … <!-- retro:end --> block/,
    )
    const without = EMPTY.replace('- **Friction:**\n', '')
    assert.throws(() => appendRetro(without, 'Friction', 'x', RULES), /no "Friction" line in the block/)
  })
})

describe('retroComment', () => {
  it('the first comment holding the start marker on a line of its own', () => {
    const all = [
      { id: 1, body: 'Moved onto candidate/8.' },
      { id: 2, body: 'The block sits between `<!-- retro:start -->` and its end.' },
      { id: 3, body: EMPTY },
      { id: 4, body: EMPTY },
    ]
    assert.strictEqual(retroComment(all)?.id, 3)
    assert.strictEqual(retroComment(all.slice(0, 2)), null)
  })
})
