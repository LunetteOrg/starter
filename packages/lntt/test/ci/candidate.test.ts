import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readyRules } from '../../src/board-ready.ts'
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
  follow,
  followDecision,
  type Gh,
  type Git,
  gitAuthEnv,
  handle,
  handlePush,
  isAnnounced,
  isCandidateMerge,
  isHotfix,
  issueNumber,
  makeGh,
  makeGit,
  nextCandidateNumber,
  orphanCandidate,
  type PullRequest,
  pickBoard,
  type Run,
  readyAfterMerge,
  readyMarker,
  record,
  recordMerges,
  retarget,
  retargetDecision,
  retrospectiveComment,
  setBoardStatus,
  sweep,
  sweepDecision,
} from '../../src/ci/candidate.ts'
import { git, write } from './helpers.ts'

const config: CandidateConfig = {
  base: 'main',
  prefix: 'candidate/',
  hotfix: { prefix: 'hotfix/', label: 'hotfix' },
  status: { inRelease: 'In release', done: 'Done' },
  retrospective: '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n<!-- retro:end -->\n',
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
// contains (a string as is, anything else as JSON), writes recorded.
function fakeGh(answers: Record<string, unknown>): Gh & { writes: Array<{ args: string; input?: string }> } {
  const writes: Array<{ args: string; input?: string }> = []
  return {
    writes,
    read: (args) => {
      const line = args.join(' ')
      const key = Object.keys(answers).find((k) => line.includes(k))
      if (key === undefined) throw new Error(`unexpected read: ${line}`)
      const answer = answers[key]
      return typeof answer === 'string' ? answer : JSON.stringify(answer)
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
// The comments of an open candidate that has its retrospective comment.
const hasRetro = (number: number) => ({
  [`issues/${number}/comments`]: JSON.stringify({ id: 1, body: retrospectiveComment(config) }),
})
const run = (gh: Gh, c: CandidateConfig = config): Run => ({ gh, repo: 'o/r', config: c, log: silent })
// A git that must not be called: the compare read says there is nothing to do.
const noGit = (): Git => ({
  run: (args) => {
    throw new Error(`unexpected git ${args.join(' ')}`)
  },
  push: (args) => {
    throw new Error(`unexpected git push ${args.join(' ')}`)
  },
})

describe('retarget', () => {
  test('moves the pull request onto the open candidate and comments', () => {
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }], ...hasRetro(40) })
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
    assert.equal(writes[3], 'pr comment 42 --repo o/r --body-file -')
    assert.equal(writes[4], 'pr edit 70 --repo o/r --base candidate/6')
    assert.match(gh.writes[5].input ?? '', /#42/)
  })

  test('a new candidate opens with a comment holding the empty retrospective block', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [],
      '--state all': [],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    retarget(run(gh), pr)
    const comment = gh.writes.find((w) => w.args === 'pr comment 42 --repo o/r --body-file -')
    assert.ok(comment, 'no comment on the new candidate')
    assert.equal(comment.input, retrospectiveComment(config))
    assert.ok((comment.input ?? '').endsWith(`\n\n${config.retrospective}`))
    assert.match(comment.input ?? '', /`pnpm exec lntt retro add --label <label> "<one sentence>"`/)
    assert.match(comment.input ?? '', /\(`pnpm exec lntt check body --pr <n>`\)/)
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
    assert.match(gh.writes[3].input ?? '', /The retrospective of this release/)
    assert.equal(gh.writes[4].args, 'pr edit 70 --repo o/r --base release/8')
  })

  test('a branch left without its pull request is reused, pull request only', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [{ ref: 'refs/heads/candidate/6' }],
      '--state all': [{ headRefName: 'candidate/5' }],
    })
    retarget(run(gh), pr)
    assert.match(gh.writes[0].args, /pr create .*--head candidate\/6 --title candidate 6/)
    assert.equal(gh.writes[1].args, 'pr comment 42 --repo o/r --body-file -')
    assert.equal(gh.writes[2].args, 'pr edit 70 --repo o/r --base candidate/6')
  })

  test('an open candidate a run left without its retrospective comment gets it, then the move', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }],
      'issues/40/comments': JSON.stringify({ id: 1, body: 'Moved onto candidate/4.' }),
    })
    retarget(run(gh), pr)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 40 --repo o/r --body-file -',
        'pr edit 70 --repo o/r --base candidate/4',
        'pr comment 70 --repo o/r --body-file -',
      ],
    )
    assert.equal(gh.writes[0]?.input, retrospectiveComment(config))
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
    assert.equal(writes[3], 'pr comment 42 --repo o/r --body-file -')
    assert.deepEqual(writes.slice(4), [
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
      ...hasRetro(50),
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
      ...hasRetro(50),
    })
    assert.deepEqual(sweep(run(gh)).move, [12])
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr comment 12 --repo o/r --body-file -'],
    )
  })

  test('a candidate without its retrospective comment gets it before the stranded move', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      'issues/50/comments': '',
    })
    sweep(run(gh))
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 50 --repo o/r --body-file -',
        'pr edit 12 --repo o/r --base candidate/5',
        'pr comment 12 --repo o/r --body-file -',
      ],
    )
  })

  test('a failure writing the retrospective comment is a warning: the pull request still moves', () => {
    const lines: string[] = []
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }] })
    retarget({ ...run(gh), log: (l) => lines.push(l) }, pr)
    assert.ok(gh.writes.some((w) => w.args === 'pr edit 70 --repo o/r --base candidate/4'))
    assert.ok(
      lines.some((l) =>
        l.startsWith('::warning title=Retrospective comment::candidate/4: not written (unexpected read'),
      ),
    )
  })

  test('the warning is one workflow command: newlines flattened, % escaped', () => {
    const lines: string[] = []
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }] })
    const failing: Gh = {
      ...gh,
      read: (args) => {
        if (args.includes('--paginate')) throw new Error('quota 100% used\r\nretry later')
        return gh.read(args)
      },
    }
    retarget({ ...run(failing), log: (l) => lines.push(l) }, pr)
    const warning = lines.find((l) => l.startsWith('::warning'))
    assert.equal(
      warning,
      '::warning title=Retrospective comment::candidate/4: not written (quota 100%25 used retry later); pnpm exec lntt retro add writes it',
    )
  })

  test('nothing stranded: nothing read beyond the lists, nothing written', () => {
    const gh = fakeGh({ 'api graphql': [node(1)], '--state open': [] })
    assert.deepEqual(sweep(run(gh)).move, [])
    assert.deepEqual(gh.writes, [])
  })

  test('handle sweeps on every event, then does what the event asks', () => {
    const gh = fakeGh({
      'compare/main...candidate/5': { behindBy: 0, base: 'b'.repeat(40) },
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    const lines: string[] = []
    handle({ ...run(gh), log: (l) => lines.push(l), git: noGit() }, 'opened', pr)
    assert.deepEqual(
      gh.writes.filter((w) => w.args.includes('--base')).map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr edit 70 --repo o/r --base candidate/5'],
    )
    const followed = lines.indexOf('candidate: follow main: main is an ancestor of candidate/5')
    assert.ok(followed >= 0, lines.join('\n'))
    assert.ok(followed < lines.findIndex((l) => l.startsWith('candidate: #70')))
  })

  test('a failure following the base is a warning: the event is still handled', () => {
    const gh = fakeGh({
      'api graphql': [],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    const lines: string[] = []
    handle({ ...run(gh), log: (l) => lines.push(l), git: noGit() }, 'opened', pr)
    assert.ok(gh.writes.some((w) => w.args === 'pr edit 70 --repo o/r --base candidate/5'))
    assert.ok(lines.some((l) => l.startsWith('::warning title=Candidate not updated::')))
  })

  test('a failure following the base escapes a push run, which turns red', () => {
    const gh = fakeGh({
      'api graphql': [],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    assert.throws(() => handlePush({ ...run(gh), git: noGit() }), /unexpected read: .*compare\/main\.\.\.candidate\/5/)
  })

  test('without git the follow step says it cannot act and reads nothing', () => {
    const gh = fakeGh({ 'api graphql': [], '--state open': [] })
    const lines: string[] = []
    handlePush({ ...run(gh), log: (l) => lines.push(l) })
    assert.ok(lines.some((l) => /no git client/.test(l)))
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
    assert.match(
      out.lines.join('\n'),
      /::notice .*In release.*not an option.*github-board skill, references\/github-project\.md/s,
    )
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

describe('followDecision', () => {
  test('no candidate open: nothing', () => {
    assert.deepEqual(followDecision(config, { candidate: null, behindBy: 3, prsInto: [] }), {
      path: 'none',
      reason: 'no candidate open',
    })
  })

  test('the base is an ancestor of the candidate: nothing', () => {
    assert.deepEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 0, prsInto: [12] }), {
      path: 'none',
      reason: 'main is an ancestor of candidate/4',
    })
  })

  test('the base moved and nobody stands on the candidate: rebase', () => {
    assert.deepEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 2, prsInto: [] }), {
      path: 'rebase',
      reason: 'main moved and no pull request is open into candidate/4: rebase',
    })
  })

  test('the base moved and pull requests are open into the candidate: merge', () => {
    assert.deepEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 1, prsInto: [15, 12] }), {
      path: 'merge',
      reason: 'main moved and #12, #15 are open into candidate/4: merge main into it, no rewrite',
    })
    assert.equal(
      followDecision(config, { candidate: 'candidate/4', behindBy: 1, prsInto: [12] }).reason,
      'main moved and #12 is open into candidate/4: merge main into it, no rewrite',
    )
  })

  test('the base name comes from the configuration', () => {
    const trunk = { ...config, base: 'trunk' }
    assert.equal(
      followDecision(trunk, { candidate: 'candidate/4', behindBy: 1, prsInto: [] }).reason,
      'trunk moved and no pull request is open into candidate/4: rebase',
    )
  })
})

describe('gitAuthEnv', () => {
  test('in Actions with a token: an extra header in the environment, never in the arguments', () => {
    const extra = gitAuthEnv({ GITHUB_ACTIONS: 'true', GH_TOKEN: 'tok' })
    assert.deepEqual(extra, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    })
  })

  test('from a terminal, or without a token: nothing', () => {
    assert.deepEqual(gitAuthEnv({ GH_TOKEN: 'tok' }), {})
    assert.deepEqual(gitAuthEnv({ GITHUB_ACTIONS: 'true' }), {})
  })
})

describe('follow', () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: 'bot',
    GIT_AUTHOR_EMAIL: 'bot@example.com',
    GIT_COMMITTER_NAME: 'bot',
    GIT_COMMITTER_EMAIL: 'bot@example.com',
  }

  // A bare remote with `main` and `candidate/4` (the empty opening commit, then a
  // feature), `main` moved by a hotfix after the candidate opened, and a clone of it:
  // the runner's checkout. `conflict` makes the hotfix and the feature edit one file.
  function setup({ conflict = false } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-follow-')))
    const remote = join(dir, 'remote.git')
    const seed = join(dir, 'seed')
    const clone = join(dir, 'clone')
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote)
    git(dir, 'init', '-q', '-b', 'main', seed)
    write(seed, { 'a.txt': 'one\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'init')
    git(seed, 'switch', '-q', '-c', 'candidate/4')
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'chore: open candidate 4')
    write(seed, conflict ? { 'a.txt': 'feature\n' } : { 'b.txt': 'feature\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'feat: b')
    const oldHead = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'switch', '-q', 'main')
    write(seed, conflict ? { 'a.txt': 'hotfix\n' } : { 'c.txt': 'hotfix\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'fix: hotfix')
    const base = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'remote', 'add', 'origin', remote)
    git(seed, 'push', '-q', 'origin', 'main', 'candidate/4')
    git(dir, 'clone', '-q', '--no-checkout', remote, clone)
    return { dir, remote, seed, clone, oldHead, base }
  }

  type Setup = ReturnType<typeof setup>

  function answers(s: Setup, { prsInto = [] as number[], behindBy = 1, comments = {} as Record<number, string> } = {}) {
    return {
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: s.oldHead }],
      'compare/main...candidate/4': { behindBy, base: s.base },
      'api graphql': prsInto.map((n) => node(n, { baseRefName: 'candidate/4' })),
      'issues/40/comments': comments[40] ?? '',
      ...Object.fromEntries(prsInto.map((n) => [`issues/${n}/comments`, comments[n] ?? ''])),
    }
  }

  // The real git on the clone, its pushes recorded; `before` runs ahead of a push.
  function recordingGit(s: Setup, { dryRun = false, log = silent as (l: string) => void, before = () => {} } = {}) {
    const real = makeGit({ dryRun, log, cwd: s.clone, env: { ...process.env, ...IDENTITY } })
    const pushes: string[][] = []
    const calls: string[][] = []
    const seam: Git & { pushes: string[][]; calls: string[][] } = {
      pushes,
      calls,
      run: (args) => {
        calls.push(args)
        return real.run(args)
      },
      push: (args) => {
        before()
        pushes.push(args)
        return real.push(args)
      },
    }
    return seam
  }

  const remoteHead = (s: Setup) => git(s.remote, 'rev-parse', 'refs/heads/candidate/4')

  test('nobody on the candidate: its commits are rebased on the base, the empty one kept, with a lease', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s))
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    const head = remoteHead(s)
    assert.equal(result.outcome, 'updated')
    assert.equal(result.head, head)
    assert.notEqual(head, s.oldHead)
    assert.equal(git(s.remote, 'rev-list', '--merges', `${s.base}..${head}`), '')
    assert.deepEqual(git(s.remote, 'log', '--format=%s', `${s.base}..${head}`).split('\n'), [
      'feat: b',
      'chore: open candidate 4',
    ])
    assert.equal(git(s.remote, 'rev-parse', `${head}~2`), s.base)
    assert.deepEqual(g.pushes, [
      [`--force-with-lease=refs/heads/candidate/4:${s.oldHead}`, 'origin', `${head}:refs/heads/candidate/4`],
    ])
    assert.equal(gh.writes.length, 1)
    assert.equal(gh.writes[0].args, 'pr comment 40 --repo o/r --body-file -')
    const body = gh.writes[0].input ?? ''
    assert.ok(body.includes(`<!-- candidate:followed:${head} -->`))
    assert.match(body, new RegExp(`${s.base.slice(0, 8)}`))
    assert.match(body, /rebased/)
    assert.match(body, /no pull request is open into it/)
    assert.ok(body.includes(s.oldHead.slice(0, 8)) && body.includes(head.slice(0, 8)))
    assert.match(body, /pnpm ci:local/)
    assert.equal(git(s.clone, 'worktree', 'list').split('\n').length, 1)
  })

  test("the clone's hooks do not run on the automation's rebase and push", (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    // Hooks that refuse everything: a project's pre-push or pre-rebase on the machine.
    for (const hook of ['pre-push', 'pre-rebase', 'post-checkout']) {
      write(s.clone, { [`.git/hooks/${hook}`]: '#!/bin/sh\nexit 1\n' })
      chmodSync(join(s.clone, `.git/hooks/${hook}`), 0o755)
    }
    const result = follow({ ...run(fakeGh(answers(s))), git: recordingGit(s) })
    assert.equal(result.outcome, 'updated')
    assert.equal(remoteHead(s), result.head)
  })

  test('pull requests on the candidate: the base is merged into it, no force, and each is told', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s, { prsInto: [12] }))
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    const head = remoteHead(s)
    assert.equal(result.outcome, 'updated')
    assert.equal(git(s.remote, 'rev-list', '--parents', '-n', '1', head), `${head} ${s.oldHead} ${s.base}`)
    assert.match(git(s.remote, 'log', '-1', '--format=%B', head), /^Merge main into candidate\/4\n\n.*main at /)
    assert.ok(git(s.remote, 'log', '-1', '--format=%B', head).includes(s.base))
    assert.deepEqual(g.pushes, [['origin', `${head}:refs/heads/candidate/4`]])
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -', 'pr comment 12 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[0].input ?? '', /merged/)
    assert.match(gh.writes[0].input ?? '', /#12 is open into it/)
    assert.ok((gh.writes[1].input ?? '').includes(`<!-- candidate:followed:${head} -->`))
    assert.match(gh.writes[1].input ?? '', /merge or (a )?rebase of `candidate\/4`/)
  })

  for (const [path, prsInto] of [
    ['rebase', []],
    ['merge', [12]],
  ] as const) {
    test(`a conflict in the ${path} path pushes nothing and names the file on the candidate`, (t) => {
      const s = setup({ conflict: true })
      t.after(() => rmSync(s.dir, { recursive: true, force: true }))
      const gh = fakeGh(answers(s, { prsInto: [...prsInto] }))
      const lines: string[] = []
      const g = recordingGit(s)
      const result = follow({ ...run(gh), log: (l) => lines.push(l), git: g })
      assert.equal(result.outcome, 'conflict')
      assert.deepEqual(result.files, ['a.txt'])
      assert.equal(remoteHead(s), s.oldHead)
      assert.deepEqual(g.pushes, [])
      assert.deepEqual(
        gh.writes.map((w) => w.args),
        ['pr comment 40 --repo o/r --body-file -'],
      )
      const body = gh.writes[0].input ?? ''
      assert.ok(body.includes(`<!-- candidate:follow:${s.base}:${s.oldHead} -->`))
      assert.match(body, /`a\.txt`/)
      assert.match(body, /git switch candidate\/4/)
      assert.match(body, /git merge origin\/main/)
      assert.match(body, /An admin brings it up to date/)
      assert.ok(lines.some((l) => l.startsWith('::warning title=Candidate not updated::candidate/4')))
      assert.equal(git(s.clone, 'worktree', 'list').split('\n').length, 1)
    })
  }

  test('a candidate moved after the read: the lease refuses, nothing is overwritten, the candidate is told', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    let moved = ''
    const g = recordingGit(s, {
      before: () => {
        git(s.seed, 'switch', '-q', 'candidate/4')
        git(s.seed, 'commit', '-q', '--allow-empty', '-m', 'feat: pushed meanwhile')
        git(s.seed, 'push', '-q', 'origin', 'candidate/4')
        moved = git(s.seed, 'rev-parse', 'HEAD')
      },
    })
    const gh = fakeGh(answers(s))
    const lines: string[] = []
    const result = follow({ ...run(gh), log: (l) => lines.push(l), git: g })
    assert.equal(result.outcome, 'refused')
    assert.equal(remoteHead(s), moved)
    assert.equal(gh.writes.length, 1)
    const body = gh.writes[0].input ?? ''
    assert.ok(body.includes(`<!-- candidate:follow:${s.base}:${s.oldHead} -->`))
    assert.match(body, /refused/)
    assert.match(body, /stale info|rejected/)
    assert.match(body, /An admin brings it up to date/)
    assert.ok(lines.some((l) => l.startsWith('::warning title=Candidate not updated::')))
  })

  test('a comment already written is not written again', (t) => {
    const s = setup({ conflict: true })
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const marker = `<!-- candidate:follow:${s.base}:${s.oldHead} -->`
    const gh = fakeGh(answers(s, { comments: { 40: JSON.stringify({ id: 1, body: `${marker}\nearlier` }) } }))
    const result = follow({ ...run(gh), git: recordingGit(s) })
    assert.equal(result.outcome, 'conflict')
    assert.deepEqual(gh.writes, [])
  })

  test('the base already an ancestor: no git call, nothing written', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s, { behindBy: 0 }))
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    assert.equal(result.path, 'none')
    assert.deepEqual(g.calls, [])
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('the base already an ancestor: the pull requests are not read', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: 'a'.repeat(40) }],
      'compare/main...candidate/4': { behindBy: 0, base: 'b'.repeat(40) },
    })
    const result = follow({ ...run(gh), git: noGit() })
    assert.deepEqual([result.path, result.outcome], ['none', 'none'])
  })

  test('a comment that fails after the push is a warning: the candidate is updated, the others are told', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const base = fakeGh(answers(s, { prsInto: [12, 15] }))
    const gh: typeof base = {
      ...base,
      write: (args, input) => {
        if (args.join(' ') === 'pr comment 12 --repo o/r --body-file -') throw new Error('HTTP 502\nbad gateway')
        return base.write(args, input)
      },
    }
    const lines: string[] = []
    const result = follow({ ...run(gh), log: (l) => lines.push(l), git: recordingGit(s) })
    assert.equal(result.outcome, 'updated')
    assert.equal(result.head, remoteHead(s))
    assert.deepEqual(
      base.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -', 'pr comment 15 --repo o/r --body-file -'],
    )
    assert.ok(
      lines.includes(
        `::warning title=Candidate updated, comment not written::candidate/4 is at ${result.head?.slice(0, 8)}; the comment on #12 failed (HTTP 502 bad gateway)`,
      ),
      lines.join('\n'),
    )
  })

  test('no candidate open: nothing read beyond the list', () => {
    const gh = fakeGh({ '--state open': [] })
    const result = follow({ ...run(gh), git: noGit() })
    assert.deepEqual([result.path, result.reason], ['none', 'no candidate open'])
  })

  test('someone pushed to the candidate between the read and the fetch: nothing pushed, nothing written', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    git(s.seed, 'switch', '-q', 'candidate/4')
    git(s.seed, 'commit', '-q', '--allow-empty', '-m', 'feat: later')
    git(s.seed, 'push', '-q', 'origin', 'candidate/4')
    const gh = fakeGh(answers(s))
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    assert.equal(result.outcome, 'moved-meanwhile')
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('a dry run computes the new head locally and pushes nothing', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    const gh = makeDryGh(answers(s), log)
    const result = follow({ ...run(gh), log, git: recordingGit(s, { dryRun: true, log }) })
    assert.equal(result.outcome, 'updated')
    assert.equal(remoteHead(s), s.oldHead)
    assert.ok(lines.includes('candidate: follow main: main moved and no pull request is open into candidate/4: rebase'))
    assert.ok(
      lines.some((l) =>
        l.startsWith(`[dry-run] git push --force-with-lease=refs/heads/candidate/4:${s.oldHead} origin ${result.head}`),
      ),
    )
    assert.ok(lines.some((l) => l.startsWith('[dry-run] gh pr comment 40')))
  })

  test('a shallow clone is unshallowed, then the candidate is rebased', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    // A file:// URL, so the depth is honoured.
    const shallow = join(s.dir, 'shallow')
    git(s.dir, 'clone', '-q', '--no-checkout', '--depth', '1', `file://${s.remote}`, shallow)
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true')
    const gh = fakeGh(answers(s))
    const result = follow({ ...run(gh), git: recordingGit({ ...s, clone: shallow }) })
    assert.equal(result.outcome, 'updated')
    const head = remoteHead(s)
    assert.equal(result.head, head)
    assert.equal(git(s.remote, 'rev-parse', `${head}~2`), s.base)
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'false')
  })

  test('the merge path tells the candidate and every pull request into it, none into the base', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({
      ...answers(s, { prsInto: [15, 12] }),
      'api graphql': [
        node(15, { baseRefName: 'candidate/4' }),
        node(20, { baseRefName: 'main' }),
        node(12, { baseRefName: 'candidate/4' }),
      ],
      'issues/20/comments': '',
    })
    const result = follow({ ...run(gh), git: recordingGit(s) })
    assert.equal(result.path, 'merge')
    assert.equal(result.outcome, 'updated')
    assert.match(result.reason, /#12, #15 are open into candidate\/4/)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 40 --repo o/r --body-file -',
        'pr comment 12 --repo o/r --body-file -',
        'pr comment 15 --repo o/r --body-file -',
      ],
    )
  })

  test('a pull request open on the base only does not stand on the candidate: rebase', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({ ...answers(s), 'api graphql': [node(20, { baseRefName: 'main' })] })
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    assert.equal(result.path, 'rebase')
    assert.equal(result.outcome, 'updated')
    assert.ok(g.pushes[0]?.[0]?.startsWith('--force-with-lease='))
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -'],
    )
  })

  test('a base the fetch did not bring: nothing pushed, nothing written', (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({ ...answers(s), 'compare/main...candidate/4': { behindBy: 1, base: 'f'.repeat(40) } })
    const g = recordingGit(s)
    const result = follow({ ...run(gh), git: g })
    assert.equal(result.outcome, 'moved-meanwhile')
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('a rebase that fails with no file in conflict throws, naming git rebase', () => {
    const oldHead = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: oldHead }],
      'compare/main...candidate/4': { behindBy: 1, base },
      'api graphql': [],
    })
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    const fake: Git = {
      run: (args) => {
        const line = args.join(' ')
        if (line.includes('--is-shallow-repository')) return ok('false')
        if (line.includes('rev-parse refs/remotes/origin/candidate/4')) return ok(oldHead)
        if (/ rebase --keep-empty /.test(` ${line} `)) {
          return { status: 1, stdout: '', stderr: 'fatal: no identity\n' }
        }
        return ok()
      },
      push: (args) => {
        throw new Error(`unexpected git push ${args.join(' ')}`)
      },
    }
    assert.throws(() => follow({ ...run(gh), git: fake }), /git rebase failed: fatal: no identity/)
    assert.deepEqual(gh.writes, [])
  })
})

// The fake's reads, and the writes of a real dry run: logged, never made.
function makeDryGh(answers: Record<string, unknown>, log: (line: string) => void): Gh {
  const fake = fakeGh(answers)
  const dry = makeGh({ dryRun: true, log })
  return { read: fake.read, write: dry.write }
}

describe("the Ready check on the candidate's merge", () => {
  const rules = readyRules({
    board: {
      github: { project: { owner: 'o', number: 1 } },
      issueTypes: { parents: ['Feature'], children: ['Task'] },
      subIssues: true,
      blockedBy: true,
      fields: {
        status: { name: 'Stato', type: 'singleSelect', options: ['Nuova', 'Pronta'], ready: 'Pronta' },
        priority: { name: 'Priority', type: 'singleSelect', options: ['P0'] },
        size: { name: 'Size', type: 'singleSelect', options: ['S'] },
      },
    },
  })
  assert.ok(rules)
  const withReady: CandidateConfig = { ...config, ready: rules }
  const set = { __typename: 'ProjectV2ItemFieldSingleSelectValue' }

  interface FakeIssue {
    state?: string
    blocking?: number[]
    blockedBy?: Array<{ number: number; state: string }>
    type?: string | null
    parent?: number | null
    size?: boolean
    status?: string
    project?: number
    open?: number
  }

  // The issues by number; the repository's client answers the issue's reads, the board's
  // the item's. `refused` makes the board's read fail as a token without the permission.
  function fakeBoard(
    issues: Record<number, FakeIssue>,
    { merged = [] as unknown[], refused = false, comments = [] as string[] } = {},
  ) {
    const writes: string[] = []
    const inputs: string[] = []
    const numberOf = (args: string[]) => Number(args.find((a) => a.startsWith('number='))?.slice('number='.length))
    const of = (args: string[]) => {
      const issue = issues[numberOf(args)]
      if (!issue) throw new Error(`no issue in ${args.join(' ')}`)
      return issue
    }
    const repoNode = (number: number, state = 'OPEN') => ({ number, state, repository: { nameWithOwner: 'o/r' } })
    const gh: Gh = {
      read: (args) => {
        const line = args.join(' ')
        if (line.includes('pr list')) return JSON.stringify(merged)
        if (line.includes('/comments')) return comments.map((body) => JSON.stringify({ id: 1, body })).join('\n')
        const issue = of(args)
        if (line.includes('blocking(first')) {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  state: issue.state ?? 'CLOSED',
                  blocking: {
                    pageInfo: { hasNextPage: false },
                    nodes: (issue.blocking ?? []).map((n) => repoNode(n, issues[n]?.state ?? 'OPEN')),
                  },
                },
              },
            },
          })
        }
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                number: numberOf(args),
                title: 't',
                state: issue.state ?? 'OPEN',
                repository: { nameWithOwner: 'o/r' },
                issueType: issue.type === null ? null : { name: issue.type ?? 'Task' },
                parent: issue.parent === null ? null : { number: issue.parent ?? 1 },
                subIssuesSummary: { total: issue.open ?? 0, completed: 0 },
                blockedBy: {
                  pageInfo: { hasNextPage: false },
                  nodes: (issue.blockedBy ?? []).map((b) => repoNode(b.number, b.state)),
                },
              },
            },
          },
        })
      },
      write: (args, input) => {
        writes.push(args.join(' '))
        if (input) inputs.push(input)
        return ''
      },
    }
    const board: Gh = {
      read: (args) => {
        if (refused) throw new Error('gh: Resource not accessible by integration')
        const issue = of(args)
        const node = {
          id: `I_${numberOf(args)}`,
          isArchived: false,
          status: { name: issue.status ?? 'Nuova' },
          f0: set,
          f1: issue.size === false ? null : set,
          project: {
            id: 'PVT',
            number: issue.project ?? 1,
            owner: { login: 'o' },
            field: {
              id: 'F',
              options: [
                { id: 'a', name: 'Nuova' },
                { id: 'b', name: 'Pronta' },
              ],
            },
          },
        }
        return JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [node] } } } } })
      },
      write: (args) => {
        writes.push(`board ${args.filter((a) => /^(item|option)=/.test(a)).join(' ')}`)
        return ''
      },
    }
    return { gh, board, writes, inputs }
  }

  const merge = {
    ...pr,
    number: 40,
    baseRef: 'main',
    headRef: 'candidate/4',
    merged: true,
    body: recordMerges(candidateBody(config, 4), [{ number: 70, title: 't', closes: ['#69'] }]),
  }
  const merged = [{ number: 70, body: 'Closes #69' }]
  const lines: string[] = []
  const go = ({ gh, board }: { gh: Gh; board: Gh }, c = withReady, r = merge) =>
    readyAfterMerge({ gh, board, repo: 'o/r', config: c, log: (l) => lines.push(l) }, r)

  test('an issue the merge unblocked moves, with the evidence on the candidate', () => {
    const fake = fakeBoard(
      { 69: { blocking: [486] }, 486: { blockedBy: [{ number: 69, state: 'CLOSED' }] } },
      { merged },
    )
    const report = go(fake)
    assert.deepEqual(report?.moved, [{ number: 486, evidence: '#69 closed by #70' }])
    assert.deepEqual(fake.writes, ['board item=I_486 option=b', 'pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /<!-- candidate:ready:candidate\/4 -->/)
    assert.match(fake.inputs[0], /Moved to Pronta:\n\n- #486: #69 closed by #70\./)
  })

  test('one still blocked stays, and the comment says by what', () => {
    const fake = fakeBoard(
      {
        69: { blocking: [486] },
        486: {
          blockedBy: [
            { number: 69, state: 'CLOSED' },
            { number: 5, state: 'OPEN' },
          ],
        },
      },
      { merged },
    )
    const report = go(fake)
    assert.deepEqual(report?.moved, [])
    assert.deepEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /Left at Nuova:\n\n- #486: missing open blocker #5 \(#69 closed by #70\)\./)
  })

  test('one missing a field stays, and the comment names the field', () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: { size: false } }, { merged })
    go(fake)
    assert.deepEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /- #486: missing Size \(#69 closed by #70\)\./)
  })

  test('one holding open sub-issues stays, and is said so', () => {
    const fake = fakeBoard({ 69: { blocking: [33] }, 33: { type: 'Feature', open: 2 } }, { merged })
    go(fake)
    assert.deepEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /- #33: holds 2 open sub-issues/)
  })

  test('nothing waited: no comment', () => {
    const fake = fakeBoard({ 69: {} }, { merged })
    assert.deepEqual(go(fake), { moved: [], already: [], left: [] })
    assert.deepEqual(fake.writes, [])
  })

  test('a blocker still open unblocks nothing', () => {
    const fake = fakeBoard({ 69: { state: 'OPEN', blocking: [486] }, 486: {} }, { merged })
    go(fake)
    assert.deepEqual(fake.writes, [])
  })

  test('an issue past the first status is left alone; one at Ready is reported, not moved', () => {
    const fake = fakeBoard(
      { 69: { blocking: [1, 2] }, 1: { status: 'In progress' }, 2: { status: 'Pronta' } },
      { merged },
    )
    const report = go(fake)
    assert.deepEqual(report?.moved, [])
    assert.deepEqual(report?.already, [{ number: 2, evidence: '#69 closed by #70' }])
    assert.deepEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.doesNotMatch(fake.inputs[0], /#1:/)
  })

  test('an issue on another Project only is left alone', () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: { project: 9 } }, { merged })
    assert.deepEqual(go(fake), { moved: [], already: [], left: [] })
    assert.deepEqual(fake.writes, [])
  })

  test("a blocker no merged pull request names is the candidate's own", () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged: [] })
    assert.deepEqual(go(fake)?.moved, [{ number: 486, evidence: '#69 closed by #40' }])
  })

  test('a refused token and a missing status are notices, and the run stays green', () => {
    lines.length = 0
    const refused = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged, refused: true })
    assert.deepEqual(go(refused), { moved: [], already: [], left: [] })
    assert.match(lines.join('\n'), /::notice title=Board not moved::#486 is not moved to "Pronta"/)
    lines.length = 0
    assert.ok(rules)
    const other = { ...withReady, ready: { ...rules, status: { ...rules.status, ready: 'Mancante' } } }
    go(fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged }), other)
    assert.match(lines.join('\n'), /"Mancante" is not an option of Stato \(Nuova, Pronta\)/)
  })

  test('no Projects token: a notice and nothing else', () => {
    lines.length = 0
    const { gh, writes } = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged })
    assert.equal(readyAfterMerge({ gh, repo: 'o/r', config: withReady, log: (l) => lines.push(l) }, merge), null)
    assert.match(lines.join('\n'), /no token with the Projects permission/)
    assert.deepEqual(writes, [])
  })

  test('a project with no board or no blocked-by relation has no check', () => {
    const fake = fakeBoard({})
    assert.equal(go(fake, config), null)
    assert.ok(rules)
    assert.equal(go(fake, { ...config, ready: { ...rules, blockedBy: false } }), null)
    assert.deepEqual(fake.writes, [])
  })

  test('a rerun does not write the comment twice', () => {
    const fake = fakeBoard(
      { 69: { blocking: [486] }, 486: { status: 'Pronta' } },
      {
        merged,
        comments: [`${readyMarker('candidate/4')}\nbefore`],
      },
    )
    go(fake)
    assert.deepEqual(fake.writes, [])
  })

  test('an issue that cannot be read does not stop the others, and fails the run after the comment', () => {
    const fake = fakeBoard({ 69: { blocking: [1, 2] }, 2: {} }, { merged })
    assert.throws(() => go(fake), /#1: /)
    assert.deepEqual(fake.writes, ['board item=I_2 option=b', 'pr comment 40 --repo o/r --body-file -'])
  })

  test("the candidate's merge closes its issues before it checks who waited on them", () => {
    const order: string[] = []
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged })
    const gh: Gh = {
      read: (args) => {
        const line = args.join(' ')
        if (line.includes('issues/69') && line.includes('--jq')) return JSON.stringify({ state: 'open', isPr: false })
        if (line.includes('blocking(first')) order.push('check')
        if (line.includes('api graphql') && line.includes('pullRequests')) return JSON.stringify([])
        if (line.includes('--state open') || line.includes('search')) return '[]'
        return fake.gh.read(args)
      },
      write: (args, input) => {
        if (args[0] === 'issue') order.push('close')
        return fake.gh.write(args, input)
      },
    }
    candidateMerged({ gh, board: fake.board, repo: 'o/r', config: withReady, log: silent }, merge)
    assert.deepEqual(order, ['close', 'check'])
  })
})
