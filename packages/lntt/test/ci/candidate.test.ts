import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  announce,
  announceComment,
  type CandidateConfig,
  candidateBody,
  candidateMerged,
  candidateName,
  carryOver,
  carryOverDecision,
  closeCandidateIssues,
  closeDecision,
  closingReferences,
  type Gh,
  handle,
  isAnnounced,
  isCandidateMerge,
  isHotfix,
  issueNumber,
  makeGh,
  nextCandidateNumber,
  orphanCandidate,
  type PullRequest,
  pickBoard,
  type Run,
  record,
  recordMerges,
  retarget,
  retargetDecision,
  setBoardStatus,
  sweep,
  sweepDecision,
} from '../../src/ci/candidate.ts'

const config: CandidateConfig = {
  base: 'main',
  prefix: 'candidate/',
  hotfix: { prefix: 'hotfix/', label: 'hotfix' },
  status: { inRelease: 'In release', done: 'Done' },
}
// pelion's shape: release/<N>, same base and hotfix markers.
const pelion: CandidateConfig = { ...config, prefix: 'release/' }

describe('names and numbers', () => {
  test('the name is the prefix without its separator', () => {
    assert.equal(candidateName(config), 'candidate')
    assert.equal(candidateName(pelion), 'release')
    assert.equal(candidateName({ ...config, prefix: 'rc-' }), 'rc')
  })

  test('the next number is one more than the highest candidate, branch or pull request', () => {
    assert.equal(nextCandidateNumber(config, ['candidate/2', 'candidate/10', 'candidate/9']), 11)
    assert.equal(nextCandidateNumber(config, []), 1)
    assert.equal(nextCandidateNumber(config, ['candidate/x', 'candidate/3-fix', 'feat/candidate/7', 'candidate/4']), 5)
    assert.equal(nextCandidateNumber(pelion, ['release/4', 'candidate/9']), 5)
  })

  test('an orphan branch, newer than every candidate pull request, is picked up', () => {
    assert.equal(
      orphanCandidate(config, { branches: ['candidate/4', 'candidate/5'], prHeads: ['candidate/3', 'candidate/4'] }),
      'candidate/5',
    )
    assert.equal(orphanCandidate(config, { branches: ['candidate/4'], prHeads: ['candidate/4'] }), null)
    assert.equal(orphanCandidate(config, { branches: ['candidate/2'], prHeads: ['candidate/5'] }), null)
  })
})

describe('isHotfix and retargetDecision', () => {
  const pr = { baseRef: 'main', headRef: 'feat/31/x', labels: [] }

  test('a hotfix by branch prefix or by label, in any case', () => {
    assert.equal(isHotfix(config, { headRef: 'hotfix/login-500' }), true)
    assert.equal(isHotfix(config, { headRef: 'fix/12/login', labels: ['bug', 'Hotfix'] }), true)
    assert.equal(isHotfix(config, { headRef: 'fix/12/hotfix-login', labels: ['bug'] }), false)
    assert.equal(isHotfix({ ...config, hotfix: { prefix: 'urgent/', label: 'urgent' } }, { headRef: 'urgent/x' }), true)
  })

  test('a pull request into the base moves; others, candidates and hotfixes stay', () => {
    assert.equal(retargetDecision(config, pr).move, true)
    assert.equal(retargetDecision(config, { ...pr, baseRef: 'candidate/3' }).move, false)
    assert.equal(retargetDecision(config, { ...pr, headRef: 'candidate/3' }).move, false)
    assert.equal(retargetDecision(config, { ...pr, headRef: 'hotfix/x' }).move, false)
    assert.equal(retargetDecision(config, { ...pr, labels: ['hotfix'] }).move, false)
    assert.equal(retargetDecision({ ...config, base: 'trunk' }, pr).move, false)
  })
})

describe('closingReferences', () => {
  test('every keyword form, in any case, with or without a colon, once each', () => {
    const body = [
      'Closes #1',
      'closed #2',
      'CLOSE #3',
      'Fixes: #4',
      'fixed #5, fix #6',
      'Resolves #7',
      'resolved o/r#8',
      'resolve #9',
      'fixes #1',
    ].join('\n')
    assert.deepEqual(closingReferences(body), ['#1', '#2', '#3', '#4', '#5', '#6', '#7', 'o/r#8', '#9'])
  })

  test('no keyword, code and HTML comments do not count', () => {
    assert.deepEqual(closingReferences('Refs #2\nsee #3\nprefixes #4'), [])
    assert.deepEqual(closingReferences('Closes #1\n`Closes #2`\n```\nCloses #3\n```\n<!-- Closes #4 -->'), ['#1'])
    assert.deepEqual(closingReferences(null), [])
  })
})

describe('candidateBody', () => {
  test('a sentence naming the candidate, then the two empty lists', () => {
    const body = candidateBody(config, 3)
    assert.match(body, /^Candidate 3: pull requests into `main` land here/)
    assert.match(body, /<!-- candidate:prs:start -->\n<!-- candidate:prs:end -->/)
    assert.match(body, /<!-- candidate:closes:start -->\n<!-- candidate:closes:end -->/)
  })
})

describe('recordMerges', () => {
  test('adds the pull request line and its closing lines, once', () => {
    const pr = { number: 70, title: 'ci: cache', closes: ['#69', '#71'] }
    const body = recordMerges(candidateBody(config, 3), [pr])
    assert.match(body, /- #70 ci: cache\n/)
    assert.match(body, /Closes #69\nCloses #71\n/)
    assert.equal(recordMerges(body, [pr]), body)
  })

  test('lists in the order given and does not repeat a shared issue', () => {
    const later = recordMerges(candidateBody(config, 3), [{ number: 123, title: 'b', closes: ['#6'] }])
    const both = recordMerges(later, [
      { number: 12, title: 'a', closes: ['#5'] },
      { number: 123, title: 'b', closes: ['#5', '#6'] },
    ])
    assert.match(both, /- #12 a\n- #123 b\n/)
    assert.match(both, /Closes #5\nCloses #6\n/)
    assert.equal(both.match(/Closes #5/g)?.length, 1)
  })

  test('keeps lines written by hand after the rebuilt ones', () => {
    const body = candidateBody(config, 3)
      .replace('<!-- candidate:prs:end -->', '- by hand\n<!-- candidate:prs:end -->')
      .replace('<!-- candidate:closes:end -->', 'Closes #9\n<!-- candidate:closes:end -->')
    const next = recordMerges(body, [{ number: 7, title: 't', closes: ['#1'] }])
    assert.match(next, /- #7 t\n- by hand\n/)
    assert.match(next, /Closes #1\nCloses #9\n/)
  })

  test('a body without the markers gets both blocks at the end, its text kept', () => {
    const body = recordMerges('Written by hand.', [{ number: 7, title: 't', closes: ['#1'] }])
    assert.ok(body.startsWith('Written by hand.\n\n'))
    assert.match(body, /- #7 t/)
    assert.match(body, /Closes #1/)
  })
})

// A gh double: reads answered from `answers` by the first key the command line
// contains, writes recorded.
function fakeGh(answers: Record<string, unknown>): Gh & { writes: Array<{ args: string; input?: string }> } {
  const writes: Array<{ args: string; input?: string }> = []
  return {
    writes,
    read: (args) => {
      const line = args.join(' ')
      const key = Object.keys(answers).find((k) => line.includes(k))
      if (key === undefined) throw new Error(`unexpected read: ${line}`)
      return JSON.stringify(answers[key])
    },
    write: (args, input) => {
      writes.push({ args: args.join(' '), input })
      if (args[1] === 'create') return 'https://github.com/o/r/pull/42'
      if (args.includes('.sha')) return 'c0ffee'
      return ''
    },
  }
}

function issue(number: number, { state = 'open', isPr = false, comments = [] as string[] } = {}) {
  return {
    [`issues/${number}/comments`]: comments,
    [`issues/${number} `]: { state, isPr },
  }
}

const pr: PullRequest = {
  number: 70,
  title: 'ci: cache',
  body: 'Closes #69',
  baseRef: 'main',
  headRef: 'ci/69/x',
  labels: [],
  merged: false,
}
const silent = () => {}
const run = (gh: Gh, c: CandidateConfig = config): Run => ({ gh, repo: 'o/r', config: c, log: silent })

describe('retarget', () => {
  test('moves the pull request onto the open candidate and comments', () => {
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }] })
    retarget(run(gh), pr)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 70 --repo o/r --base candidate/4', 'pr comment 70 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[1].input ?? '', /candidate\/4.*#40/)
    assert.match(gh.writes[1].input ?? '', /`hotfix` label/)
  })

  test('creates the next candidate when none is open, then moves the pull request', () => {
    const gh = fakeGh({
      '--state open': [{ number: 9, headRefName: 'feat/candidate/9', body: '' }],
      'matching-refs': [{ ref: 'refs/heads/candidate/2' }],
      '--state all': [{ headRefName: 'candidate/5' }, { headRefName: 'candidate/x' }],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    retarget(run(gh), pr)
    const writes = gh.writes.map((w) => w.args)
    assert.match(writes[0], /git\/commits -f message=chore: open candidate 6 .*parents\[\]=abc12345/)
    assert.match(writes[1], /ref=refs\/heads\/candidate\/6 -f sha=c0ffee/)
    assert.match(writes[2], /pr create --repo o\/r --draft --base main --head candidate\/6 --title candidate 6/)
    assert.equal(writes[3], 'pr edit 70 --repo o/r --base candidate/6')
    assert.match(gh.writes[4].input ?? '', /#42/)
  })

  test("pelion's release/<N> works the same", () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [],
      '--state all': [{ headRefName: 'release/7' }],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    retarget(run(gh, pelion), pr)
    assert.match(gh.writes[2].args, /--head release\/8 --title release 8/)
    assert.equal(gh.writes[3].args, 'pr edit 70 --repo o/r --base release/8')
  })

  test('a branch left without its pull request is reused, pull request only', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [{ ref: 'refs/heads/candidate/6' }],
      '--state all': [{ headRefName: 'candidate/5' }],
    })
    retarget(run(gh), pr)
    assert.match(gh.writes[0].args, /pr create .*--head candidate\/6 --title candidate 6/)
    assert.equal(gh.writes[1].args, 'pr edit 70 --repo o/r --base candidate/6')
  })

  test('a hotfix is neither moved nor read about', () => {
    const gh = fakeGh({})
    retarget(run(gh), { ...pr, labels: ['hotfix'] })
    assert.deepEqual(gh.writes, [])
  })
})

describe('record', () => {
  const merged = { ...pr, baseRef: 'candidate/4', merged: true }

  test('writes the pull request into the candidate body', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, body: candidateBody(config, 4) }],
      '--state merged': [],
      ...issue(69, { comments: [announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })] }),
    })
    record(run(gh), merged)
    assert.equal(gh.writes[0].args, 'pr edit 40 --repo o/r --body-file -')
    assert.match(gh.writes[0].input ?? '', /- #70 ci: cache[\s\S]*Closes #69/)
  })

  test('writes nothing when the pull request is already there', () => {
    const body = recordMerges(candidateBody(config, 4), [{ number: 70, title: 'ci: cache', closes: ['#69'] }])
    const gh = fakeGh({
      '--state open': [{ number: 40, body }],
      '--state merged': [{ number: 70, title: 'ci: cache', body: 'Closes #69', mergedAt: '2026-10-13T10:00:00Z' }],
      ...issue(69, { comments: [announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })] }),
    })
    record(run(gh), merged)
    assert.deepEqual(gh.writes, [])
  })

  test('rebuilds the lists from every merged pull request, in merge order, a missed run included', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, body: candidateBody(config, 4) }],
      '--state merged': [
        { number: 70, title: 'ci: cache', body: 'Closes #69', mergedAt: '2026-10-13T10:05:00Z' },
        { number: 60, title: 'feat: x', body: 'Fixes #59', mergedAt: '2026-10-13T10:00:00Z' },
      ],
      ...issue(69, { state: 'closed' }),
      ...issue(59, { state: 'closed' }),
    })
    record(run(gh), merged)
    assert.equal(gh.writes.length, 1)
    assert.match(gh.writes[0].input ?? '', /- #60 feat: x\n- #70 ci: cache\n/)
    assert.match(gh.writes[0].input ?? '', /Closes #59\nCloses #69\n/)
  })

  test('tells the open issues of every merged pull request, once, that the candidate closes them', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, body: candidateBody(config, 4) }],
      '--state merged': [
        { number: 60, title: 'feat: x', body: 'Fixes #59', mergedAt: '2026-10-13T10:00:00Z' },
        { number: 70, title: 'ci: cache', body: 'Closes #69\nCloses #59', mergedAt: '2026-10-13T10:05:00Z' },
      ],
      ...issue(59),
      ...issue(69, { comments: ['another comment'] }),
    })
    record(run(gh), merged)
    assert.deepEqual(
      gh.writes.slice(1).map((w) => w.args),
      ['issue comment 59 --repo o/r --body-file -', 'issue comment 69 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[1].input ?? '', /candidate 4 \(#40\)/)
  })

  test('a closed pull request not merged, or not into a candidate, records nothing', () => {
    const gh = fakeGh({})
    record(run(gh), { ...merged, merged: false })
    record(run(gh), { ...merged, baseRef: 'main' })
    assert.deepEqual(gh.writes, [])
  })

  test('fails, naming the issues, when the candidate pull request is missing', () => {
    const gh = fakeGh({ '--state open': [] })
    assert.throws(() => record(run(gh), merged), /candidate\/4.*#69/)
  })
})

describe('isCandidateMerge', () => {
  test('only the merged candidate into the base', () => {
    assert.equal(isCandidateMerge(config, { merged: true, baseRef: 'main', headRef: 'candidate/4' }), true)
    assert.equal(isCandidateMerge(config, { merged: true, baseRef: 'candidate/4', headRef: 'feat/x' }), false)
    assert.equal(isCandidateMerge(config, { merged: false, baseRef: 'main', headRef: 'candidate/4' }), false)
    assert.equal(isCandidateMerge(config, { merged: true, baseRef: 'main', headRef: 'feat/x' }), false)
  })
})

describe('carryOverDecision', () => {
  const open = (number: number, fields = {}) => ({
    number,
    baseRef: 'main',
    headRef: `feat/${number}/x`,
    author: 'someone',
    labels: [] as string[],
    lastBaseChange: null as { from: string; to: string } | null,
    ...fields,
  })

  test('pull requests still on the candidate, and those GitHub moved from it onto the base', () => {
    const decision = carryOverDecision(config, {
      candidateBranch: 'candidate/4',
      openPrs: [
        open(12, { baseRef: 'candidate/4' }),
        open(11, { lastBaseChange: { from: 'candidate/4', to: 'main' } }),
      ],
    })
    assert.deepEqual(decision.move, [11, 12])
  })

  test('others, hotfixes, candidates and Dependabot stay', () => {
    const fromCandidate = { lastBaseChange: { from: 'candidate/4', to: 'main' } }
    const decision = carryOverDecision(config, {
      candidateBranch: 'candidate/4',
      openPrs: [
        open(1),
        open(2, { lastBaseChange: { from: 'candidate/3', to: 'main' } }),
        open(3, { baseRef: 'candidate/5' }),
        open(4, { ...fromCandidate, labels: ['hotfix'] }),
        open(5, { ...fromCandidate, headRef: 'hotfix/y' }),
        open(6, { ...fromCandidate, headRef: 'candidate/5' }),
        open(7, { ...fromCandidate, author: 'dependabot[bot]' }),
      ],
    })
    assert.deepEqual(decision.move, [])
  })
})

const node = (number: number, fields = {}) => ({
  number,
  baseRefName: 'main',
  headRefName: `feat/${number}/x`,
  author: { login: 'someone' },
  labels: { nodes: [] },
  timelineItems: { nodes: [] },
  ...fields,
})

describe('carryOver', () => {
  const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true }

  test('nothing to move: no candidate created, nothing written', () => {
    const gh = fakeGh({ 'api graphql': [node(1)] })
    assert.deepEqual(carryOver(run(gh), candidate).move, [])
    assert.deepEqual(gh.writes, [])
  })

  test('creates the next candidate and moves the pull requests left behind', () => {
    const gh = fakeGh({
      'api graphql': [
        node(12, { baseRefName: 'candidate/4' }),
        node(11, {
          timelineItems: {
            nodes: [{ __typename: 'AutomaticBaseChangeSucceededEvent', oldBase: 'candidate/4', newBase: 'main' }],
          },
        }),
        node(13),
      ],
      '--state open': [],
      'matching-refs': [],
      '--state all': [{ headRefName: 'candidate/4' }],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    carryOver(run(gh), candidate)
    const writes = gh.writes.map((w) => w.args)
    assert.match(writes[1], /ref=refs\/heads\/candidate\/5 /)
    assert.match(writes[2], /pr create .*--head candidate\/5/)
    assert.deepEqual(writes.slice(3), [
      'pr edit 11 --repo o/r --base candidate/5',
      'pr comment 11 --repo o/r --body-file -',
      'pr edit 12 --repo o/r --base candidate/5',
      'pr comment 12 --repo o/r --body-file -',
    ])
  })
})

describe('issues', () => {
  test('issueNumber: this repo, in any case; another repo is not ours', () => {
    assert.equal(issueNumber('#12', 'LunetteOrg/starter'), 12)
    assert.equal(issueNumber('lunetteorg/Starter#12', 'LunetteOrg/starter'), 12)
    assert.equal(issueNumber('LunetteOrg/other#12', 'LunetteOrg/starter'), null)
  })

  test('the announcement names the candidate and is recognised per candidate', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    assert.match(comment, /candidate 4 \(#40\) will close this issue/)
    assert.equal(isAnnounced(['ok', comment], 'candidate/4'), true)
    assert.equal(isAnnounced([comment], 'candidate/14'), false)
    assert.equal(isAnnounced([comment], 'candidate/41'), false)
    assert.equal(isAnnounced([null], 'candidate/4'), false)
  })

  test('closeDecision: open issues close, closed ones and pull requests stay', () => {
    assert.deepEqual(
      closeDecision([
        { number: 1, state: 'open', isPr: false },
        { number: 2, state: 'closed', isPr: false },
        { number: 3, state: 'open', isPr: true },
        { number: 4, state: 'OPEN', isPr: false },
      ]),
      { close: [1, 4], alreadyClosed: [2], notIssues: [3] },
    )
  })
})

describe('closeCandidateIssues', () => {
  const candidate = {
    ...pr,
    number: 40,
    baseRef: 'main',
    headRef: 'candidate/4',
    merged: true,
    body: recordMerges(candidateBody(config, 4), [
      { number: 70, title: 't', closes: ['#69', '#71', 'o/other#3', '#72'] },
    ]),
  }

  test('closes the open issues of the body as completed, and leaves the closed ones', () => {
    const gh = fakeGh({ ...issue(69), ...issue(71, { state: 'closed' }), ...issue(72, { isPr: true }) })
    const decision = closeCandidateIssues(run(gh), candidate)
    assert.deepEqual(decision, { close: [69], alreadyClosed: [71], notIssues: [72] })
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  test('a title with a keyword in the pull request list closes nothing', () => {
    const body = recordMerges(candidateBody(config, 4), [
      { number: 60, title: 'fix: #59 cache', closes: [] },
      { number: 70, title: 'chore: close #58', closes: ['#69'] },
    ])
    const gh = fakeGh({ ...issue(69) })
    assert.deepEqual(closeCandidateIssues(run(gh), { ...candidate, body }).close, [69])
  })

  test('an issue that cannot be read does not stop the others, and fails the run naming it', () => {
    const body = recordMerges(candidateBody(config, 4), [{ number: 70, title: 't', closes: ['#9999', '#69'] }])
    const gh = fakeGh({ ...issue(69) })
    assert.throws(() => closeCandidateIssues(run(gh), { ...candidate, body }), /#9999: .*issues\/9999/)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })
})

describe('announce', () => {
  const candidate = { number: 40, headRefName: 'candidate/4' }

  test('a second run writes nothing', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    const gh = fakeGh({ ...issue(69, { comments: ['before', comment] }) })
    assert.deepEqual(announce(run(gh), candidate, [{ body: 'Closes #69' }]).announced, [])
    assert.deepEqual(gh.writes, [])
  })

  test('an issue named twice gets one comment, a closed one and a pull request none', () => {
    const gh = fakeGh({ ...issue(5), ...issue(6, { state: 'closed' }), ...issue(7, { isPr: true }) })
    const { announced } = announce(run(gh), candidate, [
      { body: 'Closes #5\nFixes #6' },
      { body: 'Resolves #5\nCloses #7' },
    ])
    assert.deepEqual(announced, [5])
  })
})

describe('candidateMerged', () => {
  const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }

  test('closes the issues, then moves the pull requests left behind', () => {
    const gh = fakeGh({ ...issue(69), 'api graphql': [] })
    candidateMerged(run(gh), candidate)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  test('a failure closing the issues does not stop the move, and fails the run after it', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/4' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
    })
    assert.throws(() => candidateMerged(run(gh), candidate), /issues\/69/)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr comment 12 --repo o/r --body-file -'],
    )
  })
})

describe('closing references as issue URLs', () => {
  test('a full issue URL after the keyword counts, as owner/repo#N', () => {
    assert.deepEqual(closingReferences('Closes https://github.com/LunetteOrg/starter/issues/31\nFixes #2'), [
      'LunetteOrg/starter#31',
      '#2',
    ])
    assert.deepEqual(closingReferences('Closes https://github.com/o/r/pull/3'), [])
  })
})

describe('sweepDecision', () => {
  const open = (number: number, fields = {}) => ({
    number,
    baseRef: 'main',
    headRef: `feat/${number}/x`,
    author: 'someone',
    labels: [] as string[],
    lastBaseChange: null as { from: string; to: string } | null,
    ...fields,
  })

  test('pull requests stranded on a candidate that is no longer open move; others stay', () => {
    const decision = sweepDecision(config, {
      openCandidates: ['candidate/5'],
      openPrs: [
        open(1, { baseRef: 'candidate/4' }),
        open(2, { lastBaseChange: { from: 'candidate/3', to: 'main' } }),
        open(3, { baseRef: 'candidate/5' }),
        open(4, { lastBaseChange: { from: 'candidate/5', to: 'main' } }),
        open(5, { baseRef: 'candidate/4', labels: ['hotfix'] }),
        open(6, { baseRef: 'candidate/4', author: 'dependabot[bot]' }),
        open(7, { baseRef: 'main', headRef: 'candidate/5' }),
        open(8),
      ],
    })
    assert.deepEqual(decision.move, [1, 2])
  })
})

describe('sweep', () => {
  test('moves stranded pull requests onto the open candidate before the event is handled', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
    })
    assert.deepEqual(sweep(run(gh)).move, [12])
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr comment 12 --repo o/r --body-file -'],
    )
  })

  test('nothing stranded: nothing read beyond the lists, nothing written', () => {
    const gh = fakeGh({ 'api graphql': [node(1)], '--state open': [] })
    assert.deepEqual(sweep(run(gh)).move, [])
    assert.deepEqual(gh.writes, [])
  })

  test('handle sweeps on every event, then does what the event asks', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
    })
    handle(run(gh), 'opened', pr)
    assert.deepEqual(
      gh.writes.filter((w) => w.args.includes('--base')).map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr edit 70 --repo o/r --base candidate/5'],
    )
  })
})

// A board double: the issue's project items answered to the GraphQL read, the
// mutations recorded.
function item(
  id: string,
  { options = ['Todo', 'In Progress', 'In release', 'Done'], current = 'Todo', status = true } = {},
) {
  return {
    id,
    fieldValueByName: { optionId: `opt-${current}` },
    project: {
      id: `P-${id}`,
      title: 'board',
      field: status ? { id: `F-${id}`, options: options.map((name) => ({ id: `opt-${name}`, name })) } : {},
    },
  }
}
const items = (...nodes: unknown[]) => ({
  'projectItems(': { data: { repository: { issue: { projectItems: { nodes } } } } },
})
const notices = () => {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

describe('setBoardStatus', () => {
  test('moves the issue to the status on each project that has it', () => {
    const board = fakeGh(items(item('i1')))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release')
    assert.deepEqual(moved, [69])
    assert.deepEqual(skipped, [])
    assert.equal(board.writes.length, 1)
    assert.match(board.writes[0]?.args ?? '', /updateProjectV2ItemFieldValue/)
    assert.match(board.writes[0]?.args ?? '', /project=P-i1 -f item=i1 -f field=F-i1 -f option=opt-In release/)
  })

  test('an issue already at the status is left alone', () => {
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    const { moved } = setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release')
    assert.deepEqual(moved, [])
    assert.deepEqual(board.writes, [])
  })

  test('a project without the status skips it with a notice saying how to add it', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'In Progress', 'Done'] })))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepEqual(moved, [])
    assert.deepEqual(skipped, [69])
    assert.deepEqual(board.writes, [])
    assert.match(out.lines.join('\n'), /::notice .*In release.*not an option.*github-board skill/s)
  })

  test('a project without a Status field is skipped with a notice', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { status: false })))
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*no Status field/s)
  })

  test('an issue on no project is skipped with a notice', () => {
    const out = notices()
    const board = fakeGh(items())
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*#69 is on no project/s)
  })

  test('without a Projects token the whole step is skipped with one notice', () => {
    const out = notices()
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), log: out.log }, [69, 70], 'In release')
    assert.deepEqual(moved, [])
    assert.deepEqual(skipped, [69, 70])
    assert.equal(out.lines.filter((l) => l.startsWith('::notice')).length, 1)
    assert.match(out.lines.join('\n'), /::notice .*no token with the Projects permission/)
  })

  test('a token refused by Projects is a notice, not an error', () => {
    const out = notices()
    const board: Gh = {
      read: () => {
        throw new Error('Resource not accessible by integration')
      },
      write: () => '',
    }
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*Projects permission.*Resource not accessible/s)
  })

  test('a token that reads but cannot write is a notice, and the next issue is still moved', () => {
    const out = notices()
    let writes = 0
    const base = fakeGh(items(item('i1')))
    const board: Gh = {
      read: base.read,
      write: (args) => {
        if (++writes === 1) throw new Error('Command failed: gh api graphql: Resource not accessible by integration')
        return base.write(args)
      },
    }
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69, 70], 'In release')
    assert.deepEqual(skipped, [69])
    assert.deepEqual(moved, [70])
    assert.match(out.lines.join('\n'), /::notice .*Projects permission.*#69/s)
  })

  test('the option is found whatever its case, and an item with no status yet is moved', () => {
    const board = fakeGh(items({ ...item('i1', { options: ['in release'] }), fieldValueByName: null }))
    assert.deepEqual(setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release').moved, [69])
  })

  test('a project without the option does not stop the next one, and the issue counts as moved', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Done'] }), item('i2')))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepEqual(moved, [69])
    assert.deepEqual(skipped, [])
    assert.equal(board.writes.length, 1)
    assert.match(board.writes[0]?.args ?? '', /item=i2/)
  })

  test('a failure that is not a refusal names the message, and a rate limit is one', () => {
    const board: Gh = {
      read: () => {
        throw new Error('API rate limit exceeded')
      },
      write: () => '',
    }
    assert.throws(() => setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release'), /#69: API rate limit/)
  })

  test('a refusal after a first project was written leaves the issue moved on that one', () => {
    let writes = 0
    const base = fakeGh(items(item('i1'), item('i2')))
    const board: Gh = {
      read: base.read,
      write: (args) => {
        if (++writes === 2) throw new Error('Resource not accessible by personal access token')
        return base.write(args)
      },
    }
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release')
    assert.deepEqual(moved, [69])
    assert.deepEqual(skipped, [])
    assert.equal(base.writes.length, 1)
  })

  test('the notice for a missing option lists the options the project has', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Done'] })))
    setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'Dne')
    assert.match(out.lines.join('\n'), /\(Todo, Done\).*delivery\.candidate\.status/s)
  })

  test('any other failure fails the step', () => {
    const board: Gh = {
      read: () => {
        throw new Error('socket hang up')
      },
      write: () => '',
    }
    assert.throws(() => setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release'), /#69: socket hang up/)
  })
})

describe('the board follows the candidate', () => {
  const merged = { ...pr, baseRef: 'candidate/4', merged: true }
  const record1 = {
    'pr list': [{ number: 40, body: candidateBody(config, 4) }],
    '--state merged': [{ number: 70, title: 't', body: 'Closes #69', mergedAt: '2026-10-17T10:00:00Z' }],
  }

  test('a squash into the candidate moves the issues it closes to In release', () => {
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69) })), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-In release/)
  })

  test('an issue already announced is still moved, so a second run finishes the first', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69, { comments: [comment] }) })), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-In release/)
  })

  test('a comment that fails does not leave the board behind, and fails the run after it', () => {
    const board = fakeGh(items(item('i1')))
    assert.throws(() => record({ ...run(fakeGh({ ...record1 })), board }, merged), /issues without the announcement/)
    assert.deepEqual(board.writes, [])
    const failing = fakeGh({ ...record1, ...issue(69) })
    const write = failing.write
    failing.write = (args, input) => {
      if (args[0] === 'issue') throw new Error('comment refused')
      return write(args, input)
    }
    const second = fakeGh(items(item('i1')))
    assert.throws(() => record({ ...run(failing), board: second }, merged), /comment refused/)
    assert.match(second.writes.at(-1)?.args ?? '', /option=opt-In release/)
  })

  test('the statuses come from the configuration', () => {
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Shipping'] })))
    const custom = { ...config, status: { inRelease: 'Shipping', done: 'Done' } }
    record({ ...run(fakeGh({ ...record1, ...issue(69) }), custom), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Shipping/)
  })

  test('an issue closed already is not moved', () => {
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69, { state: 'closed' }) })), board }, merged)
    assert.deepEqual(board.writes, [])
  })

  test('the candidate merge moves the issues it closes to Done', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    closeCandidateIssues({ ...run(fakeGh({ ...issue(69) })), board }, candidate)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Done/)
  })

  test('an issue closed by hand while In release ends at Done', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    closeCandidateIssues({ ...run(fakeGh({ ...issue(69, { state: 'closed' }) })), board }, candidate)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Done/)
  })

  test('a board that fails is reported apart from the close', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board: Gh = {
      read: () => {
        throw new Error('API rate limit exceeded')
      },
      write: () => '',
    }
    const gh = fakeGh({ ...issue(69) })
    assert.throws(
      () => closeCandidateIssues({ ...run(gh), board }, candidate),
      (error: Error) => /issues not moved to "Done"/.test(error.message) && !/not closed/.test(error.message),
    )
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  test('a board that cannot be moved does not stop the close', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const gh = fakeGh({ ...issue(69) })
    closeCandidateIssues(run(gh), candidate)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })
})

describe('makeGh', () => {
  // A gh on the PATH that answers from the environment.
  function withFakeGh(script: string, body: () => void) {
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'))
    const bin = join(dir, 'gh')
    writeFileSync(bin, `#!/bin/sh\n${script}\n`)
    chmodSync(bin, 0o755)
    const before = process.env.PATH
    process.env.PATH = `${dir}:${before}`
    try {
      body()
    } finally {
      process.env.PATH = before
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a failing gh puts its stderr in the error, which is what NOT_PERMITTED reads', () => {
    withFakeGh('echo "Resource not accessible by personal access token" >&2; exit 1', () => {
      assert.throws(
        () => makeGh({ dryRun: false, log: silent }).read(['api', 'graphql']),
        /Command failed: gh api graphql: Resource not accessible by personal access token/,
      )
    })
  })

  test('a failing gh with no stderr says only which command failed', () => {
    withFakeGh('exit 3', () => {
      assert.throws(
        () => makeGh({ dryRun: false, log: silent }).read(['api', 'graphql']),
        (error: Error) => error.message === 'Command failed: gh api graphql',
      )
    })
  })

  test('a gh that cannot start throws its own error', () => {
    const before = process.env.PATH
    process.env.PATH = '/nonexistent'
    try {
      assert.throws(() => makeGh({ dryRun: false, log: silent }).read(['x']), /ENOENT/)
    } finally {
      process.env.PATH = before
    }
  })

  test('without a token the ambient GH_TOKEN is the one gh sees', () => {
    const before = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ambient'
    try {
      withFakeGh('echo "$GH_TOKEN"', () => {
        assert.equal(makeGh({ dryRun: false, log: silent }).read(['x']), 'ambient')
        assert.equal(makeGh({ dryRun: false, log: silent, token: 'tok' }).read(['x']), 'tok')
        assert.equal(makeGh({ dryRun: false, log: silent }).read(['x']), 'ambient')
      })
    } finally {
      if (before === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = before
    }
  })

  test('the token reaches gh as GH_TOKEN, and stdout comes back trimmed', () => {
    withFakeGh('echo "$GH_TOKEN"', () => {
      assert.equal(makeGh({ dryRun: false, log: silent, token: 'tok' }).read(['x']), 'tok')
    })
  })

  test('a dry run writes nothing', () => {
    withFakeGh('exit 1', () => {
      const lines: string[] = []
      makeGh({ dryRun: true, log: (l) => lines.push(l) }).write(['issue', 'close', '1'])
      assert.match(lines[0] ?? '', /\[dry-run\] gh issue close 1/)
    })
  })
})

describe('pickBoard', () => {
  const own = { name: 'own' }
  const withToken = (t: string) => ({ name: t })

  test('the Projects token wins, in a workflow or not', () => {
    assert.deepEqual(pickBoard('tok', true, own, withToken), { name: 'tok' })
    assert.deepEqual(pickBoard('tok', false, own, withToken), { name: 'tok' })
  })

  test('a workflow without the token has no board, a terminal uses its own login', () => {
    assert.equal(pickBoard(undefined, true, own, withToken), undefined)
    assert.equal(pickBoard(undefined, false, own, withToken), own)
    assert.equal(pickBoard('', true, own, withToken), undefined)
  })
})
