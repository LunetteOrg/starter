import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type Ask,
  agentLabel,
  type Checked,
  type Closed,
  closeRound,
  type Found,
  isNoFindings,
  lensApplies,
  mergeFindings,
  parseFindings,
  parseOutcome,
  parseWithdrawal,
  type ReviewState,
  renderReviewPrompt,
  reviewConfig,
  reviewedAfter,
  roundClean,
  roundLimit,
  roundRange,
  runRound,
  type Severity,
  TEST_PATHS,
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
})

describe('a round', () => {
  // A reviewer's prompt names its lens on the first line; a verifier's never does.
  const isLens = (prompt: string, lens = '') => (prompt.split('\n')[0] as string).includes(`Lens: ${lens}`)
  // Answers by who is asked: the lens brief names its lens, the verify brief its finding.
  function asker(answers: (prompt: string, kind: string, model?: string) => string | Error): {
    ask: Ask
    asked: string[]
    labels: string[]
  } {
    const asked: string[] = []
    const labels: string[] = []
    const ask: Ask = async (jobs) =>
      jobs.map((job) => {
        asked.push(`${agentLabel(job.agent)}${job.session ? ` resumes ${job.session}` : ''}`)
        labels.push(job.label ?? '')
        const answer = answers(job.prompt, job.agent.kind, job.agent.model)
        return answer instanceof Error
          ? { ok: false as const, error: answer.message }
          : { ok: true as const, reply: { text: answer, session: `s-${job.agent.model}`, cost: 0.01, tokens: 1000 } }
      })
    return { ask, asked, labels }
  }

  const config = reviewConfig({
    delivery: {
      review: {
        reviewers: {
          decisions: { with: [{ kind: 'claude', model: 'haiku' }] },
          code: {
            with: [
              { kind: 'claude', model: 'sonnet' },
              { kind: 'claude', model: 'opus' },
            ],
          },
          tests: { with: [{ kind: 'claude', model: 'haiku' }] },
        },
        verify: {
          with: [
            { kind: 'claude', model: 'sonnet' },
            { kind: 'claude', model: 'opus' },
          ],
        },
      },
    },
  })
  const input = {
    base: 'mb',
    head: 'h2',
    files: ['a.ts'],
    diff: 'DIFF',
    records: 'R',
    range: roundRange(null, 'b', 'h2', 'mb', () => true),
  }

  test('reviewers in parallel, then each blocker or warning verified by the others, notes left unverified', async () => {
    const { ask, asked, labels } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'decisions')) return 'no findings'
      if (isLens(prompt, 'code') && model === 'sonnet')
        return '- [blocker] a.ts:1 — breaks — fix\n- [note] a.ts:5 — wording — reword'
      if (isLens(prompt, 'code')) return 'no findings'
      return 'confirmed\na.ts:1 throws on an empty title'
    })
    const result = await runRound(config, input, ask)
    assert.deepEqual(asked.slice(0, 3), ['claude haiku', 'claude sonnet', 'claude opus'])
    assert.deepEqual(asked.slice(3), ['claude opus'], 'the finder does not verify its own finding')
    assert.deepEqual(labels, [
      'decisions · claude haiku',
      'code · claude sonnet',
      'code · claude opus',
      'verify f1 · claude opus',
    ])
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.severity, f.verdict]),
      [
        ['f1', 'blocker', 'confirmed'],
        ['f2', 'note', 'unverified'],
      ],
    )
    assert.deepEqual(result.refuted, [])
    assert.equal(result.cost, 0.04)
    assert.equal(result.tokens, 4000)
    assert.equal(roundClean(result), false)
  })

  test('refuted findings leave the list; a clean round is one with nothing left and no failure', async () => {
    const { ask } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'sonnet') return '- [warning] a.ts:1 — maybe — check'
      if (isLens(prompt)) return 'no findings'
      return 'refuted\na.ts:2 guards it'
    })
    const result = await runRound(config, input, ask)
    assert.deepEqual(result.findings, [])
    assert.equal(result.refuted.length, 1)
    assert.deepEqual(result.refuted[0]?.proofs, [{ by: 'claude opus', outcome: 'refuted', proof: 'a.ts:2 guards it' }])
    assert.equal(roundClean(result), true)
  })

  test('a finding whose line does not exist is refuted by cite before any verifier; the others carry their line', async () => {
    const { ask, asked } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'sonnet')
        return '- [blocker] a.ts:1 — breaks — fix\n- [warning] a.ts:99 — invented — fix'
      if (isLens(prompt)) return 'no findings'
      return prompt.includes('const x = 1') ? 'confirmed\na.ts:1' : 'undecided\nno line given'
    })
    const cite = (path: string, line: number | null) =>
      path === 'a.ts' && line === 1
        ? { text: 'const x = 1' }
        : { missing: 'no line 99: the file has 3 lines', what: 'line' as const }
    const result = await runRound(config, { ...input, cite }, ask)
    assert.deepEqual(asked.slice(3), ['claude opus'], 'only the finding on a real line is verified')
    assert.deepEqual(
      result.findings.map((f) => [f.path, f.line, f.verdict, f.cited]),
      [['a.ts', 1, 'confirmed', 'const x = 1']],
    )
    assert.deepEqual(
      result.refuted.map((f) => [f.line, f.proofs]),
      [[99, [{ by: 'lntt check cite', outcome: 'refuted', proof: 'a.ts:99: no line 99: the file has 3 lines' }]]],
    )
  })

  test('a finding on a file that is not there goes to its verifiers: the change may delete it', async () => {
    const { ask, asked } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'sonnet') return '- [warning] gone.ts:3 — still imported — fix'
      if (isLens(prompt)) return 'no findings'
      return 'confirmed\nb.ts:1 imports it'
    })
    const cite = () => ({ missing: 'no such file', what: 'file' as const })
    const result = await runRound(config, { ...input, cite }, ask)
    assert.deepEqual(asked.slice(3), ['claude opus'])
    assert.deepEqual(
      result.findings.map((f) => [f.path, f.verdict]),
      [['gone.ts', 'confirmed']],
    )
  })

  test('a finding carried from the last round whose line is gone is refuted by cite; the next carried one stays carried', async () => {
    const carried = (id: string, line: number, severity: 'warning' | 'note' = 'warning'): Checked => ({
      id,
      severity,
      path: 'a.ts',
      line,
      what: `open-${id}`,
      action: 'a',
      foundBy: [{ lens: 'code', agent: 'claude sonnet', session: 's' }],
      verdict: 'unverified',
      proofs: [],
    })
    // A fresh note after them: never verified, wherever the carried ones end.
    const { ask, labels } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'sonnet') return '- [note] a.ts:3 — wording — reword'
      if (isLens(prompt)) return 'no findings'
      return prompt.includes('open-f2') ? 'undecided\nstill there' : 'confirmed\na.ts:1'
    })
    const cite = (_path: string, line: number | null) =>
      line === 40 ? { missing: 'no line 40: the file has 3 lines', what: 'line' as const } : { text: 'x' }
    const result = await runRound(config, { ...input, cite }, ask, [carried('f1', 40), carried('f2', 2)])
    assert.deepEqual(
      result.refuted.map((f) => [f.id, f.proofs[0]?.by]),
      [['f1', 'lntt check cite']],
    )
    // f2 is still a carried finding: verified on the new head, keeping its id; the note
    // is not.
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.verdict]),
      [
        ['f2', 'undecided'],
        ['f3', 'unverified'],
      ],
    )
    assert.deepEqual(
      labels.filter((l) => l.startsWith('verify')),
      ['verify f2 · claude opus'],
    )
  })

  test('a reviewer that fails makes the round not clean, never "no findings"', async () => {
    const { ask } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'opus') return new Error('timed out after 20 minutes')
      return 'no findings'
    })
    const result = await runRound(config, input, ask)
    assert.deepEqual(result.findings, [])
    assert.deepEqual(result.failed, [{ lens: 'code', agent: 'claude opus', error: 'timed out after 20 minutes' }])
    assert.equal(roundClean(result), false)
  })

  test('a finding still open goes back to the verifiers on the new head; new ones are numbered after it', async () => {
    const open: Checked[] = [
      {
        id: 'f3',
        severity: 'warning',
        path: 'a.ts',
        line: 9,
        what: 'stale-x',
        action: 'a',
        foundBy: [{ lens: 'code', agent: 'claude sonnet', session: 's' }],
        verdict: 'unverified',
        proofs: [],
      },
    ]
    const { ask } = asker((prompt, _kind, model) => {
      if (isLens(prompt, 'code') && model === 'sonnet') return '- [warning] a.ts:1 — new — fix'
      if (isLens(prompt)) return 'no findings'
      if (prompt.includes('stale-x')) return 'refuted\na.ts:9 was rewritten'
      return 'confirmed\na.ts:1 proves it'
    })
    const result = await runRound(config, input, ask, open)
    assert.deepEqual(
      result.refuted.map((f) => f.id),
      ['f3'],
    )
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.verdict]),
      [['f4', 'confirmed']],
    )
  })

  test('without verifiers, a finding still open stays open', async () => {
    const { ask } = asker(() => 'no findings')
    const open = [{ id: 'f1', severity: 'warning', foundBy: [], verdict: 'confirmed', proofs: [] }] as never
    const result = await runRound({ ...config, verify: null }, input, ask, open)
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.verdict]),
      [['f1', 'confirmed']],
    )
  })

  test('an empty delta asks nobody and carries the open findings of the last round', async () => {
    const { ask, asked } = asker(() => 'no findings')
    const open = [{ id: 'f1', severity: 'warning', verdict: 'confirmed' }] as never
    const result = await runRound(config, { ...input, files: [], diff: '' }, ask, open)
    assert.deepEqual(asked, [])
    assert.deepEqual(result.findings, open)
    assert.equal(roundClean(result), false)
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

  test('a reviewer whose reply has no finding line and no "no findings" counts as failed', async () => {
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? 'Looks good overall.' : 'confirmed\nx')),
    )
    assert.deepEqual(
      result.failed.map((f) => [f.lens, f.agent]),
      [['code', 'claude sonnet']],
    )
    assert.match(result.failed[0]?.error ?? '', /no finding line/)
    assert.equal(roundClean(result), false)
  })

  test('one unreadable line keeps the readable findings: the lens is partial, with the full reply', async () => {
    const reply = '- [warning] a.ts:1 — x — y\n- [blocker] something went wrong\n\nclosing words'
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
    )
    assert.deepEqual(result.failed, [])
    assert.deepEqual(
      result.findings.map((f) => f.path),
      ['a.ts'],
    )
    assert.deepEqual(result.partial, [
      { lens: 'code', agent: 'claude sonnet', lines: ['- [blocker] something went wrong'], reply },
    ])
    assert.equal(roundClean(result), false)
  })

  test('only unreadable lines and a note: the lens is partial and the round is not clean', async () => {
    const reply = `- [note] a.ts:1 — x — y\n\n- [blocker] ${'z'.repeat(300)}`
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
    )
    assert.deepEqual(result.failed, [])
    assert.equal(result.partial[0]?.reply, reply)
    assert.equal(roundClean(result), false)
  })

  test('a reply of only unreadable finding lines fails, with the whole reply', async () => {
    const reply = `- [blocker] ${'z'.repeat(300)}`
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
    )
    assert.match(result.failed[0]?.error ?? '', /1 finding lines that cannot be read/)
    assert.equal(result.failed[0]?.reply, reply)
    assert.deepEqual(result.partial, [])
  })

  test('a reply that fails keeps its full text, not 160 characters', async () => {
    const reply = `Looks good overall. ${'x'.repeat(400)}`
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
    )
    assert.equal(result.failed[0]?.reply, reply)
  })

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

  test('notes do not block a clean round; blockers and warnings do', async () => {
    const notes = await runRound(
      one,
      input,
      ask(() => '- [note] a.ts:1 — wording — reword'),
    )
    assert.equal(notes.findings.length, 1)
    assert.equal(roundClean(notes), true)
    const warning = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? '- [warning] a.ts:1 — w — a' : 'undecided\n?')),
    )
    assert.equal(roundClean(warning), false)
  })

  test('a verifier that fails is a failure of the round, besides an undecided proof', async () => {
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? '- [blocker] a.ts:1 — b — a' : new Error('opencode exited 1'))),
    )
    assert.equal(result.findings[0]?.verdict, 'undecided')
    assert.deepEqual(result.failed, [{ lens: 'verify f1', agent: 'claude opus', error: 'opencode exited 1' }])
  })

  test('a fresh finding at the anchor of one still open joins it instead of opening a second', async () => {
    const open: Checked[] = [
      {
        id: 'f2',
        severity: 'warning',
        path: 'a.ts',
        line: 1,
        what: 'old',
        action: 'a',
        foundBy: [{ lens: 'code', agent: 'claude haiku', session: 'h' }],
        verdict: 'confirmed',
        proofs: [],
      },
    ]
    const result = await runRound(
      one,
      input,
      ask((p) => (reviewerFirst(p) ? '- [warning] a.ts:1 — same — a' : 'confirmed\np')),
      open,
    )
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.foundBy.map((b) => b.agent)]),
      [['f2', ['claude haiku', 'claude sonnet']]],
    )
  })

  test('notes are not carried to the next round; the others are, until withdrawn', async () => {
    const carried = (id: string, severity: Severity, verdict: Checked['verdict']): Checked => ({
      id,
      severity,
      path: `${id}.ts`,
      line: 1,
      what: 'w',
      action: 'a',
      foundBy: [],
      verdict,
      proofs: [],
    })
    const open = [
      carried('f1', 'note', 'unverified'),
      carried('f2', 'warning', 'withdrawn'),
      carried('f3', 'warning', 'confirmed'),
    ]
    const result = await runRound(
      { ...one, verify: null },
      input,
      ask(() => '- [warning] z.ts:1 — new — a'),
      open,
    )
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.verdict]),
      [
        ['f3', 'confirmed'],
        ['f4', 'unverified'],
      ],
    )
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

  describe('what the second real round taught', () => {
    const sonnet = { kind: 'claude', model: 'sonnet' }
    const glm = { kind: 'opencode', model: 'opencode/glm', optional: true }
    const deepseek = { kind: 'opencode', model: 'opencode/deepseek', optional: true }
    const config = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            tests: { with: [] },
            code: { with: [{ kind: 'claude', model: 'haiku' }, deepseek] },
          },
          verify: { with: [sonnet, glm] },
        },
      },
    })
    const input = {
      base: 'mb',
      head: 'h',
      files: ['a.ts'],
      diff: 'D',
      records: '',
      range: roundRange(null, 'b', 'h', 'mb', () => true),
    }
    const first = (p: string) => p.split('\n')[0] as string
    const ask =
      (answer: (prompt: string, model?: string) => string | Error): Ask =>
      async (qs) =>
        qs.map((q) => {
          const a = answer(q.prompt, q.agent.model)
          return a instanceof Error
            ? { ok: false as const, error: a.message }
            : { ok: true as const, reply: { text: a, session: 's', cost: null, tokens: null } }
        })

    test('the verdict counts the verifiers that answered; one that failed does not split it', async () => {
      const result = await runRound(
        { ...config, verify: { with: [sonnet, { ...glm, optional: false }], severities: ['blocker', 'warning'] } },
        input,
        ask((p, model) => {
          if (first(p).includes('Lens:')) return model === 'haiku' ? '- [blocker] a.ts:1 — b — a' : 'no findings'
          return model === 'sonnet' ? 'refuted\na.ts:2 guards it' : new Error('timed out after 20 minutes')
        }),
      )
      assert.deepEqual(
        result.refuted.map((f) => f.id),
        ['f1'],
      )
      assert.equal(result.failed.length, 1, 'the failed verifier is still a failure of the round')
    })

    test('when no verifier answered, the finding is undecided', async () => {
      const result = await runRound(
        { ...config, verify: { with: [{ ...glm, optional: false }], severities: ['blocker'] } },
        input,
        ask((p, model) =>
          first(p).includes('Lens:')
            ? model === 'haiku'
              ? '- [blocker] a.ts:1 — b — a'
              : 'no findings'
            : new Error('down'),
        ),
      )
      assert.equal(result.findings[0]?.verdict, 'undecided')
    })

    test('an optional agent that fails is reported in skipped and does not keep the round from being clean', async () => {
      const result = await runRound(
        config,
        input,
        ask((p, model) => {
          if (first(p).includes('Lens:'))
            return model === 'haiku' ? '- [warning] a.ts:1 — w — a' : new Error('timed out')
          return model === 'sonnet' ? 'refuted\nno' : new Error('timed out')
        }),
      )
      assert.deepEqual(result.failed, [])
      assert.deepEqual(
        result.skipped.map((s) => [s.lens, s.agent]),
        [
          ['code', 'opencode opencode/deepseek'],
          ['verify f1', 'opencode opencode/glm'],
        ],
      )
      assert.equal(roundClean(result), true)
    })

    test('an optional agent that answers counts like any other', async () => {
      const result = await runRound(
        config,
        input,
        ask((p, model) => {
          if (first(p).includes('Lens:')) return model === 'haiku' ? '- [warning] a.ts:1 — w — a' : 'no findings'
          return model === 'sonnet' ? 'refuted\nno' : 'confirmed\nyes'
        }),
      )
      assert.equal(result.findings[0]?.verdict, 'undecided', 'sonnet refutes, glm confirms: split')
    })

    test('a fresh finding at another line of the same file is not joined to an open one', async () => {
      const open: Checked[] = [
        {
          id: 'f1',
          severity: 'warning',
          path: 'a.ts',
          line: 9,
          what: 'o',
          action: 'a',
          foundBy: [],
          verdict: 'confirmed',
          proofs: [],
        },
      ]
      const result = await runRound(
        { ...config, verify: null },
        input,
        ask((p, model) =>
          first(p).includes('Lens:') && model === 'haiku' ? '- [warning] a.ts:1 — new — a' : 'no findings',
        ),
        open,
      )
      assert.deepEqual(
        result.findings.map((f) => f.id),
        ['f1', 'f2'],
      )
    })
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

  test('the same agent finding an open finding again is not counted twice', async () => {
    const config = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            tests: { with: [] },
            code: { with: [{ kind: 'claude', model: 'sonnet' }] },
          },
          verify: false,
        },
      },
    })
    const open: Checked[] = [
      {
        id: 'f1',
        severity: 'warning',
        path: 'a.ts',
        line: 1,
        what: 'w',
        action: 'a',
        foundBy: [{ lens: 'code', agent: 'claude sonnet', session: 's' }],
        verdict: 'confirmed',
        proofs: [],
      },
    ]
    const input = {
      base: 'mb',
      head: 'h',
      files: ['a.ts'],
      diff: 'D',
      records: '',
      range: roundRange(null, 'b', 'h', 'mb', () => true),
    }
    const ask: Ask = async (qs) =>
      qs.map(() => ({
        ok: true as const,
        reply: { text: '- [warning] a.ts:1 — w — a', session: 's2', cost: null, tokens: null },
      }))
    const result = await runRound(config, input, ask, open)
    assert.deepEqual(
      result.findings[0]?.foundBy.map((b) => [b.agent, b.session]),
      [['claude sonnet', 's2']],
    )
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
  const config = reviewConfig({
    delivery: {
      review: {
        reviewers: {
          decisions: { with: [] },
          tests: { with: [] },
          code: { with: [{ kind: 'claude', model: 'haiku' }] },
        },
        verify: { with: [{ kind: 'claude', model: 'sonnet' }] },
      },
    },
  })
  const roundAt = (n: number) =>
    roundRange(
      n === 1 ? null : ({ branch: 'b', round: n - 1, reviewed: 'h0' } as ReviewState),
      'b',
      'h',
      'mb',
      () => true,
    )
  const input = (n: number, lines: Record<number, string>) => ({
    base: 'mb',
    head: `h${n}`,
    files: ['a.ts'],
    diff: 'D',
    records: '',
    range: roundAt(n),
    cite: (_path: string, line: number | null) => ({ text: lines[line ?? 0] ?? null }),
  })
  function asker(review: string, verify: (prompt: string) => string) {
    const prompts: string[] = []
    const ask: Ask = async (qs) =>
      qs.map((q) => {
        prompts.push(q.prompt)
        const text = q.prompt.startsWith('You are reviewing') ? review : verify(q.prompt)
        return { ok: true as const, reply: { text, session: 's', cost: null, tokens: null } }
      })
    return { ask, prompts }
  }

  test('warningRounds is read from delivery.review, and is 2 by default', () => {
    assert.equal(reviewConfig({}).warningRounds, 2)
    assert.equal(reviewConfig({ delivery: { review: { warningRounds: 5 } } }).warningRounds, 5)
  })

  test('a refuted finding is not reported again on an unchanged line, and is on a changed one', async () => {
    const lines = { 3: 'const x = a ?? b' }
    const one = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'refuted\na.ts:2 sets a')
    const first = await runRound(config, input(1, lines), one.ask)
    const ledger = closeRound([], first, [], config.warningRounds)
    assert.deepEqual(
      ledger.map((c) => [c.id, c.outcome, c.cited, c.proof]),
      [['f1', 'refuted', 'const x = a ?? b', 'claude sonnet: a.ts:2 sets a']],
    )

    const two = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'confirmed\nyes')
    const second = await runRound(config, { ...input(2, lines), closed: ledger }, two.ask, first.findings)
    assert.equal(two.prompts.length, 1, 'no verifier is asked for a repeat')
    assert.match(two.prompts[0] as string, /## Findings this branch already closed/)
    assert.match(
      two.prompts[0] as string,
      /- f1 \(warning\) `a\.ts:3` — x may be null — refuted: claude sonnet: a\.ts:2 sets a/,
    )
    assert.deepEqual(
      second.closed.map((f) => [f.id, f.closedBy, f.closedWhat]),
      [['f2', 'f1', 'x may be null']],
    )
    assert.deepEqual(second.findings, [])
    assert.equal(roundClean(second), true)

    const changed = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'confirmed\nyes')
    const third = await runRound(config, { ...input(2, { 3: 'const x = a' }), closed: ledger }, changed.ask)
    assert.deepEqual(third.closed, [])
    assert.deepEqual(
      third.findings.map((f) => [f.id, f.verdict]),
      [['f2', 'confirmed']],
      'numbered after the ledger',
    )
  })

  test('a fixed finding is never repeated: one on its line again is new, and verified', async () => {
    const ledger = [
      {
        id: 'f1',
        round: 1,
        severity: 'warning',
        path: 'a.ts',
        line: 3,
        what: 'w',
        cited: 'same',
        outcome: 'fixed',
        commit: 'h1',
      },
    ] as Closed[]
    const { ask, prompts } = asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny')
    const result = await runRound(config, { ...input(2, { 3: 'same' }), closed: ledger }, ask)
    assert.deepEqual(result.closed, [])
    assert.deepEqual(
      result.findings.map((f) => [f.id, f.verdict]),
      [['f2', 'confirmed']],
    )
    assert.equal(prompts.length, 2)
  })

  test('the reviewers read the entries on the files of the change, and those with no anchor', async () => {
    const ledger = [
      {
        id: 'f1',
        round: 1,
        severity: 'warning',
        path: 'a.ts',
        line: 9,
        what: 'here',
        cited: 'x',
        outcome: 'refuted',
        proof: 'p',
      },
      {
        id: 'f2',
        round: 1,
        severity: 'warning',
        path: 'b.ts',
        line: 1,
        what: 'elsewhere',
        cited: 'y',
        outcome: 'refuted',
        proof: 'q',
      },
      {
        id: 'f3',
        round: 1,
        severity: 'note',
        path: null,
        line: null,
        what: 'loose',
        cited: null,
        outcome: 'accepted',
        reason: 'r',
      },
    ] as Closed[]
    const { ask, prompts } = asker('no findings', () => '')
    await runRound(config, { ...input(2, {}), closed: ledger }, ask)
    assert.match(prompts[0] as string, /here/)
    assert.match(prompts[0] as string, /loose/)
    assert.doesNotMatch(prompts[0] as string, /elsewhere/)
  })

  test('a repeat at a higher severity than the closed finding is a new finding', async () => {
    const lines = { 3: 'same' }
    const ledger = closeRound(
      [],
      await runRound(config, input(1, lines), asker('- [note] a.ts:3 — n — a', () => '').ask),
      [],
      2,
    )
    assert.deepEqual(
      ledger.map((c) => [c.outcome, c.reason]),
      [['accepted', 'a note: reported once, it does not block']],
    )
    const again = await runRound(
      config,
      { ...input(2, lines), closed: ledger },
      asker('- [blocker] a.ts:3 — b — a', () => 'confirmed\ny').ask,
    )
    assert.deepEqual(
      again.findings.map((f) => [f.severity, f.verdict]),
      [['blocker', 'confirmed']],
    )
  })

  test('the verifier reads what was closed on the finding’s file', async () => {
    const ledger = [
      {
        id: 'f1',
        round: 1,
        severity: 'warning',
        path: 'a.ts',
        line: 9,
        what: 'old',
        cited: 'x',
        outcome: 'refuted',
        proof: 'p',
      },
      {
        id: 'f2',
        round: 1,
        severity: 'warning',
        path: 'b.ts',
        line: 1,
        what: 'elsewhere',
        cited: 'y',
        outcome: 'refuted',
        proof: 'q',
      },
    ] as Closed[]
    const { ask, prompts } = asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny')
    await runRound(config, { ...input(2, { 3: 'z' }), closed: ledger }, ask)
    const verify = prompts.find((p) => p.startsWith('You are checking')) as string
    assert.match(verify, /- f1 \(warning\) `a\.ts:9` — old — refuted: p/)
    assert.doesNotMatch(verify, /elsewhere/)
  })

  test('a finding carried from an earlier round and refuted on a later head is fixed, with that head', async () => {
    const lines = { 3: 'before' }
    const first = await runRound(config, input(1, lines), asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask)
    const second = await runRound(
      config,
      input(2, { 3: 'after' }),
      asker('no findings', () => 'refuted\na.ts:3 guards it now').ask,
      first.findings,
    )
    assert.deepEqual(
      closeRound([], second, first.findings, 2).map((c) => [c.id, c.outcome, c.commit]),
      [['f1', 'fixed', 'h2']],
    )
  })

  test('past warningRounds only a blocker blocks; the warning is accepted open and not carried', async () => {
    const lines = { 3: 'w', 4: 'b' }
    const third = await runRound(config, input(3, lines), asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask)
    assert.deepEqual(third.blocking, ['blocker'])
    assert.equal(roundClean(third), true, 'a confirmed warning past round 2')
    const ledger = closeRound([], third, [], 2)
    assert.deepEqual(
      ledger.map((c) => [c.id, c.outcome, c.reason]),
      [['f1', 'accepted', 'a warning past round 2: an open item of the pull request']],
    )
    const { ask, prompts } = asker('no findings', () => 'confirmed\ny')
    const fourth = await runRound(config, { ...input(4, lines), closed: ledger }, ask, third.findings)
    assert.equal(prompts.length, 1, 'the accepted warning goes to no verifier')
    assert.deepEqual(fourth.findings, [])

    const undecided = await runRound(
      config,
      input(3, lines),
      asker('- [warning] a.ts:3 — w — a', () => 'undecided\n?').ask,
    )
    assert.equal(roundClean(undecided), true)
    assert.deepEqual(closeRound([], undecided, [], 2), [], 'an undecided warning stays carried, to be verified again')

    const empty = await runRound(config, { ...input(3, lines), files: [] }, asker('', () => '').ask, [])
    assert.deepEqual(empty.blocking, ['blocker', 'warning'], 'an empty delta after round 2 is still round 2')

    const blocker = await runRound(
      config,
      input(3, lines),
      asker('- [blocker] a.ts:4 — b — a', () => 'confirmed\ny').ask,
    )
    assert.equal(roundClean(blocker), false)
    const second = await runRound(
      config,
      input(2, lines),
      asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask,
    )
    assert.deepEqual(second.blocking, ['blocker', 'warning'])
    assert.equal(roundClean(second), false)
    assert.deepEqual(closeRound([], second, [], 2), [], 'a warning up to round 2 stays open')
  })

  test('an optional agent never widens the next range: neither its failure nor an unreadable line', async () => {
    const optional = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            tests: { with: [] },
            code: {
              with: [
                { kind: 'claude', model: 'haiku' },
                { kind: 'opencode', model: 'x/free', optional: true },
              ],
            },
          },
          verify: false,
        },
      },
    })
    const ask: Ask = async (qs) =>
      qs.map((q) =>
        q.agent.optional
          ? {
              ok: true as const,
              reply: {
                text: '- [warning] a.ts:3 — w — a\n- [warning] nonsense',
                session: 's',
                cost: null,
                tokens: null,
              },
            }
          : { ok: true as const, reply: { text: 'no findings', session: 's', cost: null, tokens: null } },
      )
    const result = await runRound(optional, input(1, { 3: 'x' }), ask)
    assert.deepEqual(result.partial, [])
    assert.deepEqual(
      result.skipped.map((s) => [s.agent, s.error]),
      [['opencode x/free', '1 finding lines that cannot be read']],
    )
    assert.equal(result.findings.length, 1, 'its readable findings stand')
    assert.equal(reviewedAfter(result, 'h0', 'h1'), 'h1')

    const quota = await runRound(optional, input(1, {}), async (qs) =>
      qs.map((q) =>
        q.agent.optional
          ? { ok: false as const, error: 'opencode exited 1: 429 Too Many Requests' }
          : { ok: true as const, reply: { text: 'no findings', session: 's', cost: null, tokens: null } },
      ),
    )
    assert.equal(quota.skipped.length, 1)
    assert.equal(reviewedAfter(quota, 'h0', 'h1'), 'h1')
    assert.equal(reviewedAfter({ ...quota, failed: [{ lens: 'code', agent: 'a', error: 'e' }] }, 'h0', 'h1'), 'h0')
  })
})
