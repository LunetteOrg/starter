import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Gh } from '../../src/ci/candidate.ts'
import { type ProvedInput, proved } from '../../src/ci/proved.ts'

const R = 'acme/app'
const SHA = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const BEFORE = 'c'.repeat(40)
const TREE = 'f'.repeat(40)

const input: ProvedInput = {
  repo: R,
  sha: SHA,
  before: BEFORE,
  branch: 'main',
  workflow: 'ci.yml',
  jobs: ['ci'],
  step: 'Full CI',
}

type Api = Record<string, unknown>

// The GitHub API of a push that rebase-merged a pull request up to date with main, whose
// full CI is green on its head; each test breaks one answer.
function api(): Api {
  return {
    [`repos/${R}/git/commits/${SHA}`]: { tree: { sha: TREE } },
    [`repos/${R}/git/commits/${HEAD}`]: { tree: { sha: TREE } },
    [`repos/${R}/commits/${SHA}/pulls`]: [
      { number: 7, merged_at: '2026-10-27T10:00:00Z', base: { ref: 'main' }, head: { sha: HEAD } },
    ],
    [`repos/${R}/compare/${BEFORE}...${HEAD}`]: { status: 'ahead' },
    [`repos/${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=100`]: {
      workflow_runs: [
        { id: 11, event: 'pull_request', status: 'completed', conclusion: 'success', html_url: 'https://run/11' },
      ],
    },
    [`repos/${R}/actions/runs/11/jobs?per_page=100`]: {
      jobs: [
        {
          name: 'ci',
          conclusion: 'success',
          steps: [
            { name: 'Run pnpm test', conclusion: 'success' },
            { name: 'Full CI', conclusion: 'success' },
          ],
        },
      ],
    },
  }
}

function fake(answers: Api): Gh {
  return {
    read: (args) => {
      assert.equal(args[0], 'api')
      const path = args[1] as string
      if (!(path in answers)) throw new Error(`Command failed: gh api: HTTP 404 ${path}`)
      const answer = answers[path]
      if (answer instanceof Error) throw answer
      return JSON.stringify(answer)
    },
    write: () => {
      throw new Error('lntt ci proved never writes')
    },
  }
}

function check(answers: Api, over: Partial<ProvedInput> = {}) {
  return proved(fake(answers), { ...input, ...over })
}

// The reason of a refusal; a tree proved reads `(proved)`, which no refusal matches.
function refusal(answers: Api, over: Partial<ProvedInput> = {}): string {
  const result = check(answers, over)
  return result.proved ? '(proved)' : result.reason
}

describe('lntt ci proved', () => {
  test('proved: same tree, the base an ancestor of the head, the full CI green on the head', () => {
    const result = check(api())
    assert.equal(result.proved, true)
    assert.match(result.reason, /#7/)
    assert.match(result.reason, /https:\/\/run\/11/)
  })

  test('a base identical to the head proves too', () => {
    const a = api()
    a[`repos/${R}/compare/${BEFORE}...${HEAD}`] = { status: 'identical' }
    assert.equal(check(a).proved, true)
  })

  test('a different tree is not proved', () => {
    const a = api()
    a[`repos/${R}/git/commits/${HEAD}`] = { tree: { sha: 'd'.repeat(40) } }
    assert.match(refusal(a), /tree/)
  })

  test('a push no pull request explains is not proved', () => {
    const a = api()
    a[`repos/${R}/commits/${SHA}/pulls`] = []
    assert.match(refusal(a), /no merged pull request/)
  })

  test('a pull request merged into another branch, or not merged, does not count', () => {
    const a = api()
    a[`repos/${R}/commits/${SHA}/pulls`] = [
      { number: 7, merged_at: '2026-10-27T10:00:00Z', base: { ref: 'candidate/9' }, head: { sha: HEAD } },
      { number: 8, merged_at: null, base: { ref: 'main' }, head: { sha: HEAD } },
    ]
    assert.match(refusal(a), /no merged pull request/)
  })

  test('two merged pull requests are ambiguous', () => {
    const a = api()
    const pr = { merged_at: '2026-10-27T10:00:00Z', base: { ref: 'main' }, head: { sha: HEAD } }
    a[`repos/${R}/commits/${SHA}/pulls`] = [
      { number: 7, ...pr },
      { number: 8, ...pr },
    ]
    assert.match(refusal(a), /#7, #8/)
  })

  test('a head that does not contain the previous tip of the branch is not proved', () => {
    for (const status of ['behind', 'diverged']) {
      const a = api()
      a[`repos/${R}/compare/${BEFORE}...${HEAD}`] = { status }
      assert.match(refusal(a), /ancestor/)
    }
  })

  test('a push with no previous tip (a new branch) is not proved', () => {
    assert.match(refusal(api(), { before: '0'.repeat(40) }), /previous tip/)
    assert.match(refusal(api(), { before: '' }), /previous tip/)
  })

  test('no run of the workflow on the head is not proved', () => {
    const a = api()
    a[`repos/${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=100`] = { workflow_runs: [] }
    assert.match(refusal(a), /no pull request run/)
  })

  test('a push run, or one still in progress, proves nothing', () => {
    for (const run of [
      { id: 11, event: 'push', status: 'completed', conclusion: 'success' },
      { id: 11, event: 'pull_request', status: 'in_progress', conclusion: null },
    ]) {
      const a = api()
      a[`repos/${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=100`] = { workflow_runs: [run] }
      assert.match(refusal(a), /no pull request run/)
    }
  })

  test('a job that failed, was skipped or is missing proves nothing', () => {
    for (const jobs of [
      [{ name: 'ci', conclusion: 'failure', steps: [{ name: 'Full CI', conclusion: 'skipped' }] }],
      [{ name: 'ci', conclusion: 'skipped', steps: [] }],
      [{ name: 'lint', conclusion: 'success', steps: [{ name: 'Full CI', conclusion: 'success' }] }],
    ]) {
      const a = api()
      a[`repos/${R}/actions/runs/11/jobs?per_page=100`] = { jobs }
      assert.match(refusal(a), /no pull request run/)
    }
  })

  test('a green run at the minimal level (the marker step skipped) proves nothing', () => {
    const a = api()
    a[`repos/${R}/actions/runs/11/jobs?per_page=100`] = {
      jobs: [{ name: 'ci', conclusion: 'success', steps: [{ name: 'Full CI', conclusion: 'skipped' }] }],
    }
    assert.match(refusal(a), /no pull request run/)
  })

  test('without a marker step, the green jobs prove the tree', () => {
    const a = api()
    a[`repos/${R}/actions/runs/11/jobs?per_page=100`] = { jobs: [{ name: 'ci', conclusion: 'success', steps: [] }] }
    assert.equal(check(a, { step: undefined }).proved, true)
  })

  test('every named job must be green in the same run', () => {
    const a = api()
    a[`repos/${R}/actions/runs/11/jobs?per_page=100`] = {
      jobs: [
        { name: 'ci', conclusion: 'success', steps: [] },
        { name: 'e2e', conclusion: 'cancelled', steps: [] },
      ],
    }
    assert.match(refusal(a, { jobs: ['ci', 'e2e'], step: undefined }), /no pull request run/)
  })

  test('a red run beside a green one: the green one proves', () => {
    const a = api()
    a[`repos/${R}/actions/workflows/ci.yml/runs?head_sha=${HEAD}&per_page=100`] = {
      workflow_runs: [
        { id: 10, event: 'pull_request', status: 'completed', conclusion: 'failure' },
        {
          id: 11,
          event: 'pull_request_review',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://run/11',
        },
      ],
    }
    a[`repos/${R}/actions/runs/10/jobs?per_page=100`] = { jobs: [{ name: 'ci', conclusion: 'failure', steps: [] }] }
    assert.equal(check(a).proved, true)
  })

  test('an API error is not proved, never thrown', () => {
    const a = api()
    a[`repos/${R}/compare/${BEFORE}...${HEAD}`] = new Error('Command failed: gh api: HTTP 502')
    assert.match(refusal(a), /HTTP 502/)
    assert.match(refusal({}), /404/)
  })

  test('an answer of the wrong shape is not proved', () => {
    const a = api()
    a[`repos/${R}/git/commits/${SHA}`] = { tree: null }
    assert.match(refusal(a), /tree/)
  })

  test('a malformed input is not proved', () => {
    assert.match(refusal(api(), { sha: 'HEAD' }), /sha/)
    assert.match(refusal(api(), { jobs: [] }), /job/)
  })
})
