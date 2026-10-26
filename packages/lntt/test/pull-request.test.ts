import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkBody, retrospectiveBlock, retrospectiveRules, upstreamItems } from '../src/pull-request.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

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
  test('the defaults the schema documents', () => {
    assert.deepEqual(DEFAULTS, {
      heading: '🔁 Retrospective',
      lines: ['Friction', 'To automate (hook/skill/agent)', 'Rule rediscovered (→ ADR/AGENTS.md)', 'Rework cause'],
      none: 'none',
    })
  })

  test('delivery.pullRequest.retrospective replaces each default it gives', () => {
    const rules = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' } } },
    })
    assert.deepEqual(rules, {
      heading: '🔁 Retrospective',
      lines: ['Attrito', 'Causa di rilavoro'],
      none: 'nessuno',
    })
    const heading = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { heading: '🔁 Retrospettiva' } } },
    })
    assert.equal(heading.heading, '🔁 Retrospettiva')
  })

  test('the empty block: the heading, the markers, one label per line with no value', () => {
    assert.equal(
      retrospectiveBlock({ heading: '🔁 Retro', lines: ['Friction', 'Rework cause'], none: 'none' }),
      '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Rework cause:**\n<!-- retro:end -->\n',
    )
  })
})

describe('checkBody', () => {
  test('a block with every label filled, none included, has nothing to report', () => {
    assert.deepEqual(checkBody(body(...FILLED), DEFAULTS), [])
  })

  test('the empty block as the template gives it reports every label', () => {
    const problems = checkBody(retrospectiveBlock(DEFAULTS), DEFAULTS)
    assert.equal(problems.length, 4)
    assert.match(problems[0] as string, /"Friction" is empty: write none when nothing applies/)
  })

  test('a label whose value is on the lines below it is filled', () => {
    const lines = [
      '- **Friction:**',
      '  - the usage limit stopped a round',
      '  - a lost mailbox watch',
      ...FILLED.slice(1),
    ]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [])
  })

  test('a placeholder left in an HTML comment is no value', () => {
    const lines = ['- **Friction:** <!-- what was harder than it should be -->', ...FILLED.slice(1)]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" is empty: write none when nothing applies',
    ])
  })

  test('a placeholder comment across several lines is no value either', () => {
    const lines = ['- **Friction:** <!--', '  what was harder', '  than it should be -->', ...FILLED.slice(1)]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" is empty: write none when nothing applies',
    ])
  })

  test('an unclosed comment hides the rest of the block', () => {
    const lines = ['- **Friction:** <!-- what was harder', ...FILLED.slice(1)]
    assert.equal(checkBody(body(...lines), DEFAULTS).length, 4)
  })

  test('* bullets are labels too', () => {
    assert.deepEqual(checkBody(body(...FILLED.map((l) => l.replace(/^-/, '*'))), DEFAULTS), [])
  })

  test('an indented bold item belongs to the value above it, not a label', () => {
    const lines = ['- **Friction:**', '  - **Rework cause:** the squash order', ...FILLED.slice(1, 3)]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), ['retrospective: no "Rework cause" line in the block'])
  })

  test('a label written twice is reported, whichever copy is filled', () => {
    const empty = [...FILLED, '- **Friction:**']
    assert.deepEqual(checkBody(body(...empty), DEFAULTS), [
      'retrospective: "Friction" is in the block more than once: keep one',
    ])
    assert.equal(checkBody(body('- **Friction:**', ...FILLED), DEFAULTS).length, 1)
  })

  test('an end marker above the start marker closes nothing', () => {
    const text = ['<!-- retro:end -->', '<!-- retro:start -->', ...FILLED].join('\n')
    assert.deepEqual(checkBody(text, DEFAULTS), ['retrospective: no <!-- retro:start --> … <!-- retro:end --> block'])
  })

  test('a missing label is named', () => {
    assert.deepEqual(checkBody(body(...FILLED.slice(0, 3)), DEFAULTS), [
      'retrospective: no "Rework cause" line in the block',
    ])
  })

  test('a body without the markers says the block is missing', () => {
    assert.deepEqual(checkBody('## Why\n\nBecause.\n', DEFAULTS), [
      'retrospective: no <!-- retro:start --> … <!-- retro:end --> block',
    ])
  })

  test('the markers quoted in a sentence or a code span are not the block', () => {
    const quoted = 'The block sits between `<!-- retro:start -->` and `<!-- retro:end -->`.'
    assert.equal(checkBody(quoted, DEFAULTS).length, 1)
  })

  test('the labels and the none of the configuration', () => {
    const rules = retrospectiveRules({
      delivery: { pullRequest: { retrospective: { lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' } } },
    })
    assert.deepEqual(checkBody(body('- **Attrito:** nessuno', '- **Causa di rilavoro:**'), rules), [
      'retrospective: "Causa di rilavoro" is empty: write nessuno when nothing applies',
    ])
  })

  test('CRLF line endings, as a body edited on GitHub has them', () => {
    assert.deepEqual(checkBody(body(...FILLED).replaceAll('\n', '\r\n'), DEFAULTS), [])
  })
})

describe('the upstream marker', () => {
  test('an item that starts with [upstream:<owner/name>], on the label line or as a sub-bullet, is well formed', () => {
    const lines = [
      '- **Friction:**',
      '  - [upstream:LunetteOrg/starter] lntt review lost its state when the worktree changed branch',
      '  - the usage limit stopped a round',
      '- **To automate (hook/skill/agent):** [upstream:remix-run/react-router] the dev server drops HMR',
      ...FILLED.slice(2),
    ]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepEqual(upstreamItems(body(...lines)), [
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

  test('a marker with no sentence after it is reported, and is no item', () => {
    const lines = ['- **Friction:** [upstream:LunetteOrg/starter]', ...FILLED.slice(1)]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [
      'retrospective: "Friction" has a [upstream:LunetteOrg/starter] item with no sentence after the marker',
    ])
    assert.deepEqual(upstreamItems(body(...lines)), [])
  })

  test('a marker whose repository is not owner/name, or joined to what follows, is reported, and is no item', () => {
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
      assert.deepEqual(rest, [], marker)
      assert.deepEqual(upstreamItems(body(...lines)), [], marker)
    }
  })

  test('the repository is kept as written, case included', () => {
    const lines = ['- **Friction:** [upstream:lunetteorg/Starter] a', ...FILLED.slice(1)]
    assert.deepEqual(upstreamItems(body(...lines)), [
      { label: 'Friction', repository: 'lunetteorg/Starter', item: 'a' },
    ])
  })

  test('a bracketed path or owner/name with no upstream: is plain text', () => {
    for (const text of ['[src/app] fix the loader', '[LunetteOrg/starter] lntt review', 'the [upstream:a/b] repo']) {
      const lines = ['- **Friction:**', `  - ${text}`, ...FILLED.slice(1)]
      assert.deepEqual(checkBody(body(...lines), DEFAULTS), [], text)
      assert.deepEqual(upstreamItems(body(...lines)), [], text)
    }
    assert.deepEqual(upstreamItems(`- [upstream:LunetteOrg/starter] outside\n${body(...FILLED)}`), [])
  })

  test('several markers, a bullet nested deeper or not indented, an item wrapped on two lines', () => {
    const lines = [
      '- **Friction:**',
      '  - [upstream:LunetteOrg/starter] lntt review lost its state',
      '    - [upstream:LunetteOrg/starter] nested deeper',
      '- [upstream:LunetteOrg/starter] not indented',
      '  - [upstream:LunetteOrg/starter] a long item',
      '    wrapped on the next line',
      ...FILLED.slice(1),
    ]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepEqual(
      upstreamItems(body(...lines)).map((i) => i.item),
      ['lntt review lost its state', 'nested deeper', 'not indented', 'a long item wrapped on the next line'],
    )
  })

  test('a line that is no bullet under a label left empty on its line is an item of that label', () => {
    const lines = [
      '- **Friction:** none',
      '- **To automate (hook/skill/agent):**',
      '[upstream:LunetteOrg/starter] a hook',
      ...FILLED.slice(2),
    ]
    assert.deepEqual(upstreamItems(body(...lines)), [
      { label: 'To automate (hook/skill/agent)', repository: 'LunetteOrg/starter', item: 'a hook' },
    ])
  })

  test('a marker inside an HTML comment is no item', () => {
    const lines = ['- **Friction:** none <!-- [upstream:LunetteOrg/starter] -->', ...FILLED.slice(1)]
    assert.deepEqual(checkBody(body(...lines), DEFAULTS), [])
    assert.deepEqual(upstreamItems(body(...lines)), [])
  })
})

describe('lntt pr block and lntt check body', () => {
  let tmp: string
  let stubs: string
  let repo: string

  function lntt(args: string[], input?: string) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      input,
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
    })
  }

  // A fake gh that records its arguments and prints the body, or fails.
  function gh(answer: string, status = 0): void {
    writeFileSync(
      join(stubs, 'gh'),
      `#!/bin/sh\necho "$*" > "${join(tmp, 'gh-args')}"\ncat <<'EOF'\n${answer}\nEOF\nexit ${status}\n`,
    )
    chmodSync(join(stubs, 'gh'), 0o755)
  }

  function ghArgs(): string {
    return readFileSync(join(tmp, 'gh-args'), 'utf8')
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-pr-')))
    stubs = join(tmp, 'bin')
    repo = join(tmp, 'repo')
    mkdirSync(stubs)
    mkdirSync(join(repo, '.agents'), { recursive: true })
    const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ delivery: { pullRequest: { retrospective } } }))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('lntt pr block prints the empty block of the configuration', () => {
    const r = lntt(['pr', 'block'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(
      r.stdout,
      '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->\n',
    )
  })

  test('lntt pr: a usage error exits 2', () => {
    assert.equal(lntt(['pr', 'block', 'more']).status, 2)
    assert.equal(lntt(['pr', 'check']).status, 2)
  })

  test('- reads the body on stdin: PASS when filled, a FAIL per problem', () => {
    const filled =
      '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** 1 round, 0.4M tokens, $0.52\n<!-- retro:end -->'
    const pass = lntt(['check', 'body', '-', '--json'], filled)
    assert.equal(pass.status, 0, pass.stderr)
    assert.deepEqual(JSON.parse(pass.stdout), {
      area: 'body',
      check: 'retrospective',
      status: 'PASS',
      path: null,
      line: null,
      message: 'stdin: every retrospective label is filled',
    })
    const r = lntt(['check', 'body', '-', '--json'], '<!-- retro:start -->\n- **Friction:** none\n<!-- retro:end -->')
    assert.equal(r.status, 1)
    assert.equal(JSON.parse(r.stdout).message, 'stdin: retrospective: no "Review cost" line in the block')
  })

  test("--pr reads that pull request with gh; with neither, the current branch's", () => {
    const body = '<!-- retro:start -->\n- **Friction:**\n- **Review cost:** none\n<!-- retro:end -->'
    gh(JSON.stringify({ number: 171, body, headRefName: 'feat/171/x' }))
    const r = lntt(['check', 'body', '--pr', '171'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /FAIL +body\/retrospective — pull request #171: retrospective: "Friction" is empty/)
    assert.equal(ghArgs(), 'pr view 171 --json number,body,headRefName\n')
    assert.equal(lntt(['check', 'body']).status, 1)
    assert.equal(ghArgs(), 'pr view --json number,body,headRefName\n')
  })

  test('a gh that fails is a check that cannot run: one line, exit 1, no stack', () => {
    gh('', 1)
    const r = lntt(['check', 'body'])
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^lntt: error: gh pr view --json number,body,headRefName failed\n$/)
  })

  function bodyResults(args: string[]) {
    const r = lntt([...args, '--json'])
    return r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.area === 'body')
      .map(({ check, status, path, message }) => ({ check, status, path, message }))
  }

  function template(text: string, path = '.github/pull_request_template.md'): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  const BLOCK = '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->\n'

  test('lntt check alone does not run the retrospective check, and says so; the template check runs', () => {
    template(`## Why\n\n${BLOCK}`)
    assert.deepEqual(bodyResults(['check']), [
      {
        check: 'retrospective',
        status: 'NOT RUN',
        path: null,
        message: 'no pull request body given: lntt check body [--pr <n> | -]',
      },
      {
        check: 'template',
        status: 'PASS',
        path: '.github/pull_request_template.md',
        message: 'the retrospective block is the one lntt pr block prints',
      },
    ])
  })

  test('template: a block that differs from the configuration fails, with the fix', () => {
    template(BLOCK.replace('- **Review cost:**\n', ''))
    assert.deepEqual(bodyResults(['check', 'body', 'template']), [
      {
        check: 'template',
        status: 'FAIL',
        path: '.github/pull_request_template.md',
        message: 'the retrospective block differs from the configuration: replace it with what lntt pr block prints',
      },
    ])
    template('## Why\n')
    assert.match(bodyResults(['check', 'body', 'template'])[0].message, /no retrospective block/)
  })

  test('template: at delivery.pullRequest.template, and NOT RUN when there is none', () => {
    assert.deepEqual(bodyResults(['check', 'body', 'template']), [
      {
        check: 'template',
        status: 'NOT RUN',
        path: '.github/pull_request_template.md',
        message: 'no pull request template',
      },
    ])
    const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { pullRequest: { template: 'docs/pr.md', retrospective } } }),
    )
    template(BLOCK, 'docs/pr.md')
    assert.equal(bodyResults(['check', 'body', 'template'])[0].status, 'PASS')
  })

  test('- checks only the body given, not the template', () => {
    template('no block')
    const filled = '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** none\n<!-- retro:end -->'
    const r = lntt(['check', 'body', '-'], filled)
    assert.equal(r.status, 0, r.stdout)
  })

  test('usage errors exit 2 and run no gh', () => {
    gh('unused')
    for (const args of [
      ['check', 'body', '--pr', 'abc'],
      ['check', 'body', '-', '--pr', '3'],
      ['check', 'body', 'foo'],
      ['check', 'body', 'template', '--pr', '3'],
      ['check', 'body', '-', '-'],
      ['check', 'body', '--prr', '3'],
      ['check', 'tests', '--pr', '3'],
    ]) {
      assert.equal(lntt(args).status, 2, args.join(' '))
    }
    assert.equal(existsSync(join(tmp, 'gh-args')), false)
  })
})
