import { assert, describe, it } from '@effect/vitest'
import {
  AUTOMATED_MARKER,
  automatedEntries,
  automatedLine,
  automatedResults,
  matchAutomated,
  syncedWorkflows,
  workflowFiles,
} from './automated.ts'

const DEPENDABOT = { author: 'dependabot[bot]', branch: 'dependabot/', runs: 'after-approval', ci: 'full' } as const
const RENOVATE = { author: 'renovate[bot]', branch: 'renovate/', runs: 'always', ci: 'minimal' } as const

describe('matchAutomated', () => {
  const entries = [DEPENDABOT, RENOVATE]

  it('an entry matches its author and its branch prefix, both', () => {
    assert.strictEqual(matchAutomated(entries, { author: 'dependabot[bot]', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.strictEqual(matchAutomated(entries, { author: 'renovate[bot]', headRef: 'renovate/vite' }), RENOVATE)
    assert.strictEqual(matchAutomated(entries, { author: 'octocat', headRef: 'dependabot/npm/x' }), null)
    assert.strictEqual(matchAutomated(entries, { author: 'dependabot[bot]', headRef: 'feat/1/x' }), null)
    assert.strictEqual(matchAutomated(entries, { author: 'renovate[bot]', headRef: 'dependabot/npm/x' }), null)
    assert.strictEqual(matchAutomated(entries, { headRef: 'dependabot/npm/x' }), null)
  })

  it("gh's names for a bot match its event login: app/<slug> and the bare slug", () => {
    assert.strictEqual(matchAutomated(entries, { author: 'app/dependabot', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.strictEqual(matchAutomated(entries, { author: 'dependabot', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.strictEqual(matchAutomated([], { author: 'dependabot[bot]', headRef: 'dependabot/npm/x' }), null)
  })

  it('the entries come from delivery.automated, none without it', () => {
    assert.deepStrictEqual(automatedEntries({ delivery: { automated: [DEPENDABOT] } }), [DEPENDABOT])
    assert.deepStrictEqual(automatedEntries({}), [])
  })
})

describe('the synced line', () => {
  const workflow = (line: string) =>
    `name: CI\njobs:\n  ci:\n    steps:\n      - env:\n          ${line}\n        run: echo "$AUTOMATED"\n`
  const data = (entries: unknown[]) => ({ delivery: { automated: entries } })

  it('is the minified entries, single-quoted, with the marker', () => {
    assert.strictEqual(
      automatedLine('AUTOMATED', [DEPENDABOT]),
      `AUTOMATED: '[{"author":"dependabot[bot]","branch":"dependabot/","runs":"after-approval","ci":"full"}]' ${AUTOMATED_MARKER}`,
    )
    // YAML doubles a single quote inside single quotes.
    assert.match(automatedLine('A', [{ ...DEPENDABOT, branch: "it's/" }]), /"it''s\/"/)
  })

  it('every marked line is rewritten, keeping its key and indent; other workflows are left alone', () => {
    const workflows = [
      { path: '.github/workflows/ci.yml', text: workflow(`AUTOMATED: '[]' ${AUTOMATED_MARKER}`) },
      { path: '.github/workflows/other.yml', text: 'name: Other\n' },
    ]
    assert.deepStrictEqual(automatedResults(workflows, data([DEPENDABOT]))[0]?.status, 'FAIL')
    const synced = syncedWorkflows(workflows, data([DEPENDABOT]))
    assert.deepStrictEqual(synced, [
      { path: '.github/workflows/ci.yml', text: workflow(automatedLine('AUTOMATED', [DEPENDABOT])) },
    ])
    assert.deepStrictEqual(syncedWorkflows(synced, data([DEPENDABOT])), [], 'a second sync writes nothing')
    assert.deepStrictEqual(
      automatedResults(synced, data([DEPENDABOT])).map((r) => [r.status, r.path, r.line]),
      [['PASS', '.github/workflows/ci.yml', 6]],
    )
  })

  it('a line that drifted from the configuration fails, naming the fix', () => {
    const workflows = [{ path: '.github/workflows/ci.yml', text: workflow(automatedLine('AUTOMATED', [DEPENDABOT])) }]
    const [result] = automatedResults(workflows, data([DEPENDABOT, RENOVATE]))
    assert.deepStrictEqual([result?.status, result?.line], ['FAIL', 6])
    assert.match(result?.message ?? '', /delivery\.automated.*lntt sync/)
  })

  it('the workflows are the .yml and .yaml files, sorted; with no marked line there is nothing to check', () => {
    assert.deepStrictEqual(workflowFiles(['b.yaml', 'README.md', 'a.yml']), [
      '.github/workflows/a.yml',
      '.github/workflows/b.yaml',
    ])
    assert.deepStrictEqual(
      automatedResults([{ path: '.github/workflows/ci.yml', text: 'name: CI\n' }], data([DEPENDABOT])).map(
        (r) => r.status,
      ),
      ['NOT RUN'],
    )
    assert.deepStrictEqual(
      automatedResults([], data([DEPENDABOT])).map((r) => r.status),
      ['NOT RUN'],
    )
  })
})
