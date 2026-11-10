import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type Ask,
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
        '- [note] src/a.ts:4 — no test fails when the guard goes — test the empty input; mutate: `if (!x) return` => `` ',
        '- [note] src/a.ts:9 — the sign is untested — assert a negative; mutate: `a > b` → `a < b`.',
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

  test('two mutations of one line are two findings', () => {
    const agent = { kind: 'claude' as const, model: 'sonnet' }
    const findings = parseFindings(
      '- [note] a.ts:1 — one; mutate: `a` => `b`\n- [note] a.ts:1 — two; mutate: `c` => `d`\n- [note] a.ts:1 — three; mutate: `a` => `b`',
    )
    const merged = mergeFindings([{ lens: 'tests', agent, session: null, findings }])
    assert.equal(merged.length, 2)
    assert.equal(merged.find((f) => f.mutation?.text === 'a')?.foundBy.length, 2)
  })

  test('the tests brief asks for a note with the mutation, for the author to run by hand, in the form the parser reads', () => {
    const prompt = renderReviewPrompt('tests', { base: 'b', head: 'h', files: ['a.test.ts'], diff: '', records: '' })
    assert.match(prompt, /- \[note\] path:line — .*; mutate: `text on the line` => `mutated text`\n/)
    assert.match(prompt, /by hand/)
    // nothing in the brief promises a run that decides the finding
    assert.doesNotMatch(prompt, /`lntt` does|survives confirms|killed\s+refutes/)
    const [parsed] = parseFindings(
      '- [note] src/a.ts:3 — no test fails when it flips — add one; mutate: `text on the line` => `mutated text`',
    )
    assert.deepEqual(parsed?.mutation, { text: 'text on the line', to: 'mutated text' })
  })
})

describe('a finding with a mutation in a round', () => {
  test('is verified by reading at its severity, like any other: nothing runs it', async () => {
    const config = reviewConfig({
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            code: { with: [] },
            tests: { with: [{ kind: 'claude', model: 'sonnet' }] },
          },
          verify: { with: [{ kind: 'claude', model: 'opus' }], severities: ['blocker', 'warning'] },
        },
      },
    })
    const review = [
      '- [warning] a.ts:1 — survives — add a test; mutate: `x > 1` => `x >= 1`',
      '- [note] a.ts:2 — may survive — try it; mutate: `y` => `z`',
      '- [warning] a.ts:4 — no mutation — look',
    ].join('\n')
    const verified: string[] = []
    const ask: Ask = async (jobs) =>
      jobs.map((job) => {
        if (job.label?.startsWith('verify')) verified.push(job.label.split(' ')[1] as string)
        const text = job.label?.startsWith('verify') ? 'confirmed\nread it' : review
        return { ok: true as const, reply: { text, session: 's', cost: null, tokens: null } }
      })
    const r = await runRound(
      config,
      {
        base: 'mb',
        head: 'h2',
        files: ['a.test.ts'],
        diff: 'DIFF',
        records: 'R',
        range: roundRange(null, 'b', 'h2', 'mb', () => true),
      },
      ask,
    )
    assert.deepEqual(verified.sort(), ['f1', 'f2'])
    assert.deepEqual(
      r.findings.map((f) => [f.line, f.verdict, f.proofs.map((p) => p.by)]),
      [
        [1, 'confirmed', ['claude opus']],
        [4, 'confirmed', ['claude opus']],
        [2, 'unverified', []],
      ],
    )
    assert.deepEqual(r.findings.find((f) => f.line === 2)?.mutation, { text: 'y', to: 'z' })
  })
})

// Through lntt review: a fake claude proposes mutations; the project's test commands and git's
// post-checkout hook (which `git worktree add` runs) write to a log that must stay empty.
const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs'
let prompt = ''
process.stdin.on('data', (d) => (prompt += d)).on('end', () => {
  const kind = prompt.startsWith('You are reviewing') ? 'REVIEW' : 'VERIFY'
  fs.appendFileSync(process.env.FAKE_LOG, kind + '\\n')
  if (kind === 'REVIEW') fs.writeFileSync(process.env.FAKE_PROMPT, prompt)
  const result = process.env['FAKE_' + kind] || 'no findings'
  process.stdout.write(JSON.stringify({ result: result.replace(/\\\\n/g, '\\n'), session_id: 's', is_error: false }))
})
`

describe('lntt review runs no test', () => {
  let repo: string

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-review-no-test-')))
    cpSync(join(HERE, 'fixtures/tests/mutate'), repo, { recursive: true })
    mkdirSync(join(repo, '.fakebin'))
    mkdirSync(join(repo, '.tmp'))
    writeFileSync(join(repo, '.fakebin/claude'), FAKE_CLAUDE)
    chmodSync(join(repo, '.fakebin/claude'), 0o755)
    writeFileSync(join(repo, '.fakelog'), '')
    writeFileSync(join(repo, '.runlog'), '')
    writeFileSync(join(repo, '.gitignore'), '.fakebin\n.fakelog\n.fakeprompt\n.runlog\n.tmp\n')
    const log = join(repo, '.runlog')
    const config = {
      tests: {
        levels: [
          {
            name: 'unit',
            files: ['test/*.test.ts'],
            run: `echo run >> '${log}' && node --test {files}`,
            coverage: `echo coverage >> '${log}' && node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination={out}/lcov.info {files}`,
          },
        ],
      },
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
    }
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-qm', 'base')
    // The clone has fetched main: the round reads from origin/main.
    git('update-ref', 'refs/remotes/origin/main', 'main')
    git('switch', '-qc', 'feat/1/x')
    // A source line and its test both change: touched has a line to place.
    writeFileSync(join(repo, 'src/price.ts'), `// changed\n${readFileSync(join(repo, 'src/price.ts'), 'utf8')}`)
    writeFileSync(
      join(repo, 'test/price.test.ts'),
      `${readFileSync(join(repo, 'test/price.test.ts'), 'utf8')}\n// one more\n`,
    )
    git('commit', '-qam', 'change')
    // From here on, a worktree added in this repository leaves a line in the log.
    writeFileSync(join(repo, '.git/hooks/post-checkout'), `#!/bin/sh\necho worktree >> '${log}'\n`)
    chmodSync(join(repo, '.git/hooks/post-checkout'), 0o755)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('a round whose tests lens proposes a mutation starts no test process and adds no worktree; touched comes from the imports', () => {
    const review = [
      '- [warning] src/price.ts:8 — the boundary is untested — assert 100; mutate: `total > 100` => `total >= 100`',
      "- [note] src/price.ts:8 — the label may survive a swap — try it by hand; mutate: `'big' : 'small'` => `'small' : 'big'`",
    ].join('\\n')
    const r = spawnSync(process.execPath, [BIN, 'review'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        HOME: repo,
        TMPDIR: join(repo, '.tmp'),
        PATH: [join(repo, '.fakebin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        FAKE_LOG: join(repo, '.fakelog'),
        FAKE_PROMPT: join(repo, '.fakeprompt'),
        FAKE_REVIEW: review,
        FAKE_VERIFY: 'confirmed\\nsrc/price.ts:8 reads it',
      },
    })
    assert.equal(r.status, 1, r.stderr)
    assert.equal(readFileSync(join(repo, '.runlog'), 'utf8'), '')
    assert.equal(git('worktree', 'list').split('\n').length, 1)
    assert.match(
      readFileSync(join(repo, '.fakeprompt'), 'utf8'),
      /src\/price\.ts[^\n]*from imports \(coverage not run\): test\/price\.test\.ts/,
    )
    const { findings } = JSON.parse(
      spawnSync(process.execPath, [BIN, 'review', 'status', '--json'], {
        cwd: repo,
        encoding: 'utf8',
        env: { HOME: repo, PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':') },
      }).stdout,
    ).state as { findings: Checked[] }
    assert.deepEqual(
      findings.map((f) => [f.severity, f.verdict, f.proofs.map((p) => p.by), f.mutation?.to]),
      [
        ['warning', 'confirmed', ['claude opus'], 'total >= 100'],
        ['note', 'unverified', [], "'small' : 'big'"],
      ],
    )
    assert.equal(git('status', '--porcelain'), '')
  })
})
