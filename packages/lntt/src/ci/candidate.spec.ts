import { assert, describe, it } from '@effect/vitest'
import {
  announceComment,
  type CandidateConfig,
  candidateBody,
  candidateName,
  carryOverDecision,
  closeDecision,
  closingReferences,
  followDecision,
  gitAuthEnv,
  guardDecision,
  isAnnounced,
  isCandidateMerge,
  isHotfix,
  issueNumber,
  nextCandidateNumber,
  orphanCandidate,
  pickBoard,
  prFromEvent,
  recordMerges,
  retargetDecision,
  sweepDecision,
} from './candidate.ts'

const config: CandidateConfig = {
  base: 'main',
  prefix: 'candidate/',
  hotfix: { prefix: 'hotfix/', label: 'hotfix' },
  status: { inRelease: 'In release', done: 'Done' },
  retrospective: '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n<!-- retro:end -->\n',
  automated: [{ author: 'dependabot[bot]', branch: 'dependabot/', runs: 'after-approval', ci: 'full' }],
}
// pelion's shape: release/<N>, same base and hotfix markers.
const pelion: CandidateConfig = { ...config, prefix: 'release/' }

describe('names and numbers', () => {
  it('the name is the prefix without its separator', () => {
    assert.strictEqual(candidateName(config), 'candidate')
    assert.strictEqual(candidateName(pelion), 'release')
    assert.strictEqual(candidateName({ ...config, prefix: 'rc-' }), 'rc')
  })

  it('the next number is one more than the highest candidate, branch or pull request', () => {
    assert.strictEqual(nextCandidateNumber(config, ['candidate/2', 'candidate/10', 'candidate/9']), 11)
    assert.strictEqual(nextCandidateNumber(config, []), 1)
    assert.strictEqual(
      nextCandidateNumber(config, ['candidate/x', 'candidate/3-fix', 'feat/candidate/7', 'candidate/4']),
      5,
    )
    assert.strictEqual(nextCandidateNumber(pelion, ['release/4', 'candidate/9']), 5)
  })

  it('an orphan branch, newer than every candidate pull request, is picked up', () => {
    assert.strictEqual(
      orphanCandidate(config, { branches: ['candidate/4', 'candidate/5'], prHeads: ['candidate/3', 'candidate/4'] }),
      'candidate/5',
    )
    assert.strictEqual(orphanCandidate(config, { branches: ['candidate/4'], prHeads: ['candidate/4'] }), null)
    assert.strictEqual(orphanCandidate(config, { branches: ['candidate/2'], prHeads: ['candidate/5'] }), null)
  })
})

describe('isHotfix and retargetDecision', () => {
  const pr = { baseRef: 'main', headRef: 'feat/31/x', labels: [] }

  it('a hotfix by branch prefix or by label, in any case', () => {
    assert.strictEqual(isHotfix(config, { headRef: 'hotfix/login-500' }), true)
    assert.strictEqual(isHotfix(config, { headRef: 'fix/12/login', labels: ['bug', 'Hotfix'] }), true)
    assert.strictEqual(isHotfix(config, { headRef: 'fix/12/hotfix-login', labels: ['bug'] }), false)
    assert.strictEqual(
      isHotfix({ ...config, hotfix: { prefix: 'urgent/', label: 'urgent' } }, { headRef: 'urgent/x' }),
      true,
    )
  })

  it('a pull request into the base moves; others, candidates and hotfixes stay', () => {
    assert.strictEqual(retargetDecision(config, pr).move, true)
    assert.strictEqual(retargetDecision(config, { ...pr, baseRef: 'candidate/3' }).move, false)
    assert.strictEqual(retargetDecision(config, { ...pr, headRef: 'candidate/3' }).move, false)
    assert.strictEqual(retargetDecision(config, { ...pr, headRef: 'hotfix/x' }).move, false)
    assert.strictEqual(retargetDecision(config, { ...pr, labels: ['hotfix'] }).move, false)
    assert.strictEqual(retargetDecision({ ...config, base: 'trunk' }, pr).move, false)
  })

  it("a bot's pull request (delivery.automated) stays; the same branch from someone else moves", () => {
    const bump = { ...pr, headRef: 'dependabot/npm/x' }
    assert.strictEqual(retargetDecision(config, { ...bump, author: 'dependabot[bot]' }).move, false)
    assert.strictEqual(retargetDecision(config, { ...bump, author: 'octocat' }).move, true)
  })
})

describe('guardDecision', () => {
  const pr = { number: 7, baseRef: 'main', headRef: 'feat/31/x', labels: [], author: 'octocat', fromFork: false }

  it('a pull request into another branch, the candidate, a hotfix, a Dependabot one pass', () => {
    assert.strictEqual(guardDecision(config, { ...pr, baseRef: 'candidate/3' }).pass, true)
    assert.strictEqual(guardDecision(config, { ...pr, headRef: 'candidate/3' }).pass, true)
    assert.strictEqual(guardDecision(pelion, { ...pr, headRef: 'release/3' }).pass, true)
    assert.strictEqual(guardDecision(config, { ...pr, headRef: 'hotfix/login' }).pass, true)
    assert.strictEqual(guardDecision(config, { ...pr, labels: ['Hotfix'] }).pass, true)
    const bump = { ...pr, headRef: 'dependabot/npm_and_yarn/vite-7.1.0' }
    assert.strictEqual(guardDecision(config, { ...bump, author: 'dependabot[bot]' }).pass, true)
    // gh names the same bot app/dependabot.
    assert.strictEqual(guardDecision(config, { ...bump, author: 'app/dependabot' }).pass, true)
  })

  it('any other pull request into the base fails, with the remedy', () => {
    const decision = guardDecision(config, pr)
    assert.strictEqual(decision.pass, false)
    assert.match(decision.reason, /#7 targets main and is neither the candidate nor a hotfix/)
    assert.match(decision.reason, /pnpm exec lntt ci candidate --pr 7/)
    assert.match(decision.reason, /`hotfix` label/)
    // A Dependabot branch from someone else, a person's branch named like Dependabot's.
    assert.strictEqual(guardDecision(config, { ...pr, headRef: 'dependabot/npm_and_yarn/x' }).pass, false)
    assert.strictEqual(guardDecision(config, { ...pr, author: 'dependabot[bot]' }).pass, false)
    assert.strictEqual(guardDecision(pelion, { ...pr, headRef: 'candidate/3' }).pass, false)
  })

  it('a branch name counts only from this repository; the hotfix label from anywhere', () => {
    const fork = { ...pr, fromFork: true }
    assert.strictEqual(guardDecision(config, { ...fork, headRef: 'candidate/3' }).pass, false)
    assert.strictEqual(guardDecision(config, { ...fork, headRef: 'hotfix/login' }).pass, false)
    assert.strictEqual(guardDecision(config, { ...fork, labels: ['hotfix'] }).pass, true)
    const bump = { ...pr, headRef: 'dependabot/npm_and_yarn/x', author: 'dependabot[bot]' }
    assert.strictEqual(guardDecision(config, { ...bump, fromFork: true }).pass, false)
    // An older gh names the bot dependabot.
    assert.strictEqual(guardDecision(config, { ...bump, author: 'dependabot' }).pass, true)
  })

  it('a head whose repository is unknown counts as a fork', () => {
    const unknown = { ...pr, fromFork: undefined }
    assert.strictEqual(guardDecision(config, { ...unknown, headRef: 'candidate/3' }).pass, false)
    assert.strictEqual(guardDecision(config, { ...unknown, labels: ['hotfix'] }).pass, true)
  })
})

describe('prFromEvent', () => {
  const event = (fields = {}) => ({
    pull_request: {
      number: 7,
      title: 't',
      body: null,
      base: { ref: 'main', repo: { full_name: 'o/r' } },
      head: { ref: 'feat/3/x', repo: { full_name: 'o/r' } },
      user: { login: 'octocat' },
      ...fields,
    },
  })

  it('the author and whether the head is a fork', () => {
    assert.strictEqual(prFromEvent(event()).author, 'octocat')
    assert.strictEqual(prFromEvent(event()).fromFork, false)
    assert.strictEqual(prFromEvent(event({ head: { ref: 'x', repo: { full_name: 'someone/r' } } })).fromFork, true)
    // A deleted fork has no head repository: not this one.
    assert.strictEqual(prFromEvent(event({ head: { ref: 'x', repo: null } })).fromFork, true)
  })

  it('a deleted account (user null) leaves the author out, an event without repositories the fork out', () => {
    assert.strictEqual(prFromEvent(event({ user: null })).author, undefined)
    const bare = prFromEvent(event({ base: { ref: 'main' }, head: { ref: 'x' } }))
    assert.strictEqual(bare.fromFork, undefined)
  })
})

describe('closingReferences', () => {
  it('every keyword form, in any case, with or without a colon, once each', () => {
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
    assert.deepStrictEqual(closingReferences(body), ['#1', '#2', '#3', '#4', '#5', '#6', '#7', 'o/r#8', '#9'])
  })

  it('no keyword, code and HTML comments do not count', () => {
    assert.deepStrictEqual(closingReferences('Refs #2\nsee #3\nprefixes #4'), [])
    assert.deepStrictEqual(closingReferences('Closes #1\n`Closes #2`\n```\nCloses #3\n```\n<!-- Closes #4 -->'), ['#1'])
    assert.deepStrictEqual(closingReferences(null), [])
  })
})

describe('candidateBody', () => {
  it('a sentence naming the candidate, then the two empty lists', () => {
    const body = candidateBody(config, 3)
    assert.match(body, /^Candidate 3: pull requests into `main` land here/)
    assert.match(body, /<!-- candidate:prs:start -->\n<!-- candidate:prs:end -->/)
    assert.match(body, /<!-- candidate:closes:start -->\n<!-- candidate:closes:end -->/)
  })
})

describe('recordMerges', () => {
  it('adds the pull request line and its closing lines, once', () => {
    const pr = { number: 70, title: 'ci: cache', closes: ['#69', '#71'] }
    const body = recordMerges(candidateBody(config, 3), [pr])
    assert.match(body, /- #70 ci: cache\n/)
    assert.match(body, /Closes #69\nCloses #71\n/)
    assert.strictEqual(recordMerges(body, [pr]), body)
  })

  it('lists in the order given and does not repeat a shared issue', () => {
    const later = recordMerges(candidateBody(config, 3), [{ number: 123, title: 'b', closes: ['#6'] }])
    const both = recordMerges(later, [
      { number: 12, title: 'a', closes: ['#5'] },
      { number: 123, title: 'b', closes: ['#5', '#6'] },
    ])
    assert.match(both, /- #12 a\n- #123 b\n/)
    assert.match(both, /Closes #5\nCloses #6\n/)
    assert.strictEqual(both.match(/Closes #5/g)?.length, 1)
  })

  it('keeps lines written by hand after the rebuilt ones', () => {
    const body = candidateBody(config, 3)
      .replace('<!-- candidate:prs:end -->', '- by hand\n<!-- candidate:prs:end -->')
      .replace('<!-- candidate:closes:end -->', 'Closes #9\n<!-- candidate:closes:end -->')
    const next = recordMerges(body, [{ number: 7, title: 't', closes: ['#1'] }])
    assert.match(next, /- #7 t\n- by hand\n/)
    assert.match(next, /Closes #1\nCloses #9\n/)
  })

  it('a body without the markers gets both blocks at the end, its text kept', () => {
    const body = recordMerges('Written by hand.', [{ number: 7, title: 't', closes: ['#1'] }])
    assert.ok(body.startsWith('Written by hand.\n\n'))
    assert.match(body, /- #7 t/)
    assert.match(body, /Closes #1/)
  })
})

// A gh double: reads answered from `answers` by the first key the command line
// contains (a string as is, anything else as JSON), writes recorded.
describe('isCandidateMerge', () => {
  it('only the merged candidate into the base', () => {
    assert.strictEqual(isCandidateMerge(config, { merged: true, baseRef: 'main', headRef: 'candidate/4' }), true)
    assert.strictEqual(isCandidateMerge(config, { merged: true, baseRef: 'candidate/4', headRef: 'feat/x' }), false)
    assert.strictEqual(isCandidateMerge(config, { merged: false, baseRef: 'main', headRef: 'candidate/4' }), false)
    assert.strictEqual(isCandidateMerge(config, { merged: true, baseRef: 'main', headRef: 'feat/x' }), false)
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

  it('pull requests still on the candidate, and those GitHub moved from it onto the base', () => {
    const decision = carryOverDecision(config, {
      candidateBranch: 'candidate/4',
      openPrs: [
        open(12, { baseRef: 'candidate/4' }),
        open(11, { lastBaseChange: { from: 'candidate/4', to: 'main' } }),
      ],
    })
    assert.deepStrictEqual(decision.move, [11, 12])
  })

  it('others, hotfixes, candidates and the bots of delivery.automated stay', () => {
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
        open(7, { ...fromCandidate, headRef: 'dependabot/npm/x', author: 'dependabot[bot]' }),
      ],
    })
    assert.deepStrictEqual(decision.move, [])
  })
})

describe('issues', () => {
  it('issueNumber: this repo, in any case; another repo is not ours', () => {
    assert.strictEqual(issueNumber('#12', 'LunetteOrg/starter'), 12)
    assert.strictEqual(issueNumber('lunetteorg/Starter#12', 'LunetteOrg/starter'), 12)
    assert.strictEqual(issueNumber('LunetteOrg/other#12', 'LunetteOrg/starter'), null)
  })

  it('the announcement names the candidate and is recognised per candidate', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    assert.match(comment, /candidate 4 \(#40\) will close this issue/)
    assert.strictEqual(isAnnounced(['ok', comment], 'candidate/4'), true)
    assert.strictEqual(isAnnounced([comment], 'candidate/14'), false)
    assert.strictEqual(isAnnounced([comment], 'candidate/41'), false)
    assert.strictEqual(isAnnounced([null], 'candidate/4'), false)
  })

  it('closeDecision: open issues close, closed ones and pull requests stay', () => {
    assert.deepStrictEqual(
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

describe('closing references as issue URLs', () => {
  it('a full issue URL after the keyword counts, as owner/repo#N', () => {
    assert.deepStrictEqual(closingReferences('Closes https://github.com/LunetteOrg/starter/issues/31\nFixes #2'), [
      'LunetteOrg/starter#31',
      '#2',
    ])
    assert.deepStrictEqual(closingReferences('Closes https://github.com/o/r/pull/3'), [])
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

  it('pull requests stranded on a candidate that is no longer open move; others stay', () => {
    const decision = sweepDecision(config, {
      openCandidates: ['candidate/5'],
      openPrs: [
        open(1, { baseRef: 'candidate/4' }),
        open(2, { lastBaseChange: { from: 'candidate/3', to: 'main' } }),
        open(3, { baseRef: 'candidate/5' }),
        open(4, { lastBaseChange: { from: 'candidate/5', to: 'main' } }),
        open(5, { baseRef: 'candidate/4', labels: ['hotfix'] }),
        open(6, { baseRef: 'candidate/4', headRef: 'dependabot/npm/x', author: 'dependabot[bot]' }),
        open(7, { baseRef: 'main', headRef: 'candidate/5' }),
        open(8),
      ],
    })
    assert.deepStrictEqual(decision.move, [1, 2])
  })
})

describe('pickBoard', () => {
  const own = { name: 'own' }
  const withToken = (t: string) => ({ name: t })

  it('the Projects token wins, in a workflow or not', () => {
    assert.deepStrictEqual(pickBoard('tok', true, own, withToken), { name: 'tok' })
    assert.deepStrictEqual(pickBoard('tok', false, own, withToken), { name: 'tok' })
  })

  it('a workflow without the token has no board, a terminal uses its own login', () => {
    assert.strictEqual(pickBoard(undefined, true, own, withToken), undefined)
    assert.strictEqual(pickBoard(undefined, false, own, withToken), own)
    assert.strictEqual(pickBoard('', true, own, withToken), undefined)
  })
})

describe('followDecision', () => {
  it('no candidate open: nothing', () => {
    assert.deepStrictEqual(followDecision(config, { candidate: null, behindBy: 3, prsInto: [] }), {
      path: 'none',
      reason: 'no candidate open',
    })
  })

  it('the base is an ancestor of the candidate: nothing', () => {
    assert.deepStrictEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 0, prsInto: [12] }), {
      path: 'none',
      reason: 'main is an ancestor of candidate/4',
    })
  })

  it('the base moved and nobody stands on the candidate: rebase', () => {
    assert.deepStrictEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 2, prsInto: [] }), {
      path: 'rebase',
      reason: 'main moved and no pull request is open into candidate/4: rebase',
    })
  })

  it('the base moved and pull requests are open into the candidate: merge', () => {
    assert.deepStrictEqual(followDecision(config, { candidate: 'candidate/4', behindBy: 1, prsInto: [15, 12] }), {
      path: 'merge',
      reason: 'main moved and #12, #15 are open into candidate/4: merge main into it, no rewrite',
    })
    assert.strictEqual(
      followDecision(config, { candidate: 'candidate/4', behindBy: 1, prsInto: [12] }).reason,
      'main moved and #12 is open into candidate/4: merge main into it, no rewrite',
    )
  })

  it('the base name comes from the configuration', () => {
    const trunk = { ...config, base: 'trunk' }
    assert.strictEqual(
      followDecision(trunk, { candidate: 'candidate/4', behindBy: 1, prsInto: [] }).reason,
      'trunk moved and no pull request is open into candidate/4: rebase',
    )
  })
})

describe('gitAuthEnv', () => {
  it('in Actions with a token: an extra header in the environment, never in the arguments', () => {
    const extra = gitAuthEnv({ GITHUB_ACTIONS: 'true', GH_TOKEN: 'tok' })
    assert.deepStrictEqual(extra, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok').toString('base64')}`,
    })
  })

  it('from a terminal, or without a token: nothing', () => {
    assert.deepStrictEqual(gitAuthEnv({ GH_TOKEN: 'tok' }), {})
    assert.deepStrictEqual(gitAuthEnv({ GITHUB_ACTIONS: 'true' }), {})
  })
})

// The fake's reads, and the writes of a real dry run: logged, never made.
