import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type Ask,
  agentLabel,
  type Checked,
  mergeFindings,
  parseFindings,
  renderReviewPrompt,
  reviewConfig,
  roundRange,
  runRound,
} from '../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

describe('a mutation a reviewer proposes', () => {
  test('closes a finding line: the text on the line, an arrow, the mutated text', () => {
    const [a, b, c] = parseFindings(
      [
        '- [warning] src/a.ts:4 — no test fails when the guard goes — test the empty input; mutate: `if (!x) return` => `` ',
        '- [warning] src/a.ts:9 — the sign is untested — assert a negative; mutate: `a > b` → `a < b`.',
        '- [note] src/a.ts:12 — plain finding — no mutation',
      ].join('\n'),
    )
    assert.deepEqual(a?.mutation, { text: 'if (!x) return', to: '' })
    assert.equal(a?.what, 'no test fails when the guard goes')
    assert.equal(a?.action, 'test the empty input')
    assert.deepEqual(b?.mutation, { text: 'a > b', to: 'a < b' })
    assert.equal(b?.action, 'assert a negative')
    assert.equal(c?.mutation, undefined)
  })

  test('two mutations of one line are two findings, each its own run', () => {
    const agent = { kind: 'claude' as const, model: 'sonnet' }
    const findings = parseFindings(
      '- [warning] a.ts:1 — one; mutate: `a` => `b`\n- [warning] a.ts:1 — two; mutate: `c` => `d`\n- [warning] a.ts:1 — three; mutate: `a` => `b`',
    )
    const merged = mergeFindings([{ lens: 'tests', agent, session: null, findings }])
    assert.equal(merged.length, 2)
    assert.equal(merged.find((f) => f.mutation?.text === 'a')?.foundBy.length, 2)
  })

  test('the tests brief asks for the form the parser reads', () => {
    const prompt = renderReviewPrompt('tests', { base: 'b', head: 'h', files: ['a.test.ts'], diff: '', records: '' })
    assert.match(prompt, /; mutate: `text on the line` => `mutated text`\n/)
    const [parsed] = parseFindings(
      '- [warning] src/a.ts:3 — no test fails when it flips — add one; mutate: `text on the line` => `mutated text`',
    )
    assert.deepEqual(parsed?.mutation, { text: 'text on the line', to: 'mutated text' })
  })
})

describe('a mutation in a round', () => {
  const config = reviewConfig({
    delivery: {
      review: {
        reviewers: {
          decisions: { with: [] },
          code: { with: [] },
          tests: { with: [{ kind: 'claude', model: 'sonnet' }] },
        },
        verify: { with: [{ kind: 'claude', model: 'opus' }] },
      },
    },
  })
  const input = {
    base: 'mb',
    head: 'h2',
    files: ['a.test.ts'],
    diff: 'DIFF',
    records: 'R',
    range: roundRange(null, 'b', 'h2', 'mb', () => true),
  }
  const review =
    '- [warning] a.ts:1 — survives — add a test; mutate: `x > 1` => `x >= 1`\n- [warning] a.ts:2 — dies — none needed; mutate: `y` => `z`\n- [warning] a.ts:3 — cannot run — maybe; mutate: `p` => `q`\n- [warning] a.ts:4 — no mutation — look'

  function run(answers: { decided: 'killed' | 'survived' | null; proof: string }[]) {
    const verified: string[] = []
    const asked: { path: string; line: number; text: string; to: string }[][] = []
    const ask: Ask = async (jobs) =>
      jobs.map((job) => {
        if (job.label?.startsWith('verify')) verified.push(job.label)
        const text = job.label?.startsWith('verify') ? 'confirmed\nread it' : review
        return { ok: true as const, reply: { text, session: 's', cost: null, tokens: null } }
      })
    return {
      verified,
      asked,
      result: runRound(
        config,
        {
          ...input,
          mutate: async (m) => {
            asked.push(m)
            return answers
          },
        },
        ask,
      ),
    }
  }

  test('a surviving mutant confirms its finding and a killed one refutes it, with no verifier asked about either', async () => {
    const { verified, asked, result } = run([
      { decided: 'survived', proof: 'survived: tests still pass' },
      { decided: 'killed', proof: 'killed by a test' },
      { decided: null, proof: 'level unit fails without the mutation' },
    ])
    const r = await result
    assert.deepEqual(
      asked[0]?.map((m) => `${m.path}:${m.line} ${m.text}`),
      ['a.ts:1 x > 1', 'a.ts:2 y', 'a.ts:3 p'],
    )
    assert.deepEqual(
      r.findings.map((f) => [f.path, f.line, f.verdict]),
      [
        ['a.ts', 1, 'confirmed'],
        ['a.ts', 3, 'confirmed'],
        ['a.ts', 4, 'confirmed'],
      ],
    )
    const survived = r.findings.find((f) => f.line === 1) as Checked
    assert.deepEqual(survived.proofs, [
      { by: 'lntt check tests mutate', outcome: 'confirmed', proof: 'survived: tests still pass' },
    ])
    assert.deepEqual(
      r.refuted.map((f) => [f.line, f.verdict, f.proofs[0]?.by]),
      [[2, 'refuted', 'lntt check tests mutate']],
    )
    // only the one that could not run and the one without a mutation go to the verifiers
    assert.deepEqual(verified.map((l) => l.split(' ')[1]).sort(), ['f3', 'f4'])
    const undecided = r.findings.find((f) => f.line === 3) as Checked
    assert.equal(undecided.proofs[0]?.failed, true)
    assert.equal(undecided.proofs[0]?.proof, 'level unit fails without the mutation')
  })

  test('agent labels are untouched', () => {
    assert.equal(agentLabel({ kind: 'claude', model: 'sonnet' }), 'claude sonnet')
  })
})

// The same through lntt review: a fake claude proposes mutations, the real tests run.
const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs'
let prompt = ''
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  const kind = prompt.startsWith('You are reviewing') ? 'REVIEW' : 'VERIFY'
  fs.appendFileSync(process.env.FAKE_LOG, kind + '\\n')
  const result = process.env['FAKE_' + kind] || 'no findings'
  process.stdout.write(JSON.stringify({ result: result.replace(/\\\\n/g, '\\n'), session_id: 's', is_error: false }))
})
`

describe('lntt review with mutations', () => {
  let repo: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-mutate-')))
    cpSync(join(HERE, 'fixtures/tests/mutate'), repo, { recursive: true })
    mkdirSync(join(repo, '.fakebin'))
    writeFileSync(join(repo, '.fakebin/claude'), FAKE_CLAUDE)
    chmodSync(join(repo, '.fakebin/claude'), 0o755)
    writeFileSync(join(repo, '.fakelog'), '')
    writeFileSync(join(repo, '.gitignore'), '.fakebin\n.fakelog\n')
    const config = JSON.parse(readFileSync(join(repo, '.agents/config.jsonc'), 'utf8'))
    config.delivery = {
      review: {
        reviewers: {
          decisions: { with: [] },
          code: { with: [] },
          tests: { with: [{ kind: 'claude', model: 'sonnet' }] },
        },
        verify: { with: [{ kind: 'claude', model: 'opus' }] },
      },
    }
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('switch', '-qc', 'feat/1/x')
    writeFileSync(
      join(repo, 'test/price.test.ts'),
      `${readFileSync(join(repo, 'test/price.test.ts'), 'utf8')}\n// one more\n`,
    )
    git('commit', '-qam', 'change')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a surviving mutant is a confirmed finding, a killed one is refuted, the working tree stays as it was', () => {
    const before = readFileSync(join(repo, 'src/price.ts'), 'utf8')
    const review = [
      '- [warning] src/price.ts:7 — the boundary is untested — assert 100; mutate: `total > 100` => `total >= 100`',
      "- [warning] src/price.ts:7 — the label is untested — assert it; mutate: `'big' : 'small'` => `'small' : 'big'`",
    ].join('\\n')
    const r = spawnSync(process.execPath, [BIN, 'review'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        HOME: repo,
        PATH: [join(repo, '.fakebin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: join(repo, '.fakelog'),
        FAKE_REVIEW: review,
      },
    })
    assert.equal(r.status, 1, r.stderr)
    const out = JSON.parse(r.stdout) as { findings: Checked[]; refuted: Checked[] }
    assert.deepEqual(
      out.findings.map((f) => [f.what, f.verdict, f.proofs.map((p) => p.by)]),
      [['the boundary is untested', 'confirmed', ['lntt check tests mutate']]],
    )
    assert.match(out.findings[0]?.proofs[0]?.proof ?? '', /survived/)
    assert.deepEqual(
      out.refuted.map((f) => [f.what, f.verdict]),
      [['the label is untested', 'refuted']],
    )
    assert.match(out.refuted[0]?.proofs[0]?.proof ?? '', /killed by a small basket is small/)
    // no verifier was asked: the run was the proof
    assert.ok(!readFileSync(join(repo, '.fakelog'), 'utf8').includes('VERIFY'))
    assert.equal(readFileSync(join(repo, 'src/price.ts'), 'utf8'), before)
    assert.equal(git('status', '--porcelain'), '')
    assert.equal(git('worktree', 'list').split('\n').length, 1)
  })
})
