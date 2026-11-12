import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type Ask,
  agentLabel,
  type Found,
  isNoFindings,
  lensApplies,
  mergeFindings,
  parseFindings,
  parseOutcome,
  parseWithdrawal,
  type ReviewState,
  type RoundCost,
  renderReviewPrompt,
  renderVerifyPrompt,
  reviewConfig,
  reviewCost,
  roundCosts,
  roundLimit,
  roundRange,
  runRound,
  TEST_PATHS,
  touchedLines,
  unreadableFindings,
  verdict,
  verifiersFor,
} from '../src/index.ts'

describe('the configuration', () => {
  test('default: decisions on haiku, code and tests on sonnet, verified on sonnet for blockers and warnings', () => {
    assert.deepEqual(reviewConfig({}), {
      reviewers: {
        decisions: { with: [{ kind: 'claude', model: 'haiku' }], brief: null, paths: [] },
        code: { with: [{ kind: 'claude', model: 'sonnet' }], brief: null, paths: [] },
        tests: { with: [{ kind: 'claude', model: 'sonnet' }], brief: null, paths: TEST_PATHS },
      },
      verify: { with: [{ kind: 'claude', model: 'sonnet' }], severities: ['blocker', 'warning'] },
      timeoutMinutes: 20,
      perProvider: 4,
      optionalGraceMinutes: 2,
      roundTimeoutMinutes: 60,
      maxRounds: 4,
      warningRounds: 2,
    })
  })

  test('read from delivery.review; a lens left out keeps its default, verify false turns it off', () => {
    const config = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            code: {
              with: [
                { kind: 'claude', model: 'opus' },
                { kind: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' },
              ],
            },
            story: {
              brief: '.claude/skills/story-check/SKILL.md',
              paths: ['packages/ui/**'],
              with: [{ kind: 'claude' }],
            },
          },
          verify: false,
          timeoutMinutes: 5,
          maxRounds: 7,
        },
      },
    })
    assert.deepEqual(config.reviewers.decisions?.with, [{ kind: 'claude', model: 'haiku' }])
    assert.equal(config.reviewers.code?.with.length, 2)
    assert.deepEqual(config.reviewers.story, {
      with: [{ kind: 'claude' }],
      brief: '.claude/skills/story-check/SKILL.md',
      paths: ['packages/ui/**'],
    })
    assert.equal(config.verify, null)
    assert.equal(config.timeoutMinutes, 5)
    assert.equal(config.maxRounds, 7)
  })

  test('a lens of the project needs its brief; a lens with no agents is off', () => {
    assert.throws(
      () => reviewConfig({ delivery: { review: { reviewers: { story: { with: [{ kind: 'claude' }] } } } } }),
      /story.*brief/,
    )
    const off = reviewConfig({ delivery: { review: { reviewers: { tests: { with: [] } } } } })
    assert.equal(off.reviewers.tests, undefined)
  })

  test('a lens runs only when the diff touches its paths', () => {
    assert.equal(lensApplies({ with: [], brief: null, paths: [] }, ['a.md']), true)
    assert.equal(lensApplies({ with: [], brief: null, paths: TEST_PATHS }, ['src/a.ts']), false)
    assert.equal(lensApplies({ with: [], brief: null, paths: TEST_PATHS }, ['src/a.ts', 'test/a.test.ts']), true)
    assert.equal(lensApplies({ with: [], brief: null, paths: ['packages/ui/**'] }, ['packages/ui/src/b.tsx']), true)
  })

  test('an agent label names the agent and its model', () => {
    assert.equal(agentLabel({ kind: 'claude', model: 'sonnet', effort: 'high' }), 'claude sonnet (high)')
    assert.equal(agentLabel({ kind: 'opencode', model: 'mistral/devstral' }), 'opencode mistral/devstral')
    assert.equal(agentLabel({ kind: 'claude' }), 'claude')
  })
})

describe('the findings a reviewer writes', () => {
  test('one line each: severity, anchor, what, action; anything else is ignored', () => {
    const text = [
      'I read the diff.',
      '- [blocker] src/a.ts:12 — the batch stops halfway — read every issue first',
      '- [note] (no anchor) — no ADR for the runner — write one',
      '- [warning] docs/x.md — a heading without a line — cite the anchor',
      '- [nit] src/a.ts:3 — not a severity — ignored',
    ].join('\n')
    assert.deepEqual(parseFindings(text), [
      {
        severity: 'blocker',
        path: 'src/a.ts',
        line: 12,
        what: 'the batch stops halfway',
        action: 'read every issue first',
      },
      { severity: 'note', path: null, line: null, what: 'no ADR for the runner', action: 'write one' },
      {
        severity: 'warning',
        path: 'docs/x.md',
        line: null,
        what: 'a heading without a line',
        action: 'cite the anchor',
      },
    ])
  })

  test('a plain hyphen also separates the fields; "no findings" is none', () => {
    assert.deepEqual(parseFindings('- [warning] a.ts:1 - x - y'), [
      { severity: 'warning', path: 'a.ts', line: 1, what: 'x', action: 'y' },
    ])
    assert.deepEqual(parseFindings('no findings'), [])
  })
})

describe('merging what several reviewers found', () => {
  const sonnet = { kind: 'claude', model: 'sonnet' }
  const deepseek = { kind: 'opencode', model: 'opencode/deepseek' }

  test('one finding per anchor, the higher severity, every reviewer that found it; by severity, then place', () => {
    const merged = mergeFindings([
      {
        lens: 'code',
        agent: sonnet,
        session: 's1',
        findings: [
          { severity: 'warning', path: 'b.ts', line: 4, what: 'w', action: 'a' },
          { severity: 'note', path: 'a.ts', line: 9, what: 'n', action: 'a' },
        ],
      },
      {
        lens: 'code',
        agent: deepseek,
        session: 'ses_2',
        findings: [{ severity: 'blocker', path: 'b.ts', line: 4, what: 'w, worse', action: 'a2' }],
      },
    ])
    assert.deepEqual(
      merged.map((f) => [f.id, f.severity, f.path, f.line, f.foundBy.map((b) => b.agent)]),
      [
        ['f1', 'blocker', 'b.ts', 4, ['claude sonnet', 'opencode opencode/deepseek']],
        ['f2', 'note', 'a.ts', 9, ['claude sonnet']],
      ],
    )
    assert.equal(merged[0]?.what, 'w, worse')
    assert.deepEqual(merged[0]?.foundBy[1], { lens: 'code', agent: 'opencode opencode/deepseek', session: 'ses_2' })
  })

  test('findings without an anchor are kept apart, never merged with each other', () => {
    const none = { severity: 'note' as const, path: null, line: null, action: 'a' }
    const merged = mergeFindings([
      {
        lens: 'decisions',
        agent: sonnet,
        session: 's',
        findings: [
          { ...none, what: 'x' },
          { ...none, what: 'y' },
        ],
      },
    ])
    assert.equal(merged.length, 2)
  })
})

describe('the adversarial check', () => {
  const sonnet = { kind: 'claude', model: 'sonnet' }
  const mistral = { kind: 'opencode', model: 'mistral/devstral' }
  const found = (by: string[]): Found => ({
    id: 'f1',
    severity: 'blocker',
    path: 'a.ts',
    line: 1,
    what: 'w',
    action: 'a',
    foundBy: by.map((agent) => ({ lens: 'code', agent, session: 's' })),
  })

  test('every verifier but the agents that found it; the same agent only when no other is listed', () => {
    assert.deepEqual(verifiersFor(found(['claude sonnet']), [sonnet, mistral]), [mistral])
    assert.deepEqual(verifiersFor(found(['opencode x/y']), [sonnet, mistral]), [sonnet, mistral])
    assert.deepEqual(verifiersFor(found(['claude sonnet']), [sonnet]), [sonnet])
  })

  test('a verifier answers confirmed, refuted or undecided on its first line, then the proof', () => {
    assert.deepEqual(parseOutcome('confirmed\nsrc/a.ts:3 reads the base first'), {
      outcome: 'confirmed',
      proof: 'src/a.ts:3 reads the base first',
    })
    assert.deepEqual(parseOutcome('**Refuted.**\nline 9 guards it'), { outcome: 'refuted', proof: 'line 9 guards it' })
    assert.deepEqual(parseOutcome('I think it is fine'), { outcome: 'undecided', proof: 'I think it is fine' })
  })

  test('all confirm: confirmed; all refute: refuted; split, failed or none: undecided', () => {
    assert.equal(verdict(['confirmed', 'confirmed']), 'confirmed')
    assert.equal(verdict(['refuted', 'refuted']), 'refuted')
    assert.equal(verdict(['confirmed', 'refuted']), 'undecided')
    assert.equal(verdict(['confirmed', 'undecided']), 'undecided')
    assert.equal(verdict([]), 'undecided')
  })

  test('a reviewer answering the author: withdrawn or kept on the first line', () => {
    assert.deepEqual(parseWithdrawal('Withdrawn\nline 120 excludes it'), {
      withdrawn: true,
      reason: 'line 120 excludes it',
    })
    assert.deepEqual(parseWithdrawal('kept\nthe guard is after the call'), {
      withdrawn: false,
      reason: 'the guard is after the call',
    })
  })
})

describe('what a round reads', () => {
  const ancestor = (yes: boolean) => () => yes

  test('the first round: the whole branch from where it left the base', () => {
    assert.deepEqual(roundRange(null, 'feat/1/x', 'h2', 'mb', ancestor(true)), {
      round: 1,
      from: 'mb',
      whole: true,
      reason: 'first round',
    })
  })

  test('a later round: only what came after the last reviewed commit', () => {
    const state = { branch: 'feat/1/x', round: 2, reviewed: 'h1' } as ReviewState
    assert.deepEqual(roundRange(state, 'feat/1/x', 'h2', 'mb', ancestor(true)), {
      round: 3,
      from: 'h1',
      whole: false,
      reason: 'the delta since h1',
    })
  })

  test('after a round where a reviewer failed on the first read, the whole branch again', () => {
    const state = { branch: 'feat/1/x', round: 1, reviewed: null } as ReviewState
    const range = roundRange(state, 'feat/1/x', 'h2', 'mb', () => true)
    assert.deepEqual([range.round, range.from, range.whole], [2, 'mb', true])
  })

  test('after a rebase, or on another branch, the whole branch again', () => {
    const state = { branch: 'feat/1/x', round: 2, reviewed: 'h1' } as ReviewState
    assert.equal(roundRange(state, 'feat/1/x', 'h2', 'mb', ancestor(false)).whole, true)
    assert.match(roundRange(state, 'feat/1/x', 'h2', 'mb', ancestor(false)).reason, /h1 is no longer in the branch/)
    assert.equal(roundRange(state, 'feat/2/y', 'h2', 'mb', ancestor(true)).round, 1)
  })
})

describe('the prompt', () => {
  test('the lens brief with the range, the files and the diff filled in', () => {
    const prompt = renderReviewPrompt('code', {
      base: 'mb',
      head: 'h2',
      files: ['a.ts', 'b.ts'],
      diff: 'DIFF',
      records: 'RECORDS',
    })
    assert.match(prompt, /mb\.\.h2/)
    assert.match(prompt, /a\.ts\nb\.ts|- a\.ts\n- b\.ts/)
    assert.match(prompt, /DIFF/)
    assert.match(prompt, /\[blocker\|warning\|note\]/)
    assert.match(prompt, /read-only|only read/i)
    assert.doesNotMatch(prompt, /\{\{/)
  })

  test('the decisions lens gets the records to check against', () => {
    const prompt = renderReviewPrompt('decisions', { base: 'mb', head: 'h', files: [], diff: '', records: 'RECORDS' })
    assert.match(prompt, /RECORDS/)
  })

  test('a lens with an area of lntt check gets its results; another lens nothing of them', () => {
    const values = {
      base: 'mb',
      head: 'h',
      files: [],
      diff: '',
      records: 'R',
      checks: { decisions: '{"status":"FAIL"}' },
    }
    const decisions = renderReviewPrompt('decisions', values)
    assert.match(decisions, /lntt check decisions --base mb --json/)
    assert.match(decisions, /\{"status":"FAIL"\}/)
    assert.doesNotMatch(renderReviewPrompt('code', values), /lntt check|"status"/)
    assert.doesNotMatch(renderReviewPrompt('code', values), /\{\{/)
  })

  // Before production some findings are noise: the reviewer and the verifier read one
  // list of what is not a finding yet and of what holds anyway
  // (agents/review/before-production.md).
  describe("the project's phase", () => {
    const values = (phase?: 'development' | 'production') => ({
      base: 'mb',
      head: 'h',
      files: ['a.ts'],
      diff: 'DIFF',
      records: 'R',
      ...(phase === undefined ? {} : { phase }),
    })
    const found: Found = { id: 'f1', severity: 'warning', path: 'a.ts', line: 1, what: 'w', action: 'a', foundBy: [] }
    const relaxed =
      /## Before production[\s\S]*Not a finding yet[\s\S]*Migrations[\s\S]*Redirects[\s\S]*Backward compatibility[\s\S]*rewrite[\s\S]*Findings anyway[\s\S]*Security[\s\S]*Tests[\s\S]*decision records[\s\S]*asks for one of the items above[\s\S]*still holds: a change against it is a\s+finding/

    test('in development every lens and the verifier read what is not a finding yet and what holds anyway', () => {
      for (const lens of ['decisions', 'code', 'tests']) {
        const prompt = renderReviewPrompt(lens, values('development'))
        assert.match(prompt, relaxed, lens)
        assert.doesNotMatch(prompt, /\{\{/, lens)
      }
      assert.match(renderReviewPrompt('code', values('development'), 'A brief of the project.'), relaxed)
      assert.match(renderVerifyPrompt(found, values('development')), relaxed)
      // The section ends before what follows it, a blank line apart.
      assert.match(renderReviewPrompt('code', values('development')), /phase\.\n\n## How to answer/)
      assert.match(renderVerifyPrompt(found, values('development')), /phase\.\n\nYou can only read/)
    })

    test('in production, or with no phase, nothing of it is in a prompt', () => {
      for (const phase of ['production', undefined] as const) {
        assert.doesNotMatch(renderReviewPrompt('code', values(phase)), /Before production|\{\{/, String(phase))
        assert.doesNotMatch(renderVerifyPrompt(found, values(phase)), /Before production|\{\{/, String(phase))
      }
    })
  })
})

describe('what the first real round taught', () => {
  test('a column, an en-dash range or a list of lines names the first line', () => {
    assert.deepEqual(
      parseFindings('- [note] a.ts:12:5 — x — y\n- [note] b.ts:3–7 — x — y\n- [note] c.ts:4,9 — x — y').map((f) => [
        f.path,
        f.line,
      ]),
      [
        ['a.ts', 12],
        ['b.ts', 3],
        ['c.ts', 4],
      ],
    )
  })

  test('a range of lines names its first; a parenthesis after the anchor is not the finding', () => {
    const text = '- [blocker] `.agents/config.jsonc:54-72` (`delivery.review`) — off — restore'
    assert.equal(unreadableFindings(text), 0)
    assert.deepEqual(
      parseFindings(text).map((f) => [f.path, f.line, f.what, f.action]),
      [['.agents/config.jsonc', 54, 'off', 'restore']],
    )
  })

  test('an anchor in backticks or bold is read as the anchor', () => {
    assert.deepEqual(
      parseFindings('- [warning] `src/a.ts:12` — x — y\n- **[blocker]** **b.ts:3** — z — w').map((f) => [
        f.severity,
        f.path,
        f.line,
      ]),
      [
        ['warning', 'src/a.ts', 12],
        ['blocker', 'b.ts', 3],
      ],
    )
  })

  test('the verdict word on a line of its own or followed by the proof on the same line', () => {
    assert.deepEqual(parseOutcome('refuted: a.ts:2 guards it'), { outcome: 'refuted', proof: 'a.ts:2 guards it' })
    assert.deepEqual(parseOutcome('Confirmed — line 9 drops the id\nmore'), {
      outcome: 'confirmed',
      proof: 'line 9 drops the id\nmore',
    })
    assert.deepEqual(parseWithdrawal('withdrawn — line 120 excludes it'), {
      withdrawn: true,
      reason: 'line 120 excludes it',
    })
    assert.equal(parseOutcome('confirmedly not').outcome, 'undecided')
  })

  test('only an explicit "no findings" is none; a reply in another shape is not a clean review', () => {
    assert.equal(isNoFindings('no findings'), true)
    assert.equal(isNoFindings('  **No findings.**  '), true)
    assert.equal(isNoFindings(''), false)
    assert.equal(isNoFindings('The change looks fine to me.'), false)
  })

  const one = reviewConfig({
    delivery: {
      review: {
        reviewers: {
          decisions: { with: [] },
          tests: { with: [] },
          code: { with: [{ kind: 'claude', model: 'sonnet' }] },
        },
        verify: { with: [{ kind: 'claude', model: 'opus' }] },
      },
    },
  })
  const input = {
    base: 'mb',
    head: 'h2',
    files: ['a.ts'],
    diff: 'D',
    records: '',
    range: roundRange(null, 'b', 'h2', 'mb', () => true),
  }
  const reviewerFirst = (prompt: string) => (prompt.split('\n')[0] as string).includes('Lens:')
  function ask(answer: (prompt: string) => string | Error): Ask {
    return async (questions) =>
      questions.map((q) => {
        const a = answer(q.prompt)
        return a instanceof Error
          ? { ok: false as const, error: a.message }
          : { ok: true as const, reply: { text: a, session: 's', cost: null, tokens: null } }
      })
  }

  test('the reply that showed the problem in #170: all thirteen lines read, none dropped', async () => {
    const reply = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures/review-reply-decisions-170.txt'),
      'utf8',
    )
    assert.equal(unreadableFindings(reply), 0)
    const found = parseFindings(reply)
    assert.equal(found.length, 13)
    assert.deepEqual(
      found.slice(1, 2).map((f) => [f.path, f.line, f.what.endsWith('(also :34-37)')]),
      [['docs/adr/lntt-command.md', 24, true]],
    )
    assert.deepEqual(
      found.slice(-1).map((f) => [f.severity, f.path]),
      [['note', null]],
    )
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
    )
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.partial, [])
    assert.equal(result.findings.length, 13)
  })

  test("two reviewers at the same anchor and severity: the first one's words stay", () => {
    const sonnet = { kind: 'claude', model: 'sonnet' }
    const opus = { kind: 'claude', model: 'opus' }
    const merged = mergeFindings(
      [
        {
          lens: 'code',
          agent: sonnet,
          session: 's',
          findings: [{ severity: 'warning', path: 'a.ts', line: 1, what: 'first', action: 'a' }],
        },
        {
          lens: 'code',
          agent: opus,
          session: 'o',
          findings: [{ severity: 'warning', path: 'a.ts', line: 1, what: 'second', action: 'b' }],
        },
      ],
      4,
    )
    assert.deepEqual(
      merged.map((f) => [f.id, f.what, f.foundBy.length]),
      [['f5', 'first', 2]],
    )
  })
})

describe('what the third real round taught', () => {
  const sonnet = { kind: 'claude', model: 'sonnet' }
  const glm = { kind: 'opencode', model: 'opencode/glm', optional: true }
  const found = (by: string): Found => ({
    id: 'f1',
    severity: 'warning',
    path: 'a.ts',
    line: 1,
    what: 'w',
    action: 'a',
    foundBy: [{ lens: 'code', agent: by, session: 's' }],
  })

  test('a finding always has a required verifier: the finder itself when the others are optional', () => {
    assert.deepEqual(verifiersFor(found('claude sonnet'), [sonnet, glm]), [glm, sonnet])
    assert.deepEqual(verifiersFor(found('opencode opencode/deepseek'), [sonnet, glm]), [sonnet, glm])
  })
})

describe('what the fourth real round taught', () => {
  test('a finding wrapped over several lines is one finding', () => {
    const text = [
      '- [warning] packages/lntt/src/review.ts:195 — `verifiersFor` returns the finders',
      '  when every other verifier is optional, which the comment',
      '  does not say — say it in the comment',
      '- [note] a.ts:1 — short — fix',
    ].join('\n')
    assert.deepEqual(
      parseFindings(text).map((f) => [f.path, f.line, f.what, f.action]),
      [
        [
          'packages/lntt/src/review.ts',
          195,
          '`verifiersFor` returns the finders when every other verifier is optional, which the comment does not say',
          'say it in the comment',
        ],
        ['a.ts', 1, 'short', 'fix'],
      ],
    )
  })

  test('a finding line that cannot be read makes the reply unreadable, even beside readable ones', () => {
    assert.equal(unreadableFindings('- [warning] a.ts:1 — x — y\n- [blocker] something went wrong'), 1)
    assert.equal(unreadableFindings('- [warning] a.ts:1 — x — y\nSome closing words.'), 0)
  })

  test('a finding line may name several places: the first is the anchor, the others go with the finding', () => {
    const lines = [
      '- [warning] a.md:24-32 e :34-37 — what — act',
      '- [warning] a.md:24-32, :34-37 — what — act',
      '- [warning] a.md:24-32 and b.md:2 — what — act',
      '- [warning] `a.md:24-32` e `:34-37` — what — act',
    ]
    for (const line of lines) assert.equal(unreadableFindings(line), 0, line)
    assert.deepEqual(
      parseFindings(lines.join('\n')).map((f) => [f.path, f.line, f.what, f.action]),
      [
        ['a.md', 24, 'what (also :34-37)', 'act'],
        ['a.md', 24, 'what (also :34-37)', 'act'],
        ['a.md', 24, 'what (also b.md:2)', 'act'],
        ['a.md', 24, 'what (also :34-37)', 'act'],
      ],
    )
  })

  test('an anchor between backticks is read whole, spaces included, and the places after it still are', () => {
    const lines = [
      '- [warning] `a dir/b c.md:3` — what — act',
      '- [warning] `a dir/b c.md:3` e `x y.md:5` — what — act',
      '- [warning] [pre-existing] `docs/my notes.md:12` (the intro) — what — act',
      '- [warning] `a - b.md:7` — what — act',
      '- [warning] `a b.md:1`, `c d.md:2` — what — act',
      '- [warning] **`e f.md:4`** — what — act',
    ]
    for (const line of lines) assert.equal(unreadableFindings(line), 0, line)
    assert.deepEqual(
      parseFindings(lines.join('\n')).map((f) => [f.path, f.line, f.what, f.action]),
      [
        ['a dir/b c.md', 3, 'what', 'act'],
        ['a dir/b c.md', 3, 'what (also x y.md:5)', 'act'],
        ['docs/my notes.md', 12, 'what', 'act'],
        ['a - b.md', 7, 'what', 'act'],
        ['a b.md', 1, 'what (also c d.md:2)', 'act'],
        ['e f.md', 4, 'what', 'act'],
      ],
    )
    for (const f of parseFindings(lines.join('\n'))) {
      for (const field of [f.path, f.what, f.action]) assert.equal(field?.includes('\u0000'), false, field ?? '')
    }
  })

  test('a backtick that does not open a span at a word start masks nothing', () => {
    const lines = [
      '- [warning] a.md:3` — what `x` — act',
      '- [warning] a.md:3 — the `x y — act',
      '- [warning] a.md:3 — the `` and `x y` — act',
      '- [warning] `a.ts:3` — use `a - b` — act',
      // a star glued to a word counts as a bold star: the span may be masked, and the finding reads the same
      '- [warning] a.md:3 — 2*`x y` — act',
    ]
    assert.deepEqual(
      parseFindings(lines.join('\n')).map((f) => [f.path, f.line, f.what, f.action]),
      [
        ['a.md', 3, 'what `x`', 'act'],
        ['a.md', 3, 'the `x y', 'act'],
        ['a.md', 3, 'the `` and `x y`', 'act'],
        ['a.ts', 3, 'use `a - b`', 'act'],
        ['a.md', 3, '2*`x y`', 'act'],
      ],
    )
  })

  test('a line with no path-like token before the separator is a finding with no anchor', () => {
    const line = '- [note] not checked: needs `pnpm ci:local --list`. Verify the step — it was not run.'
    assert.equal(unreadableFindings(line), 0)
    assert.deepEqual(
      parseFindings(line).map((f) => [f.severity, f.path, f.line, f.what, f.action]),
      [['note', null, null, 'not checked: needs `pnpm ci:local --list`. Verify the step', 'it was not run.']],
    )
  })

  test('a head with one token that is no place has no anchor', () => {
    assert.deepEqual(
      parseFindings('- [blocker] something — x — y').map((f) => [f.path, f.what, f.action]),
      [[null, 'something — x', 'y']],
    )
  })

  test('a `not checked:` note with no separator is a finding with no anchor; other lines with none stay unreadable', () => {
    const line = '- [note] not checked: needs `pnpm ci:local --list`. Verify the step.'
    assert.equal(unreadableFindings(line), 0)
    assert.deepEqual(
      parseFindings(line).map((f) => [f.path, f.what, f.action]),
      [[null, 'not checked: needs `pnpm ci:local --list`. Verify the step.', '']],
    )
    assert.equal(unreadableFindings('- [note] checked it, all fine'), 1)
  })
})

describe('what the fifth real round taught', () => {
  test('a finding whose action follows a semicolon, or has none, is still a finding', () => {
    assert.deepEqual(
      parseFindings('- [note] a.ts:3 — the guard is untested; add a case').map((f) => [f.what, f.action]),
      [['the guard is untested; add a case', '']],
    )
    assert.deepEqual(
      parseFindings('- [warning] a.ts:3 — x — y — z').map((f) => [f.what, f.action]),
      [['x — y', 'z']],
    )
  })

  test('only a line with no anchor or no separator is unreadable', () => {
    assert.equal(unreadableFindings('- [warning] something is off'), 1)
    assert.equal(unreadableFindings('- [warning] a.ts:1 — something is off'), 0)
  })

  test('the reply a real reviewer gave in round 5 reads whole: eleven findings', () => {
    const reply = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures/review-reply-round5-tests.txt'),
      'utf8',
    )
    assert.equal(unreadableFindings(reply), 0)
    assert.equal(parseFindings(reply).length, 11)
  })
})

describe('how many rounds a branch may take', () => {
  const state = { branch: 'feat/1/x', round: 4, reviewed: 'h1' } as ReviewState

  test('delivery.review.maxRounds, with no rounds allowed on the branch', () => {
    assert.equal(roundLimit(null, 'feat/1/x', 4), 4)
    assert.equal(roundLimit(state, 'feat/1/x', 4), 4)
  })

  test('plus the rounds a person allowed on this branch, and only on it', () => {
    const allowed = { ...state, allowed: 2 }
    assert.equal(roundLimit(allowed, 'feat/1/x', 4), 6)
    assert.equal(roundLimit(allowed, 'feat/2/y', 4), 4)
  })
})

describe('what the branch already closed, and the rounds where a warning blocks', () => {
  test('warningRounds is read from delivery.review, and is 2 by default', () => {
    assert.equal(reviewConfig({}).warningRounds, 2)
    assert.equal(reviewConfig({ delivery: { review: { warningRounds: 5 } } }).warningRounds, 5)
  })
})

// A finding on a line the branch did not write, which the change does not contradict: the
// reviewer marks it, lntt keeps the mark only on a line the branch left untouched.
describe('a pre-existing finding', () => {
  test('the reviewer marks it after the severity; a line without the mark is read as before', () => {
    const [marked, plain] = parseFindings(
      '- [warning] [pre-existing] docs/adr/x.md:51 — Orca 1.2 is stale — update it\n- [warning] a.ts:3 — w — a',
    )
    assert.deepEqual(marked, {
      severity: 'warning',
      path: 'docs/adr/x.md',
      line: 51,
      what: 'Orca 1.2 is stale',
      action: 'update it',
      preexisting: true,
    })
    assert.equal(plain?.preexisting, undefined)
    assert.equal(parseFindings('- **[blocker]** [Pre-existing] `a.ts:2` — b — a')[0]?.preexisting, true)
    assert.deepEqual(parseFindings('- [pre-existing] a.ts:1 — w — a'), [], 'the mark is no severity')
  })
  test('two reviewers at one anchor: pre-existing only when both mark it', () => {
    const agent = { kind: 'claude', model: 'haiku' } as const
    const merged = mergeFindings([
      { lens: 'code', agent, session: null, findings: parseFindings('- [warning] [pre-existing] a.ts:9 — w — a') },
      { lens: 'decisions', agent, session: null, findings: parseFindings('- [warning] a.ts:9 — w — a') },
    ])
    assert.equal(merged[0]?.preexisting, undefined)
    const both = mergeFindings([
      { lens: 'code', agent, session: null, findings: parseFindings('- [note] [pre-existing] a.ts:9 — w — a') },
      { lens: 'decisions', agent, session: null, findings: parseFindings('- [warning] [pre-existing] a.ts:9 — w — a') },
    ])
    assert.deepEqual([both[0]?.preexisting, both[0]?.severity], [true, 'warning'])
  })
})

describe('the library runRound', () => {
  test('runs the round on its Promise asks, its brief and its cited lines, and rejects with what any of them threw', async () => {
    const config = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            tests: { with: [] },
            code: { with: [] },
            story: { brief: 'b.md', with: [{ kind: 'claude', model: 'haiku' }] },
          },
          verify: false,
        },
      },
    })
    const briefs: string[] = []
    const input = {
      base: 'mb',
      head: 'h',
      files: ['a.ts'],
      diff: 'D',
      records: '',
      range: roundRange(null, 'b', 'h', 'mb', () => true),
      readBrief: (path: string) => {
        briefs.push(path)
        return 'Tell the story of the change.'
      },
      cite: (path: string, line: number | null) => ({ text: `${path}:${line} reads x` }),
    }
    const ask: Ask = async (qs) => {
      await Promise.resolve()
      return qs.map((q) => ({
        ok: true as const,
        reply: {
          text: q.prompt.includes('Tell the story of the change.') ? '- [warning] a.ts:3 — w — a' : 'no findings',
          session: 's',
          cost: null,
          tokens: null,
        },
      }))
    }
    const result = await runRound(config, input, ask)
    assert.deepEqual(briefs, ['b.md'], 'the brief of the project lens is read through readBrief')
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.foundBy[0]?.lens, f.path, f.line, f.cited]),
      [['f1', 'story', 'a.ts', 3, 'a.ts:3 reads x']],
    )
    const down = new Error('the agent is down')
    await assert.rejects(
      runRound(config, input, async () => {
        throw down
      }),
      (error) => error === down,
    )
    const unreadable = new Error('EACCES: b.md')
    const blocked = {
      ...input,
      readBrief: () => {
        throw unreadable
      },
    }
    await assert.rejects(runRound(config, blocked, ask), (error) => error === unreadable)
    const gone = new Error('EIO: a.ts')
    const uncited = {
      ...input,
      cite: () => {
        throw gone
      },
    }
    await assert.rejects(runRound(config, uncited, ask), (error) => error === gone)
  })
})

describe('the lines a branch wrote', () => {
  test('the new side of each hunk of a diff with no context, by file; a deletion writes none', () => {
    const touched = touchedLines(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '@@ -5,0 +6,2 @@',
        '+p',
        '+++ an added line that reads like a header',
        '@@ -20,3 +21,0 @@',
        '-gone',
        // A header with no `+++` (a rename, a binary file) names no file: a hunk after it is no a.ts line.
        'diff --git a/old.bin b/moved.bin',
        'similarity index 100%',
        '@@ -1 +40 @@',
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1,3 @@',
        '+1',
        '+2',
        '+3',
        'diff --git a/gone.ts b/gone.ts',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-z',
        // As git writes them: a path with a space ends with a tab, one with a quote is quoted.
        'diff --git a/sp ace.md b/sp ace.md',
        '--- a/sp ace.md\t',
        '+++ b/sp ace.md\t',
        '@@ -2 +2 @@',
        '-a',
        '+b',
        'diff --git "a/q\\"t.md" "b/q\\"t.md"',
        '--- "a/q\\"t.md"',
        '+++ "b/q\\"t.md"',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ].join('\n'),
    ) as Map<string, Set<number>>
    const untouched = (path: string, line: number) => !touched.get(path)?.has(line)
    assert.deepEqual([...(touched.get('a.ts') ?? [])], [1, 6, 7])
    assert.deepEqual([...(touched.get('new.md') ?? [])], [1, 2, 3])
    assert.deepEqual([...(touched.get('sp ace.md') ?? [])], [2])
    assert.deepEqual([...(touched.get('q"t.md') ?? [])], [1])
    assert.deepEqual([...touched.keys()], ['a.ts', 'new.md', 'sp ace.md', 'q"t.md'])
    assert.equal(untouched('a.ts', 2), true)
    assert.equal(untouched('other.ts', 1), true)
  })

  test('a header it cannot read, or with another prefix, makes the diff unreadable: no line is untouched', () => {
    assert.equal(touchedLines('diff --git "a/x" "b/x"\n--- "a/x\n+++ "b/\\q"\n@@ -1 +1 @@'), null)
    assert.equal(touchedLines('diff --git x x\n--- x\n+++ x\n@@ -1 +1 @@'), null)
  })
})

describe("the cost of a branch's rounds", () => {
  const cost = (
    round: number,
    tokens: number | null,
    usd: number | null,
    more: Partial<RoundCost> = {},
  ): RoundCost => ({
    round,
    head: `h${round}`,
    tokens,
    usd,
    noTokens: [],
    noUsd: [],
    ...more,
  })

  test('the rounds, their tokens and their USD summed, exact in the object', () => {
    const total = reviewCost([cost(1, 212_340, 0.611), cost(2, 200_000, 0.62)])
    assert.deepEqual(total, {
      rounds: 2,
      tokens: 412_340,
      usd: 1.231,
      noTokens: [],
      noUsd: [],
      unrecorded: [],
      line: '2 rounds, 412.3k tokens, 1.23 USD',
    })
    assert.equal(reviewCost([cost(1, 1500, 0.01)]).line, '1 round, 1.5k tokens, 0.01 USD')
    // Rounds of a state saved before the rounds were kept: named, never counted as free.
    const late = reviewCost([cost(3, 1500, 0.01)])
    assert.deepEqual(late.unrecorded, [1, 2])
    assert.equal(late.line, '1 round, 1.5k tokens, 0.01 USD; not recorded: rounds 1, 2')
    assert.equal(reviewCost([cost(2, 1500, 0.01)]).line, '1 round, 1.5k tokens, 0.01 USD; not recorded: round 1')
    assert.deepEqual(reviewCost([cost(1, 1500, 0.01), cost(3, 1500, 0.01)]).unrecorded, [2])
    assert.equal(reviewCost([], 2).line, 'no rounds; not recorded: rounds 1, 2')
    assert.equal(reviewCost([cost(1, 2_000_000, 3)]).line, '1 round, 2M tokens, 3.00 USD')
  })

  test('the rounds with agents that reported no USD or no tokens, each with its agents', () => {
    const total = reviewCost([
      cost(1, 1000, 0.5),
      cost(2, 1000, 0.25, { noUsd: ['opencode opencode/x', 'claude opus'] }),
      cost(3, null, 0.25, { noTokens: ['codex gpt'], noUsd: ['codex gpt'] }),
    ])
    assert.deepEqual([total.noTokens, total.noUsd], [[3], [2, 3]])
    assert.equal(
      total.line,
      '3 rounds, 2k tokens, 1.00 USD; no tokens: round 3 (codex gpt); no USD: round 2 (opencode opencode/x, claude opus), round 3 (codex gpt)',
    )
  })

  test('no round reporting any tokens or USD: said in place of the figure', () => {
    const total = reviewCost([cost(1, null, null, { noTokens: ['a'], noUsd: ['a'] })])
    assert.deepEqual([total.tokens, total.usd], [null, null])
    assert.equal(total.line, '1 round, no tokens, no USD; no tokens: round 1 (a); no USD: round 1 (a)')
  })

  test('no rounds', () => {
    assert.deepEqual(reviewCost([]), {
      rounds: 0,
      tokens: null,
      usd: null,
      noTokens: [],
      noUsd: [],
      unrecorded: [],
      line: 'no rounds',
    })
  })

  test('a round that read files adds its cost to the branch; an empty delta adds none; another branch starts over', () => {
    const result = (head: string, tokens: number | null, cost: number | null) =>
      ({ head, tokens, cost, noTokens: ['x'], noUsd: [] }) as unknown as Parameters<typeof roundCosts>[2]
    const first = roundCosts(null, 'b', result('h1', 1500, 0.01), 1, true)
    assert.deepEqual(first, [{ round: 1, head: 'h1', tokens: 1500, usd: 0.01, noTokens: ['x'], noUsd: [] }])
    const state = { branch: 'b', rounds: first } as unknown as ReviewState
    assert.deepEqual(roundCosts(state, 'b', result('h1', null, null), 1, false), first)
    assert.deepEqual(
      roundCosts(state, 'b', result('h2', 3000, 0.02), 2, true).map((r) => r.round),
      [1, 2],
    )
    assert.deepEqual(
      roundCosts(state, 'c', result('h3', 10, 0.1), 1, true).map((r) => r.head),
      ['h3'],
    )
    assert.deepEqual(roundCosts({ branch: 'b' } as ReviewState, 'b', result('h2', 1, 1), 2, false), [])
  })
})
