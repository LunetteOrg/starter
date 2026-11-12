import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import {
  agentLabel,
  type Checked,
  type Closed,
  closeRound,
  type ReviewState,
  reviewConfig,
  reviewedAfter,
  roundClean,
  roundRange,
  type Severity,
} from '../review.ts'
import { type Ask, runRound } from './round.ts'

// The round on Effect: its asks, its brief and its cited lines are Effects, as the command
// gives them over the Agents service and the file system.

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
    const ask: Ask = (jobs) =>
      Effect.sync(() =>
        jobs.map((job) => {
          asked.push(`${agentLabel(job.agent)}${job.session ? ` resumes ${job.session}` : ''}`)
          labels.push(job.label ?? '')
          const answer = answers(job.prompt, job.agent.kind, job.agent.model)
          return answer instanceof Error
            ? { ok: false as const, error: answer.message }
            : { ok: true as const, reply: { text: answer, session: `s-${job.agent.model}`, cost: 0.01, tokens: 1000 } }
        }),
      )
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

  it.effect('reviewers in parallel, then each blocker or warning verified by the others, notes left unverified', () =>
    Effect.gen(function* () {
      const { ask, asked, labels } = asker((prompt, _kind, model) => {
        if (isLens(prompt, 'decisions')) return 'no findings'
        if (isLens(prompt, 'code') && model === 'sonnet')
          return '- [blocker] a.ts:1 — breaks — fix\n- [note] a.ts:5 — wording — reword'
        if (isLens(prompt, 'code')) return 'no findings'
        return 'confirmed\na.ts:1 throws on an empty title'
      })
      const result = yield* runRound(config, input, ask)
      assert.deepStrictEqual(asked.slice(0, 3), ['claude haiku', 'claude sonnet', 'claude opus'])
      assert.deepStrictEqual(asked.slice(3), ['claude opus'], 'the finder does not verify its own finding')
      assert.deepStrictEqual(labels, [
        'decisions · claude haiku',
        'code · claude sonnet',
        'code · claude opus',
        'verify f1 · claude opus',
      ])
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.severity, f.verdict]),
        [
          ['f1', 'blocker', 'confirmed'],
          ['f2', 'note', 'unverified'],
        ],
      )
      assert.deepStrictEqual(result.refuted, [])
      assert.strictEqual(result.cost, 0.04)
      assert.strictEqual(result.tokens, 4000)
      assert.strictEqual(roundClean(result), false)
    }),
  )

  it.effect('refuted findings leave the list; a clean round is one with nothing left and no failure', () =>
    Effect.gen(function* () {
      const { ask } = asker((prompt, _kind, model) => {
        if (isLens(prompt, 'code') && model === 'sonnet') return '- [warning] a.ts:1 — maybe — check'
        if (isLens(prompt)) return 'no findings'
        return 'refuted\na.ts:2 guards it'
      })
      const result = yield* runRound(config, input, ask)
      assert.deepStrictEqual(result.findings, [])
      assert.strictEqual(result.refuted.length, 1)
      assert.deepStrictEqual(result.refuted[0]?.proofs, [
        { by: 'claude opus', outcome: 'refuted', proof: 'a.ts:2 guards it' },
      ])
      assert.strictEqual(roundClean(result), true)
    }),
  )

  it.effect(
    'a finding whose line does not exist is refuted by cite before any verifier; the others carry their line',
    () =>
      Effect.gen(function* () {
        const { ask, asked } = asker((prompt, _kind, model) => {
          if (isLens(prompt, 'code') && model === 'sonnet')
            return '- [blocker] a.ts:1 — breaks — fix\n- [warning] a.ts:99 — invented — fix'
          if (isLens(prompt)) return 'no findings'
          return prompt.includes('const x = 1') ? 'confirmed\na.ts:1' : 'undecided\nno line given'
        })
        const cite = (path: string, line: number | null) =>
          Effect.succeed(
            path === 'a.ts' && line === 1
              ? { text: 'const x = 1' }
              : { missing: 'no line 99: the file has 3 lines', what: 'line' as const },
          )
        const result = yield* runRound(config, { ...input, cite }, ask)
        assert.deepStrictEqual(asked.slice(3), ['claude opus'], 'only the finding on a real line is verified')
        assert.deepStrictEqual(
          result.findings.map((f) => [f.path, f.line, f.verdict, f.cited]),
          [['a.ts', 1, 'confirmed', 'const x = 1']],
        )
        assert.deepStrictEqual(
          result.refuted.map((f) => [f.line, f.proofs]),
          [[99, [{ by: 'lntt check cite', outcome: 'refuted', proof: 'a.ts:99: no line 99: the file has 3 lines' }]]],
        )
      }),
  )

  it.effect('a finding on a file that is not there goes to its verifiers: the change may delete it', () =>
    Effect.gen(function* () {
      const { ask, asked } = asker((prompt, _kind, model) => {
        if (isLens(prompt, 'code') && model === 'sonnet') return '- [warning] gone.ts:3 — still imported — fix'
        if (isLens(prompt)) return 'no findings'
        return 'confirmed\nb.ts:1 imports it'
      })
      const cite = () => Effect.succeed({ missing: 'no such file', what: 'file' as const })
      const result = yield* runRound(config, { ...input, cite }, ask)
      assert.deepStrictEqual(asked.slice(3), ['claude opus'])
      assert.deepStrictEqual(
        result.findings.map((f) => [f.path, f.verdict]),
        [['gone.ts', 'confirmed']],
      )
    }),
  )

  it.effect(
    'a finding carried from the last round whose line is gone is refuted by cite; the next carried one stays carried',
    () =>
      Effect.gen(function* () {
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
          Effect.succeed(
            line === 40 ? { missing: 'no line 40: the file has 3 lines', what: 'line' as const } : { text: 'x' },
          )
        const result = yield* runRound(config, { ...input, cite }, ask, [carried('f1', 40), carried('f2', 2)])
        assert.deepStrictEqual(
          result.refuted.map((f) => [f.id, f.proofs[0]?.by]),
          [['f1', 'lntt check cite']],
        )
        // f2 is still a carried finding: verified on the new head, keeping its id; the note
        // is not.
        assert.deepStrictEqual(
          result.findings.map((f) => [f.id, f.verdict]),
          [
            ['f2', 'undecided'],
            ['f3', 'unverified'],
          ],
        )
        assert.deepStrictEqual(
          labels.filter((l) => l.startsWith('verify')),
          ['verify f2 · claude opus'],
        )
      }),
  )

  it.effect('the agents that reported no tokens or no USD, once each; a failed agent reported none', () =>
    Effect.gen(function* () {
      const ask: Ask = (jobs) =>
        Effect.sync(() =>
          jobs.map((job) => {
            if (job.agent.model === 'opus') return { ok: false as const, error: 'boom' }
            const haiku = job.agent.model === 'haiku'
            return {
              ok: true as const,
              reply: { text: 'no findings', session: 's', cost: haiku ? null : 0.01, tokens: haiku ? 700 : null },
            }
          }),
        )
      const result = yield* runRound(config, { ...input, files: ['a.ts', 'a.test.ts'] }, ask)
      assert.deepStrictEqual(result.noUsd, ['claude haiku', 'claude opus'], 'haiku answers twice and is named once')
      assert.deepStrictEqual(result.noTokens, ['claude sonnet', 'claude opus'])
      assert.strictEqual(result.tokens, 1400)
      assert.strictEqual(result.cost, 0.01)
      const silent: Ask = (jobs) =>
        Effect.sync(() =>
          jobs.map((job) => ({
            ok: true as const,
            reply: { text: 'no findings', session: 's', cost: 0.01, tokens: job.agent.model === 'haiku' ? null : 10 },
          })),
        )
      const again = yield* runRound(config, { ...input, files: ['a.ts', 'a.test.ts'] }, silent)
      assert.deepStrictEqual(again.noTokens, ['claude haiku'], 'haiku answers twice with no tokens and is named once')
    }),
  )

  it.effect('a verifier that reports no cost is named too; an empty delta names nobody', () =>
    Effect.gen(function* () {
      const { ask } = asker((prompt, _kind, model) => {
        if (isLens(prompt, 'code') && model === 'sonnet') return '- [blocker] a.ts:1 — breaks — fix'
        if (isLens(prompt)) return 'no findings'
        return 'confirmed\np'
      })
      const priced: Ask = (jobs) =>
        Effect.map(ask(jobs), (answers) =>
          answers.map((a, i) =>
            a.ok && (jobs[i]?.label ?? '').startsWith('verify ') ? { ...a, reply: { ...a.reply, cost: null } } : a,
          ),
        )
      const result = yield* runRound(config, input, priced)
      assert.deepStrictEqual(result.noUsd, ['claude opus'])
      assert.deepStrictEqual(result.noTokens, [])
      const empty = yield* runRound(config, { ...input, files: [] }, priced)
      assert.deepStrictEqual([empty.noTokens, empty.noUsd], [[], []])
    }),
  )

  it.effect('a reviewer that fails makes the round not clean, never "no findings"', () =>
    Effect.gen(function* () {
      const { ask } = asker((prompt, _kind, model) => {
        if (isLens(prompt, 'code') && model === 'opus') return new Error('timed out after 20 minutes')
        return 'no findings'
      })
      const result = yield* runRound(config, input, ask)
      assert.deepStrictEqual(result.findings, [])
      assert.deepStrictEqual(result.failed, [
        { lens: 'code', agent: 'claude opus', error: 'timed out after 20 minutes' },
      ])
      assert.strictEqual(roundClean(result), false)
    }),
  )

  it.effect('a finding still open goes back to the verifiers on the new head; new ones are numbered after it', () =>
    Effect.gen(function* () {
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
      const result = yield* runRound(config, input, ask, open)
      assert.deepStrictEqual(
        result.refuted.map((f) => f.id),
        ['f3'],
      )
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.verdict]),
        [['f4', 'confirmed']],
      )
    }),
  )

  it.effect('without verifiers, a finding still open stays open', () =>
    Effect.gen(function* () {
      const { ask } = asker(() => 'no findings')
      const open = [{ id: 'f1', severity: 'warning', foundBy: [], verdict: 'confirmed', proofs: [] }] as never
      const result = yield* runRound({ ...config, verify: null }, input, ask, open)
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.verdict]),
        [['f1', 'confirmed']],
      )
    }),
  )

  it.effect('an empty delta asks nobody and carries the open findings of the last round', () =>
    Effect.gen(function* () {
      const { ask, asked } = asker(() => 'no findings')
      const open = [{ id: 'f1', severity: 'warning', verdict: 'confirmed' }] as never
      const result = yield* runRound(config, { ...input, files: [], diff: '' }, ask, open)
      assert.deepStrictEqual(asked, [])
      assert.deepStrictEqual(result.findings, open)
      assert.strictEqual(roundClean(result), false)
    }),
  )
})

describe('what the first real round taught', () => {
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
    return (questions) =>
      Effect.sync(() =>
        questions.map((q) => {
          const a = answer(q.prompt)
          return a instanceof Error
            ? { ok: false as const, error: a.message }
            : { ok: true as const, reply: { text: a, session: 's', cost: null, tokens: null } }
        }),
      )
  }

  it.effect('a reviewer whose reply has no finding line and no "no findings" counts as failed', () =>
    Effect.gen(function* () {
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? 'Looks good overall.' : 'confirmed\nx')),
      )
      assert.deepStrictEqual(
        result.failed.map((f) => [f.lens, f.agent]),
        [['code', 'claude sonnet']],
      )
      assert.match(result.failed[0]?.error ?? '', /no finding line/)
      assert.strictEqual(roundClean(result), false)
    }),
  )

  it.effect('one unreadable line keeps the readable findings: the lens is partial, with the full reply', () =>
    Effect.gen(function* () {
      const reply = '- [warning] a.ts:1 — x — y\n- [blocker] something went wrong\n\nclosing words'
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
      )
      assert.deepStrictEqual(result.failed, [])
      assert.deepStrictEqual(
        result.findings.map((f) => f.path),
        ['a.ts'],
      )
      assert.deepStrictEqual(result.partial, [
        { lens: 'code', agent: 'claude sonnet', lines: ['- [blocker] something went wrong'], reply },
      ])
      assert.strictEqual(roundClean(result), false)
    }),
  )

  it.effect('only unreadable lines and a note: the lens is partial and the round is not clean', () =>
    Effect.gen(function* () {
      const reply = `- [note] a.ts:1 — x — y\n\n- [blocker] ${'z'.repeat(300)}`
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
      )
      assert.deepStrictEqual(result.failed, [])
      assert.strictEqual(result.partial[0]?.reply, reply)
      assert.strictEqual(roundClean(result), false)
    }),
  )

  it.effect('a reply of only unreadable finding lines fails, with the whole reply', () =>
    Effect.gen(function* () {
      const reply = `- [blocker] ${'z'.repeat(300)}`
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
      )
      assert.match(result.failed[0]?.error ?? '', /1 finding lines that cannot be read/)
      assert.strictEqual(result.failed[0]?.reply, reply)
      assert.deepStrictEqual(result.partial, [])
    }),
  )

  it.effect('a reply that fails keeps its full text, not 160 characters', () =>
    Effect.gen(function* () {
      const reply = `Looks good overall. ${'x'.repeat(400)}`
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? reply : 'confirmed\nx')),
      )
      assert.strictEqual(result.failed[0]?.reply, reply)
    }),
  )

  it.effect('notes do not block a clean round; blockers and warnings do', () =>
    Effect.gen(function* () {
      const notes = yield* runRound(
        one,
        input,
        ask(() => '- [note] a.ts:1 — wording — reword'),
      )
      assert.strictEqual(notes.findings.length, 1)
      assert.strictEqual(roundClean(notes), true)
      const warning = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? '- [warning] a.ts:1 — w — a' : 'undecided\n?')),
      )
      assert.strictEqual(roundClean(warning), false)
    }),
  )

  it.effect('a verifier that fails is a failure of the round, besides an undecided proof', () =>
    Effect.gen(function* () {
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? '- [blocker] a.ts:1 — b — a' : new Error('opencode exited 1'))),
      )
      assert.strictEqual(result.findings[0]?.verdict, 'undecided')
      assert.deepStrictEqual(result.failed, [{ lens: 'verify f1', agent: 'claude opus', error: 'opencode exited 1' }])
    }),
  )

  it.effect('a fresh finding at the anchor of one still open joins it instead of opening a second', () =>
    Effect.gen(function* () {
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
      const result = yield* runRound(
        one,
        input,
        ask((p) => (reviewerFirst(p) ? '- [warning] a.ts:1 — same — a' : 'confirmed\np')),
        open,
      )
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.foundBy.map((b) => b.agent)]),
        [['f2', ['claude haiku', 'claude sonnet']]],
      )
    }),
  )

  it.effect('notes are not carried to the next round; the others are, until withdrawn', () =>
    Effect.gen(function* () {
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
      const result = yield* runRound(
        { ...one, verify: null },
        input,
        ask(() => '- [warning] z.ts:1 — new — a'),
        open,
      )
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.verdict]),
        [
          ['f3', 'confirmed'],
          ['f4', 'unverified'],
        ],
      )
    }),
  )

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
      (qs) =>
        Effect.sync(() =>
          qs.map((q) => {
            const a = answer(q.prompt, q.agent.model)
            return a instanceof Error
              ? { ok: false as const, error: a.message }
              : { ok: true as const, reply: { text: a, session: 's', cost: null, tokens: null } }
          }),
        )

    it.effect('the verdict counts the verifiers that answered; one that failed does not split it', () =>
      Effect.gen(function* () {
        const result = yield* runRound(
          { ...config, verify: { with: [sonnet, { ...glm, optional: false }], severities: ['blocker', 'warning'] } },
          input,
          ask((p, model) => {
            if (first(p).includes('Lens:')) return model === 'haiku' ? '- [blocker] a.ts:1 — b — a' : 'no findings'
            return model === 'sonnet' ? 'refuted\na.ts:2 guards it' : new Error('timed out after 20 minutes')
          }),
        )
        assert.deepStrictEqual(
          result.refuted.map((f) => f.id),
          ['f1'],
        )
        assert.strictEqual(result.failed.length, 1, 'the failed verifier is still a failure of the round')
      }),
    )

    it.effect('when no verifier answered, the finding is undecided', () =>
      Effect.gen(function* () {
        const result = yield* runRound(
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
        assert.strictEqual(result.findings[0]?.verdict, 'undecided')
      }),
    )

    it.effect('an optional agent that fails is reported in skipped and does not keep the round from being clean', () =>
      Effect.gen(function* () {
        const result = yield* runRound(
          config,
          input,
          ask((p, model) => {
            if (first(p).includes('Lens:'))
              return model === 'haiku' ? '- [warning] a.ts:1 — w — a' : new Error('timed out')
            return model === 'sonnet' ? 'refuted\nno' : new Error('timed out')
          }),
        )
        assert.deepStrictEqual(result.failed, [])
        assert.deepStrictEqual(
          result.skipped.map((s) => [s.lens, s.agent]),
          [
            ['code', 'opencode opencode/deepseek'],
            ['verify f1', 'opencode opencode/glm'],
          ],
        )
        assert.strictEqual(roundClean(result), true)
      }),
    )

    it.effect('an optional agent that answers counts like any other', () =>
      Effect.gen(function* () {
        const result = yield* runRound(
          config,
          input,
          ask((p, model) => {
            if (first(p).includes('Lens:')) return model === 'haiku' ? '- [warning] a.ts:1 — w — a' : 'no findings'
            return model === 'sonnet' ? 'refuted\nno' : 'confirmed\nyes'
          }),
        )
        assert.strictEqual(result.findings[0]?.verdict, 'undecided', 'sonnet refutes, glm confirms: split')
      }),
    )

    it.effect('a fresh finding at another line of the same file is not joined to an open one', () =>
      Effect.gen(function* () {
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
        const result = yield* runRound(
          { ...config, verify: null },
          input,
          ask((p, model) =>
            first(p).includes('Lens:') && model === 'haiku' ? '- [warning] a.ts:1 — new — a' : 'no findings',
          ),
          open,
        )
        assert.deepStrictEqual(
          result.findings.map((f) => f.id),
          ['f1', 'f2'],
        )
      }),
    )
  })
})

describe('what the fourth real round taught', () => {
  it.effect('the same agent finding an open finding again is not counted twice', () =>
    Effect.gen(function* () {
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
      const ask: Ask = (qs) =>
        Effect.sync(() =>
          qs.map(() => ({
            ok: true as const,
            reply: { text: '- [warning] a.ts:1 — w — a', session: 's2', cost: null, tokens: null },
          })),
        )
      const result = yield* runRound(config, input, ask, open)
      assert.deepStrictEqual(
        result.findings[0]?.foundBy.map((b) => [b.agent, b.session]),
        [['claude sonnet', 's2']],
      )
    }),
  )
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
    cite: (_path: string, line: number | null) => Effect.succeed({ text: lines[line ?? 0] ?? null }),
  })
  function asker(review: string, verify: (prompt: string) => string) {
    const prompts: string[] = []
    const ask: Ask = (qs) =>
      Effect.sync(() =>
        qs.map((q) => {
          prompts.push(q.prompt)
          const text = q.prompt.startsWith('You are reviewing') ? review : verify(q.prompt)
          return { ok: true as const, reply: { text, session: 's', cost: null, tokens: null } }
        }),
      )
    return { ask, prompts }
  }

  it.effect('a refuted finding is not reported again on an unchanged line, and is on a changed one', () =>
    Effect.gen(function* () {
      const lines = { 3: 'const x = a ?? b' }
      const one = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'refuted\na.ts:2 sets a')
      const first = yield* runRound(config, input(1, lines), one.ask)
      const ledger = closeRound([], first, [], config.warningRounds)
      assert.deepStrictEqual(
        ledger.map((c) => [c.id, c.outcome, c.cited, c.proof]),
        [['f1', 'refuted', 'const x = a ?? b', 'claude sonnet: a.ts:2 sets a']],
      )

      const two = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'confirmed\nyes')
      const second = yield* runRound(config, { ...input(2, lines), closed: ledger }, two.ask, first.findings)
      assert.strictEqual(two.prompts.length, 1, 'no verifier is asked for a repeat')
      assert.match(two.prompts[0] as string, /## Findings this branch already closed/)
      assert.match(
        two.prompts[0] as string,
        /- f1 \(warning\) `a\.ts:3` — x may be null — refuted: claude sonnet: a\.ts:2 sets a/,
      )
      assert.deepStrictEqual(
        second.closed.map((f) => [f.id, f.closedBy, f.closedWhat]),
        [['f2', 'f1', 'x may be null']],
      )
      assert.deepStrictEqual(second.findings, [])
      assert.strictEqual(roundClean(second), true)

      const changed = asker('- [warning] a.ts:3 — x may be null — guard it', () => 'confirmed\nyes')
      const third = yield* runRound(config, { ...input(2, { 3: 'const x = a' }), closed: ledger }, changed.ask)
      assert.deepStrictEqual(third.closed, [])
      assert.deepStrictEqual(
        third.findings.map((f) => [f.id, f.verdict]),
        [['f2', 'confirmed']],
        'numbered after the ledger',
      )
    }),
  )

  it.effect('a fixed finding is never repeated: one on its line again is new, and verified', () =>
    Effect.gen(function* () {
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
      const result = yield* runRound(config, { ...input(2, { 3: 'same' }), closed: ledger }, ask)
      assert.deepStrictEqual(result.closed, [])
      assert.deepStrictEqual(
        result.findings.map((f) => [f.id, f.verdict]),
        [['f2', 'confirmed']],
      )
      assert.strictEqual(prompts.length, 2)
    }),
  )

  it.effect('the reviewers read the entries on the files of the change, and those with no anchor', () =>
    Effect.gen(function* () {
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
      yield* runRound(config, { ...input(2, {}), closed: ledger }, ask)
      assert.match(prompts[0] as string, /here/)
      assert.match(prompts[0] as string, /loose/)
      assert.notMatch(prompts[0] as string, /elsewhere/)
    }),
  )

  it.effect('a repeat at a higher severity than the closed finding is a new finding', () =>
    Effect.gen(function* () {
      const lines = { 3: 'same' }
      const ledger = closeRound(
        [],
        yield* runRound(config, input(1, lines), asker('- [note] a.ts:3 — n — a', () => '').ask),
        [],
        2,
      )
      assert.deepStrictEqual(
        ledger.map((c) => [c.outcome, c.reason]),
        [['accepted', 'a note: reported once, it does not block']],
      )
      const again = yield* runRound(
        config,
        { ...input(2, lines), closed: ledger },
        asker('- [blocker] a.ts:3 — b — a', () => 'confirmed\ny').ask,
      )
      assert.deepStrictEqual(
        again.findings.map((f) => [f.severity, f.verdict]),
        [['blocker', 'confirmed']],
      )
    }),
  )

  it.effect('the verifier reads what was closed on the finding’s file', () =>
    Effect.gen(function* () {
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
      yield* runRound(config, { ...input(2, { 3: 'z' }), closed: ledger }, ask)
      const verify = prompts.find((p) => p.startsWith('You are checking')) as string
      assert.match(verify, /- f1 \(warning\) `a\.ts:9` — old — refuted: p/)
      assert.notMatch(verify, /elsewhere/)
    }),
  )

  it.effect('a finding carried from an earlier round and refuted on a later head is fixed, with that head', () =>
    Effect.gen(function* () {
      const lines = { 3: 'before' }
      const first = yield* runRound(
        config,
        input(1, lines),
        asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask,
      )
      const second = yield* runRound(
        config,
        input(2, { 3: 'after' }),
        asker('no findings', () => 'refuted\na.ts:3 guards it now').ask,
        first.findings,
      )
      assert.deepStrictEqual(
        closeRound([], second, first.findings, 2).map((c) => [c.id, c.outcome, c.commit]),
        [['f1', 'fixed', 'h2']],
      )
    }),
  )

  it.effect('past warningRounds only a blocker blocks; the warning is accepted open and not carried', () =>
    Effect.gen(function* () {
      const lines = { 3: 'w', 4: 'b' }
      const third = yield* runRound(
        config,
        input(3, lines),
        asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask,
      )
      assert.deepStrictEqual(third.blocking, ['blocker'])
      assert.strictEqual(roundClean(third), true, 'a confirmed warning past round 2')
      const ledger = closeRound([], third, [], 2)
      assert.deepStrictEqual(
        ledger.map((c) => [c.id, c.outcome, c.reason]),
        [['f1', 'accepted', 'a warning past round 2: an open item of the pull request']],
      )
      const { ask, prompts } = asker('no findings', () => 'confirmed\ny')
      const fourth = yield* runRound(config, { ...input(4, lines), closed: ledger }, ask, third.findings)
      assert.strictEqual(prompts.length, 1, 'the accepted warning goes to no verifier')
      assert.deepStrictEqual(fourth.findings, [])

      const undecided = yield* runRound(
        config,
        input(3, lines),
        asker('- [warning] a.ts:3 — w — a', () => 'undecided\n?').ask,
      )
      assert.strictEqual(roundClean(undecided), true)
      assert.deepStrictEqual(
        closeRound([], undecided, [], 2),
        [],
        'an undecided warning stays carried, to be verified again',
      )

      const empty = yield* runRound(config, { ...input(3, lines), files: [] }, asker('', () => '').ask, [])
      assert.deepStrictEqual(empty.blocking, ['blocker', 'warning'], 'an empty delta after round 2 is still round 2')

      const blocker = yield* runRound(
        config,
        input(3, lines),
        asker('- [blocker] a.ts:4 — b — a', () => 'confirmed\ny').ask,
      )
      assert.strictEqual(roundClean(blocker), false)
      const second = yield* runRound(
        config,
        input(2, lines),
        asker('- [warning] a.ts:3 — w — a', () => 'confirmed\ny').ask,
      )
      assert.deepStrictEqual(second.blocking, ['blocker', 'warning'])
      assert.strictEqual(roundClean(second), false)
      assert.deepStrictEqual(closeRound([], second, [], 2), [], 'a warning up to round 2 stays open')
    }),
  )

  it.effect('an optional agent never widens the next range: neither its failure nor an unreadable line', () =>
    Effect.gen(function* () {
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
      const ask: Ask = (qs) =>
        Effect.sync(() =>
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
          ),
        )
      const result = yield* runRound(optional, input(1, { 3: 'x' }), ask)
      assert.deepStrictEqual(result.partial, [])
      assert.deepStrictEqual(
        result.skipped.map((s) => [s.agent, s.error]),
        [['opencode x/free', '1 finding lines that cannot be read']],
      )
      assert.strictEqual(result.findings.length, 1, 'its readable findings stand')
      assert.strictEqual(reviewedAfter(result, 'h0', 'h1'), 'h1')

      const quota = yield* runRound(optional, input(1, {}), (qs) =>
        Effect.sync(() =>
          qs.map((q) =>
            q.agent.optional
              ? { ok: false as const, error: 'opencode exited 1: 429 Too Many Requests' }
              : { ok: true as const, reply: { text: 'no findings', session: 's', cost: null, tokens: null } },
          ),
        ),
      )
      assert.strictEqual(quota.skipped.length, 1)
      assert.strictEqual(reviewedAfter(quota, 'h0', 'h1'), 'h1')
      assert.strictEqual(
        reviewedAfter({ ...quota, failed: [{ lens: 'code', agent: 'a', error: 'e' }] }, 'h0', 'h1'),
        'h0',
      )
    }),
  )
})

// A finding on a line the branch did not write, which the change does not contradict: the
// reviewer marks it, lntt keeps the mark only on a line the branch left untouched.
describe('a pre-existing finding', () => {
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
  const input = (n: number, lines: Record<number, string>, written: number[] = []) => ({
    base: 'mb',
    head: `h${n}`,
    files: ['a.ts'],
    diff: 'D',
    records: '',
    range: roundRange(
      n === 1 ? null : ({ branch: 'b', round: n - 1, reviewed: 'h0' } as ReviewState),
      'b',
      'h',
      'mb',
      () => true,
    ),
    cite: (_path: string, line: number | null) => Effect.succeed({ text: lines[line ?? 0] ?? null }),
    untouched: (path: string, line: number) => path !== 'a.ts' || !written.includes(line),
  })
  function asker(review: string, verify = 'confirmed\ny') {
    const prompts: string[] = []
    const ask: Ask = (qs) =>
      Effect.sync(() =>
        qs.map((q) => {
          prompts.push(q.prompt)
          const text = q.prompt.startsWith('You are reviewing') ? review : verify
          return { ok: true as const, reply: { text, session: 's', cost: null, tokens: null } }
        }),
      )
    return { ask, prompts }
  }

  it.effect('on an untouched line it goes to no verifier, never blocks, and the round is clean', () =>
    Effect.gen(function* () {
      const { ask, prompts } = asker('- [blocker] [pre-existing] a.ts:9 — old — a')
      const result = yield* runRound(config, input(1, { 9: 'old line' }, [1]), ask)
      assert.strictEqual(prompts.length, 1, 'no verifier is asked')
      assert.deepStrictEqual(result.findings, [])
      assert.deepStrictEqual(
        result.preexisting.map((f) => [f.id, f.severity, f.path, f.line, f.cited]),
        [['f1', 'blocker', 'a.ts', 9, 'old line']],
      )
      assert.strictEqual(roundClean(result), true)
      assert.match(prompts[0] as string, /\[pre-existing\]/, 'the reviewers are told how to mark one')
    }),
  )

  it.effect('on a line the branch wrote, or with no line, the mark is dropped: reported as today, and it blocks', () =>
    Effect.gen(function* () {
      const touched = yield* runRound(
        config,
        input(1, { 1: 'new line' }, [1]),
        asker('- [warning] [pre-existing] a.ts:1 — w — a').ask,
      )
      assert.deepStrictEqual(touched.preexisting, [])
      assert.deepStrictEqual(
        touched.findings.map((f) => [f.id, f.verdict, f.preexisting]),
        [['f1', 'confirmed', undefined]],
      )
      assert.strictEqual(roundClean(touched), false)

      const loose = yield* runRound(config, input(1, {}), asker('- [warning] [pre-existing] a.ts — w — a').ask)
      assert.deepStrictEqual(loose.preexisting, [])
      assert.strictEqual(loose.findings.length, 1)
      assert.strictEqual(roundClean(loose), false)

      const blind = yield* runRound(
        config,
        { ...input(1, { 9: 'x' }), untouched: undefined },
        asker('- [warning] [pre-existing] a.ts:9 — w — a').ask,
      )
      assert.deepStrictEqual(blind.preexisting, [], 'with nothing to tell untouched lines, none is')

      // A file that is not there may be one the change deletes: its verifiers decide.
      const deleted = yield* runRound(
        config,
        { ...input(1, {}), cite: () => Effect.succeed({ missing: 'no such file', what: 'file' as const }) },
        asker('- [warning] [pre-existing] gone.ts:2 — w — a').ask,
      )
      assert.deepStrictEqual(deleted.preexisting, [])
      assert.deepStrictEqual(
        deleted.findings.map((f) => [f.path, f.verdict, f.preexisting]),
        [['gone.ts', 'confirmed', undefined]],
      )
    }),
  )

  it.effect(
    'an unmarked finding on an untouched line, which the change contradicts, is reported as today and blocks',
    () =>
      Effect.gen(function* () {
        const result = yield* runRound(
          config,
          input(1, { 51: 'Orca 1.2' }, [1]),
          asker('- [warning] a.ts:51 — the change makes this wrong — fix it').ask,
        )
        assert.deepStrictEqual(result.preexisting, [])
        assert.deepStrictEqual(
          result.findings.map((f) => [f.id, f.verdict]),
          [['f1', 'confirmed']],
        )
        assert.strictEqual(roundClean(result), false)
      }),
  )

  it.effect('the ledger keeps it: the next round does not report it again; an unmarked finding there is verified', () =>
    Effect.gen(function* () {
      const lines = { 9: 'old line' }
      const first = yield* runRound(
        config,
        input(1, lines, [1]),
        asker('- [warning] [pre-existing] a.ts:9 — old — a').ask,
      )
      const ledger = closeRound([], first, [], config.warningRounds)
      assert.deepStrictEqual(
        ledger.map((c) => [c.id, c.outcome, c.cited, c.reason]),
        [['f1', 'pre-existing', 'old line', 'on a line the change did not touch: listed for the person']],
      )
      assert.deepStrictEqual(closeRound(ledger, first, [], 2), ledger, 'closed once')

      const again = asker('- [warning] [pre-existing] a.ts:9 — stale — a')
      const second = yield* runRound(config, { ...input(2, lines, [1]), closed: ledger }, again.ask, first.findings)
      assert.strictEqual(again.prompts.length, 1)
      assert.match(again.prompts[0] as string, /- f1 \(warning\) `a\.ts:9` — old — pre-existing:/)
      assert.deepStrictEqual(second.preexisting, [], 'not reported again')
      assert.deepStrictEqual(
        second.closed.map((f) => [f.id, f.closedBy]),
        [['f2', 'f1']],
      )
      assert.deepStrictEqual(closeRound(ledger, second, [], 2), ledger)
      assert.strictEqual(roundClean(second), true)

      const contradicted = asker('- [warning] a.ts:9 — now contradicted — fix')
      const third = yield* runRound(config, { ...input(2, lines, [1]), closed: ledger }, contradicted.ask)
      assert.deepStrictEqual(third.closed, [])
      assert.deepStrictEqual(
        third.findings.map((f) => [f.id, f.verdict]),
        [['f2', 'confirmed']],
      )
      const verify = contradicted.prompts.find((p) => p.startsWith('You are checking')) as string
      assert.notMatch(verify, /f1 \(warning\)/, 'the verifier is not told to refute it as a repeat')
      assert.strictEqual(roundClean(third), false)
    }),
  )

  it.effect('an empty delta reports none', () =>
    Effect.gen(function* () {
      const empty = yield* runRound(config, { ...input(2, {}), files: [] }, asker('').ask, [])
      assert.deepStrictEqual(empty.preexisting, [])
    }),
  )
})
