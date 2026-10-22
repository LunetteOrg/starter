import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkBody, retrospectiveBlock, retrospectiveRules } from '../src/pull-request.ts'

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
    assert.deepEqual(rules, { heading: '🔁 Retrospective', lines: ['Attrito', 'Causa di rilavoro'], none: 'nessuno' })
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

  test('a missing label is named', () => {
    assert.deepEqual(checkBody(body(...FILLED.slice(0, 3)), DEFAULTS), [
      'retrospective: no "Rework cause" line in the block',
    ])
  })

  test('a body without the markers says the block is missing', () => {
    assert.deepEqual(checkBody('## Why\n\nBecause.\n', DEFAULTS), [
      'retrospective: no <!-- retro:start --> … <!-- retro:end --> block in the body',
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

describe('lntt pr', () => {
  let tmp: string
  let stubs: string
  let repo: string

  function lntt(args: string[], input?: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [BIN, 'pr', ...args], {
      cwd: repo,
      encoding: 'utf8',
      input,
      env: { ...process.env, GITHUB_ACTIONS: '', PATH: `${stubs}:${process.env.PATH}`, ...env },
    })
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-pr-')))
    stubs = join(tmp, 'bin')
    repo = join(tmp, 'repo')
    mkdirSync(stubs)
    mkdirSync(join(repo, '.agents'), { recursive: true })
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { pullRequest: { retrospective: { lines: ['Friction', 'Review cost'] } } } }),
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('block prints the empty block of the configuration', () => {
    const r = lntt(['block'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(
      r.stdout,
      '## 🔁 Retrospective\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->\n',
    )
  })

  test('check - reads the body on stdin: exit 0 when filled, 1 with each problem', () => {
    const filled =
      '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** 1 round, 0.4M tokens, $0.52\n<!-- retro:end -->'
    assert.equal(lntt(['check', '-'], filled).status, 0)
    const r = lntt(['check', '-'], '<!-- retro:start -->\n- **Friction:** none\n<!-- retro:end -->')
    assert.equal(r.status, 1)
    assert.equal(r.stderr, 'lntt pr: retrospective: no "Review cost" line in the block\n')
  })

  test('in GitHub Actions each problem is a warning annotation', () => {
    const r = lntt(['check', '-'], 'no block', { GITHUB_ACTIONS: 'true' })
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^::warning title=Pull request body::retrospective: no <!-- retro:start -->/)
  })

  test('check --pr reads the body of that pull request with gh', () => {
    const answer = '<!-- retro:start -->\n- **Friction:**\n- **Review cost:** none\n<!-- retro:end -->'
    writeFileSync(join(stubs, 'gh'), `#!/bin/sh\necho "$*" > "${join(tmp, 'gh-args')}"\ncat <<'EOF'\n${answer}\nEOF\n`)
    chmodSync(join(stubs, 'gh'), 0o755)
    const r = lntt(['check', '--pr', '171'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /"Friction" is empty/)
    assert.equal(
      spawnSync('cat', [join(tmp, 'gh-args')], { encoding: 'utf8' }).stdout,
      'pr view 171 --json body --jq .body\n',
    )
  })

  test('a usage error exits 2', () => {
    assert.equal(lntt(['check', '--pr', 'abc']).status, 2)
    assert.equal(lntt(['nothing']).status, 2)
  })
})
