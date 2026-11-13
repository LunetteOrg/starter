import { assert, describe, it } from '@effect/vitest'
import { readyRules } from '../board-ready.ts'
import {
  announce,
  candidateMerged,
  carryOver,
  closeCandidateIssues,
  dryGh,
  type Gh,
  type Git,
  handle,
  handlePush,
  type Run,
  readyAfterMerge,
  record,
  retarget,
  setBoardStatus,
  sweep,
} from '../testing/candidate.ts'
import {
  announceComment,
  type CandidateConfig,
  candidateBody,
  type PullRequest,
  readyMarker,
  recordMerges,
  retrospectiveComment,
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

const node = (number: number, fields = {}) => ({
  number,
  baseRefName: 'main',
  headRefName: `feat/${number}/x`,
  author: { login: 'someone' },
  labels: { nodes: [] },
  timelineItems: { nodes: [] },
  ...fields,
})

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

describe('retarget', () => {
  it('a real run whose gh pr create gives no pull request number fails, naming what gh said', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [],
      '--state all': [],
      'commits/main': { sha: 'b'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } },
    })
    const odd: Gh = { ...gh, write: (args, input) => (args[1] === 'create' ? 'created' : gh.write(args, input)) }
    assert.throws(() => retarget(run(odd), pr), /gh pr create gave no pull request number: created/)
  })

  it('a dry run that creates the candidate comments it as <new>, the number it does not have yet', () => {
    const lines: string[] = []
    const gh = dryGh(
      fakeGh({
        '--state open': [],
        'matching-refs': [],
        '--state all': [],
        'commits/main': { sha: 'b'.repeat(40), commit: { tree: { sha: 'c'.repeat(40) } } },
      }),
      (l) => lines.push(l),
    )
    retarget({ ...run(gh), log: (l) => lines.push(l) }, pr)
    assert.ok(lines.includes('[dry-run] gh pr comment <new> --repo o/r --body-file -'), lines.join('\n'))
    // The comment on the pull request moved names it the same way.
    assert.ok(
      lines.some((l) => l.includes('the open candidate (#<new>)')),
      lines.join('\n'),
    )
  })

  it('moves the pull request onto the open candidate and comments', () => {
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }], ...hasRetro(40) })
    retarget(run(gh), pr)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 70 --repo o/r --base candidate/4', 'pr comment 70 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[1].input ?? '', /candidate\/4.*#40/)
    assert.match(gh.writes[1].input ?? '', /`hotfix` label/)
  })

  it('creates the next candidate when none is open, then moves the pull request', () => {
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
    assert.strictEqual(writes[3], 'pr comment 42 --repo o/r --body-file -')
    assert.strictEqual(writes[4], 'pr edit 70 --repo o/r --base candidate/6')
    assert.match(gh.writes[5].input ?? '', /#42/)
  })

  it('a new candidate opens with a comment holding the empty retrospective block', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [],
      '--state all': [],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    retarget(run(gh), pr)
    const comment = gh.writes.find((w) => w.args === 'pr comment 42 --repo o/r --body-file -')
    assert.ok(comment, 'no comment on the new candidate')
    assert.strictEqual(comment.input, retrospectiveComment(config))
    assert.ok((comment.input ?? '').endsWith(`\n\n${config.retrospective}`))
    assert.match(comment.input ?? '', /`pnpm exec lntt retro add --label <label> "<one sentence>"`/)
    assert.match(comment.input ?? '', /\(`pnpm exec lntt check body --pr <n>`\)/)
  })

  it("pelion's release/<N> works the same", () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [],
      '--state all': [{ headRefName: 'release/7' }],
      'commits/main': { sha: 'abc12345', commit: { tree: { sha: 'tree1' } } },
    })
    retarget(run(gh, pelion), pr)
    assert.match(gh.writes[2].args, /--head release\/8 --title release 8/)
    assert.match(gh.writes[3].input ?? '', /The retrospective of this release/)
    assert.strictEqual(gh.writes[4].args, 'pr edit 70 --repo o/r --base release/8')
  })

  it('a branch left without its pull request is reused, pull request only', () => {
    const gh = fakeGh({
      '--state open': [],
      'matching-refs': [{ ref: 'refs/heads/candidate/6' }],
      '--state all': [{ headRefName: 'candidate/5' }],
    })
    retarget(run(gh), pr)
    assert.match(gh.writes[0].args, /pr create .*--head candidate\/6 --title candidate 6/)
    assert.strictEqual(gh.writes[1].args, 'pr comment 42 --repo o/r --body-file -')
    assert.strictEqual(gh.writes[2].args, 'pr edit 70 --repo o/r --base candidate/6')
  })

  it('an open candidate a run left without its retrospective comment gets it, then the move', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }],
      'issues/40/comments': JSON.stringify({ id: 1, body: 'Moved onto candidate/4.' }),
    })
    retarget(run(gh), pr)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 40 --repo o/r --body-file -',
        'pr edit 70 --repo o/r --base candidate/4',
        'pr comment 70 --repo o/r --body-file -',
      ],
    )
    assert.strictEqual(gh.writes[0]?.input, retrospectiveComment(config))
  })

  it('a hotfix is neither moved nor read about', () => {
    const gh = fakeGh({})
    retarget(run(gh), { ...pr, labels: ['hotfix'] })
    assert.deepStrictEqual(gh.writes, [])
  })
})

describe('record', () => {
  const merged = { ...pr, baseRef: 'candidate/4', merged: true }

  it('writes the pull request into the candidate body', () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, body: candidateBody(config, 4) }],
      '--state merged': [],
      ...issue(69, { comments: [announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })] }),
    })
    record(run(gh), merged)
    assert.strictEqual(gh.writes[0].args, 'pr edit 40 --repo o/r --body-file -')
    assert.match(gh.writes[0].input ?? '', /- #70 ci: cache[\s\S]*Closes #69/)
  })

  it('writes nothing when the pull request is already there', () => {
    const body = recordMerges(candidateBody(config, 4), [{ number: 70, title: 'ci: cache', closes: ['#69'] }])
    const gh = fakeGh({
      '--state open': [{ number: 40, body }],
      '--state merged': [{ number: 70, title: 'ci: cache', body: 'Closes #69', mergedAt: '2026-10-13T10:00:00Z' }],
      ...issue(69, { comments: [announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })] }),
    })
    record(run(gh), merged)
    assert.deepStrictEqual(gh.writes, [])
  })

  it('rebuilds the lists from every merged pull request, in merge order, a missed run included', () => {
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
    assert.strictEqual(gh.writes.length, 1)
    assert.match(gh.writes[0].input ?? '', /- #60 feat: x\n- #70 ci: cache\n/)
    assert.match(gh.writes[0].input ?? '', /Closes #59\nCloses #69\n/)
  })

  it('tells the open issues of every merged pull request, once, that the candidate closes them', () => {
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
    assert.deepStrictEqual(
      gh.writes.slice(1).map((w) => w.args),
      ['issue comment 59 --repo o/r --body-file -', 'issue comment 69 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[1].input ?? '', /candidate 4 \(#40\)/)
  })

  it('a closed pull request not merged, or not into a candidate, records nothing', () => {
    const gh = fakeGh({})
    record(run(gh), { ...merged, merged: false })
    record(run(gh), { ...merged, baseRef: 'main' })
    assert.deepStrictEqual(gh.writes, [])
  })

  it('fails, naming the issues, when the candidate pull request is missing', () => {
    const gh = fakeGh({ '--state open': [] })
    assert.throws(() => record(run(gh), merged), /candidate\/4.*#69/)
  })
})

describe('carryOver', () => {
  const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true }

  it('nothing to move: no candidate created, nothing written', () => {
    const gh = fakeGh({ 'api graphql': [node(1)] })
    assert.deepStrictEqual(carryOver(run(gh), candidate).move, [])
    assert.deepStrictEqual(gh.writes, [])
  })

  it('creates the next candidate and moves the pull requests left behind', () => {
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
    assert.strictEqual(writes[3], 'pr comment 42 --repo o/r --body-file -')
    assert.deepStrictEqual(writes.slice(4), [
      'pr edit 11 --repo o/r --base candidate/5',
      'pr comment 11 --repo o/r --body-file -',
      'pr edit 12 --repo o/r --base candidate/5',
      'pr comment 12 --repo o/r --body-file -',
    ])
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

  it('closes the open issues of the body as completed, and leaves the closed ones', () => {
    const gh = fakeGh({ ...issue(69), ...issue(71, { state: 'closed' }), ...issue(72, { isPr: true }) })
    const decision = closeCandidateIssues(run(gh), candidate)
    assert.deepStrictEqual(decision, { close: [69], alreadyClosed: [71], notIssues: [72] })
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  it('a title with a keyword in the pull request list closes nothing', () => {
    const body = recordMerges(candidateBody(config, 4), [
      { number: 60, title: 'fix: #59 cache', closes: [] },
      { number: 70, title: 'chore: close #58', closes: ['#69'] },
    ])
    const gh = fakeGh({ ...issue(69) })
    assert.deepStrictEqual(closeCandidateIssues(run(gh), { ...candidate, body }).close, [69])
  })

  it('an issue that cannot be read does not stop the others, and fails the run naming it', () => {
    const body = recordMerges(candidateBody(config, 4), [{ number: 70, title: 't', closes: ['#9999', '#69'] }])
    const gh = fakeGh({ ...issue(69) })
    assert.throws(() => closeCandidateIssues(run(gh), { ...candidate, body }), /#9999: .*issues\/9999/)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })
})

describe('announce', () => {
  const candidate = { number: 40, headRefName: 'candidate/4' }

  it('a second run writes nothing', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    const gh = fakeGh({ ...issue(69, { comments: ['before', comment] }) })
    assert.deepStrictEqual(announce(run(gh), candidate, [{ body: 'Closes #69' }]).announced, [])
    assert.deepStrictEqual(gh.writes, [])
  })

  it('an issue named twice gets one comment, a closed one and a pull request none', () => {
    const gh = fakeGh({ ...issue(5), ...issue(6, { state: 'closed' }), ...issue(7, { isPr: true }) })
    const { announced } = announce(run(gh), candidate, [
      { body: 'Closes #5\nFixes #6' },
      { body: 'Resolves #5\nCloses #7' },
    ])
    assert.deepStrictEqual(announced, [5])
  })
})

describe('candidateMerged', () => {
  const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }

  it('closes the issues, then moves the pull requests left behind', () => {
    const gh = fakeGh({ ...issue(69), 'api graphql': [] })
    candidateMerged(run(gh), candidate)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  it('a failure closing the issues does not stop the move, and fails the run after it', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/4' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    assert.throws(() => candidateMerged(run(gh), candidate), /issues\/69/)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr comment 12 --repo o/r --body-file -'],
    )
  })
})

describe('sweep', () => {
  it('an open pull request of another shape fails the sweep, naming the read', () => {
    const gh = fakeGh({ '--state open': [], 'api graphql': [{ number: 12 }] })
    assert.throws(() => sweep(run(gh)), /the open pull requests: an answer of another shape/)
  })

  it('moves stranded pull requests onto the open candidate before the event is handled', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    assert.deepStrictEqual(sweep(run(gh)).move, [12])
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr comment 12 --repo o/r --body-file -'],
    )
  })

  it('a candidate without its retrospective comment gets it before the stranded move', () => {
    const gh = fakeGh({
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      'issues/50/comments': '',
    })
    sweep(run(gh))
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 50 --repo o/r --body-file -',
        'pr edit 12 --repo o/r --base candidate/5',
        'pr comment 12 --repo o/r --body-file -',
      ],
    )
  })

  it('a failure writing the retrospective comment is a warning: the pull request still moves', () => {
    const lines: string[] = []
    const gh = fakeGh({ '--state open': [{ number: 40, headRefName: 'candidate/4', body: '' }] })
    retarget({ ...run(gh), log: (l) => lines.push(l) }, pr)
    assert.ok(gh.writes.some((w) => w.args === 'pr edit 70 --repo o/r --base candidate/4'))
    assert.ok(
      lines.some((l) =>
        l.startsWith(
          '::warning title=Retrospective comment::candidate/4: not written (gh api --paginate failed: unexpected read',
        ),
      ),
    )
  })

  it('the warning is one workflow command: newlines flattened, % escaped', () => {
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
    assert.strictEqual(
      warning,
      '::warning title=Retrospective comment::candidate/4: not written (gh api --paginate failed: quota 100%25 used retry later); pnpm exec lntt retro add writes it',
    )
  })

  it('nothing stranded: nothing read beyond the lists, nothing written', () => {
    const gh = fakeGh({ 'api graphql': [node(1)], '--state open': [] })
    assert.deepStrictEqual(sweep(run(gh)).move, [])
    assert.deepStrictEqual(gh.writes, [])
  })

  it('handle sweeps on every event, then does what the event asks', () => {
    const gh = fakeGh({
      'compare/main...candidate/5': { behindBy: 0, base: 'b'.repeat(40) },
      'api graphql': [node(12, { baseRefName: 'candidate/3' })],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    const lines: string[] = []
    handle({ ...run(gh), log: (l) => lines.push(l), git: noGit() }, 'opened', pr)
    assert.deepStrictEqual(
      gh.writes.filter((w) => w.args.includes('--base')).map((w) => w.args),
      ['pr edit 12 --repo o/r --base candidate/5', 'pr edit 70 --repo o/r --base candidate/5'],
    )
    const followed = lines.indexOf('candidate: follow main: main is an ancestor of candidate/5')
    assert.ok(followed >= 0, lines.join('\n'))
    assert.ok(followed < lines.findIndex((l) => l.startsWith('candidate: #70')))
  })

  it('a failure following the base is a warning: the event is still handled', () => {
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

  it('a failure following the base escapes a push run, which turns red', () => {
    const gh = fakeGh({
      'api graphql': [],
      '--state open': [{ number: 50, headRefName: 'candidate/5', body: '' }],
      ...hasRetro(50),
    })
    assert.throws(() => handlePush({ ...run(gh), git: noGit() }), /unexpected read: .*compare\/main\.\.\.candidate\/5/)
  })

  it('without git the follow step says it cannot act and reads nothing', () => {
    const gh = fakeGh({ 'api graphql': [], '--state open': [] })
    const lines: string[] = []
    handlePush({ ...run(gh), log: (l) => lines.push(l) })
    assert.ok(lines.some((l) => /no git client/.test(l)))
  })
})

// A board double: the issue's project items answered to the GraphQL read, the
// mutations recorded.
describe('setBoardStatus', () => {
  it('a project of another shape fails that issue before any write, and the others go on', () => {
    const lines: string[] = []
    const writes: string[] = []
    const board: Gh = {
      read: (args) =>
        args.includes('number=69')
          ? JSON.stringify({
              data: { repository: { issue: { projectItems: { nodes: [{ id: 'I', project: null }] } } } },
            })
          : JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }),
      write: (args) => {
        writes.push(args.join(' '))
        return ''
      },
    }
    assert.throws(
      () => setBoardStatus({ ...run(fakeGh({})), board, log: (l) => lines.push(l) }, [69, 70], 'In release'),
      /#69: the projects of #69: an answer of another shape/,
    )
    assert.deepStrictEqual(writes, [])
    assert.ok(
      lines.some((l) => l.includes('#70 is on no project')),
      lines.join('\n'),
    )
  })

  it('an answer of another shape fails that issue only, as a refused call would, and the others go on', () => {
    const lines: string[] = []
    const board: Gh = {
      read: (args) =>
        args.includes('number=69')
          ? '{}'
          : JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }),
      write: () => '',
    }
    assert.throws(
      () => setBoardStatus({ ...run(fakeGh({})), board, log: (l) => lines.push(l) }, [69, 70], 'In release'),
      /issues not moved to "In release": #69: /,
    )
    assert.ok(
      lines.some((l) => l.includes('#70 is on no project')),
      lines.join('\n'),
    )
  })

  it('moves the issue to the status on each project that has it', () => {
    const board = fakeGh(items(item('i1')))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release')
    assert.deepStrictEqual(moved, [69])
    assert.deepStrictEqual(skipped, [])
    assert.strictEqual(board.writes.length, 1)
    assert.match(board.writes[0]?.args ?? '', /updateProjectV2ItemFieldValue/)
    assert.match(board.writes[0]?.args ?? '', /project=P-i1 -f item=i1 -f field=F-i1 -f option=opt-In release/)
  })

  it('an issue already at the status is left alone', () => {
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    const { moved } = setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release')
    assert.deepStrictEqual(moved, [])
    assert.deepStrictEqual(board.writes, [])
  })

  it('a project without the status skips it with a notice saying how to add it', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'In Progress', 'Done'] })))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepStrictEqual(moved, [])
    assert.deepStrictEqual(skipped, [69])
    assert.deepStrictEqual(board.writes, [])
    assert.match(
      out.lines.join('\n'),
      /::notice .*In release.*not an option.*github-board skill, references\/github-project\.md/s,
    )
  })

  it('a project without a Status field is skipped with a notice', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { status: false })))
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepStrictEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*no Status field/s)
  })

  it('an issue on no project is skipped with a notice', () => {
    const out = notices()
    const board = fakeGh(items())
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepStrictEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*#69 is on no project/s)
  })

  it('without a Projects token the whole step is skipped with one notice', () => {
    const out = notices()
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), log: out.log }, [69, 70], 'In release')
    assert.deepStrictEqual(moved, [])
    assert.deepStrictEqual(skipped, [69, 70])
    assert.strictEqual(out.lines.filter((l) => l.startsWith('::notice')).length, 1)
    assert.match(out.lines.join('\n'), /::notice .*no token with the Projects permission/)
  })

  it('a token refused by Projects is a notice, not an error', () => {
    const out = notices()
    const board: Gh = {
      read: () => {
        throw new Error('Resource not accessible by integration')
      },
      write: () => '',
    }
    const { skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepStrictEqual(skipped, [69])
    assert.match(out.lines.join('\n'), /::notice .*Projects permission.*Resource not accessible/s)
  })

  it('a token that reads but cannot write is a notice, and the next issue is still moved', () => {
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
    assert.deepStrictEqual(skipped, [69])
    assert.deepStrictEqual(moved, [70])
    assert.match(out.lines.join('\n'), /::notice .*Projects permission.*#69/s)
  })

  it('the option is found whatever its case, and an item with no status yet is moved', () => {
    const board = fakeGh(items({ ...item('i1', { options: ['in release'] }), fieldValueByName: null }))
    assert.deepStrictEqual(setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release').moved, [69])
  })

  it('a project without the option does not stop the next one, and the issue counts as moved', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Done'] }), item('i2')))
    const { moved, skipped } = setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'In release')
    assert.deepStrictEqual(moved, [69])
    assert.deepStrictEqual(skipped, [])
    assert.strictEqual(board.writes.length, 1)
    assert.match(board.writes[0]?.args ?? '', /item=i2/)
  })

  it('a failure that is not a refusal names the message, and a rate limit is one', () => {
    const board: Gh = {
      read: () => {
        throw new Error('API rate limit exceeded')
      },
      write: () => '',
    }
    assert.throws(
      () => setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release'),
      /#69: gh api graphql failed: API rate limit/,
    )
  })

  it('a refusal after a first project was written leaves the issue moved on that one', () => {
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
    assert.deepStrictEqual(moved, [69])
    assert.deepStrictEqual(skipped, [])
    assert.strictEqual(base.writes.length, 1)
  })

  it('the notice for a missing option lists the options the project has', () => {
    const out = notices()
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Done'] })))
    setBoardStatus({ ...run(fakeGh({})), board, log: out.log }, [69], 'Dne')
    assert.match(out.lines.join('\n'), /\(Todo, Done\).*delivery\.candidate\.status/s)
  })

  it('any other failure fails the step', () => {
    const board: Gh = {
      read: () => {
        throw new Error('socket hang up')
      },
      write: () => '',
    }
    assert.throws(
      () => setBoardStatus({ ...run(fakeGh({})), board }, [69], 'In release'),
      /#69: gh api graphql failed: socket hang up/,
    )
  })
})

describe('the board follows the candidate', () => {
  const merged = { ...pr, baseRef: 'candidate/4', merged: true }
  const record1 = {
    'pr list': [{ number: 40, body: candidateBody(config, 4) }],
    '--state merged': [{ number: 70, title: 't', body: 'Closes #69', mergedAt: '2026-10-17T10:00:00Z' }],
  }

  it('a squash into the candidate moves the issues it closes to In release', () => {
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69) })), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-In release/)
  })

  it('an issue already announced is still moved, so a second run finishes the first', () => {
    const comment = announceComment(config, { candidateBranch: 'candidate/4', candidatePr: 40 })
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69, { comments: [comment] }) })), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-In release/)
  })

  it('a comment that fails does not leave the board behind, and fails the run after it', () => {
    const board = fakeGh(items(item('i1')))
    assert.throws(() => record({ ...run(fakeGh({ ...record1 })), board }, merged), /issues without the announcement/)
    assert.deepStrictEqual(board.writes, [])
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

  it('the statuses come from the configuration', () => {
    const board = fakeGh(items(item('i1', { options: ['Todo', 'Shipping'] })))
    const custom = { ...config, status: { inRelease: 'Shipping', done: 'Done' } }
    record({ ...run(fakeGh({ ...record1, ...issue(69) }), custom), board }, merged)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Shipping/)
  })

  it('an issue closed already is not moved', () => {
    const board = fakeGh(items(item('i1')))
    record({ ...run(fakeGh({ ...record1, ...issue(69, { state: 'closed' }) })), board }, merged)
    assert.deepStrictEqual(board.writes, [])
  })

  it('the candidate merge moves the issues it closes to Done', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    closeCandidateIssues({ ...run(fakeGh({ ...issue(69) })), board }, candidate)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Done/)
  })

  it('an issue closed by hand while In release ends at Done', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board = fakeGh(items(item('i1', { current: 'In release' })))
    closeCandidateIssues({ ...run(fakeGh({ ...issue(69, { state: 'closed' }) })), board }, candidate)
    assert.match(board.writes.at(-1)?.args ?? '', /option=opt-Done/)
  })

  it('a board that fails is reported apart from the close', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const board: Gh = {
      read: () => {
        throw new Error('API rate limit exceeded')
      },
      write: () => '',
    }
    const gh = fakeGh({ ...issue(69) })
    const error = (() => {
      try {
        closeCandidateIssues({ ...run(gh), board }, candidate)
      } catch (error) {
        return error as Error
      }
      return null
    })()
    assert.match(error?.message ?? '', /issues not moved to "Done"/)
    assert.notMatch(error?.message ?? '', /not closed/)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })

  it('a board that cannot be moved does not stop the close', () => {
    const candidate = { ...pr, number: 40, baseRef: 'main', headRef: 'candidate/4', merged: true, body: 'Closes #69' }
    const gh = fakeGh({ ...issue(69) })
    closeCandidateIssues(run(gh), candidate)
    assert.deepStrictEqual(
      gh.writes.map((w) => w.args),
      ['issue close 69 --repo o/r --reason completed'],
    )
  })
})

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
    moreBlocking?: boolean
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
    { merged = [] as unknown[], refused = false, comments = [] as string[], noPrList = false } = {},
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
        if (line.includes('pr list')) {
          if (noPrList) throw new Error('gh: HTTP 502\nsecond line')
          return JSON.stringify(merged)
        }
        if (line.includes('/comments')) return comments.map((body) => JSON.stringify({ id: 1, body })).join('\n')
        const issue = of(args)
        if (line.includes('blocking(first')) {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  state: issue.state ?? 'CLOSED',
                  blocking: {
                    pageInfo: { hasNextPage: issue.moreBlocking === true },
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

  it('an answer of another shape fails the issue it is about, by name, not as a notice', () => {
    const shaped = (fake: ReturnType<typeof fakeBoard>, query: string): { gh: Gh; board: Gh } => ({
      ...fake,
      gh: {
        ...fake.gh,
        read: (args) => (args.join(' ').includes(query) ? '{"data":{}}' : fake.gh.read(args)),
      },
    })
    const issues = { 69: { blocking: [486] }, 486: { blockedBy: [{ number: 69, state: 'CLOSED' }] } }
    // Who waits on the closed issue.
    assert.throws(
      () => go(shaped(fakeBoard(issues, { merged }), 'blocking(first')),
      /#69: who waits on #69: an answer of another shape/,
    )
    // The waiting issue's own facts.
    const facts = fakeBoard(issues, { merged })
    const factsGh: Gh = {
      ...facts.gh,
      read: (args) =>
        args.join(' ').includes('number=486') && !args.join(' ').includes('projectItems')
          ? '{"data":{}}'
          : facts.gh.read(args),
    }
    assert.throws(() => go({ ...facts, gh: factsGh }), /#486: #486 on the board: an answer of another shape/)
  })

  it('an issue the merge unblocked moves, with the evidence on the candidate', () => {
    const fake = fakeBoard(
      { 69: { blocking: [486] }, 486: { blockedBy: [{ number: 69, state: 'CLOSED' }] } },
      { merged },
    )
    const report = go(fake)
    assert.deepStrictEqual(report?.moved, [{ number: 486, evidence: '#69 closed by #70' }])
    assert.deepStrictEqual(fake.writes, ['board item=I_486 option=b', 'pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /<!-- candidate:ready:candidate\/4 -->/)
    assert.match(fake.inputs[0], /Moved to Pronta:\n\n- #486: #69 closed by #70\./)
  })

  it('the merged pull requests are only evidence: when they cannot be read the move goes on', () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { noPrList: true })
    lines.length = 0
    const report = go(fake)
    assert.deepStrictEqual(report?.moved, [{ number: 486, evidence: '#69 closed by #40' }])
    assert.ok(
      lines.some((l) =>
        /^::notice title=Ready check evidence::.*candidate\/4.*#40: gh pr list failed: gh: HTTP 502$/.test(l),
      ),
      lines.join('\n'),
    )
  })

  it('an issue blocking more than one read holds is a notice, and alone writes no comment', () => {
    const fake = fakeBoard({ 69: { blocking: [], moreBlocking: true } }, { merged })
    lines.length = 0
    const report = go(fake)
    assert.deepStrictEqual(report, { moved: [], already: [], left: [] })
    assert.ok(
      lines.some((l) => l.startsWith('::notice title=Ready check partial::#69 blocks more issues')),
      lines.join('\n'),
    )
    assert.deepStrictEqual(fake.writes, [])
  })

  it('one still blocked stays, and the comment says by what', () => {
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
    assert.deepStrictEqual(report?.moved, [])
    assert.deepStrictEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /Left at Nuova:\n\n- #486: missing open blocker #5 \(#69 closed by #70\)\./)
  })

  it('one missing a field stays, and the comment names the field', () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: { size: false } }, { merged })
    go(fake)
    assert.deepStrictEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /- #486: missing Size \(#69 closed by #70\)\./)
  })

  it('one holding open sub-issues stays, and is said so', () => {
    const fake = fakeBoard({ 69: { blocking: [33] }, 33: { type: 'Feature', open: 2 } }, { merged })
    go(fake)
    assert.deepStrictEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.match(fake.inputs[0], /- #33: holds 2 open sub-issues/)
  })

  it('nothing waited: no comment', () => {
    const fake = fakeBoard({ 69: {} }, { merged })
    assert.deepStrictEqual(go(fake), { moved: [], already: [], left: [] })
    assert.deepStrictEqual(fake.writes, [])
  })

  it('a blocker still open unblocks nothing', () => {
    const fake = fakeBoard({ 69: { state: 'OPEN', blocking: [486] }, 486: {} }, { merged })
    go(fake)
    assert.deepStrictEqual(fake.writes, [])
  })

  it('an issue past the first status is left alone; one at Ready is reported, not moved', () => {
    const fake = fakeBoard(
      { 69: { blocking: [1, 2] }, 1: { status: 'In progress' }, 2: { status: 'Pronta' } },
      { merged },
    )
    const report = go(fake)
    assert.deepStrictEqual(report?.moved, [])
    assert.deepStrictEqual(report?.already, [{ number: 2, evidence: '#69 closed by #70' }])
    assert.deepStrictEqual(fake.writes, ['pr comment 40 --repo o/r --body-file -'])
    assert.notMatch(fake.inputs[0], /#1:/)
  })

  it('an issue on another Project only is left alone', () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: { project: 9 } }, { merged })
    assert.deepStrictEqual(go(fake), { moved: [], already: [], left: [] })
    assert.deepStrictEqual(fake.writes, [])
  })

  it("a blocker no merged pull request names is the candidate's own", () => {
    const fake = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged: [] })
    assert.deepStrictEqual(go(fake)?.moved, [{ number: 486, evidence: '#69 closed by #40' }])
  })

  it('a refused token and a missing status are notices, and the run stays green', () => {
    lines.length = 0
    const refused = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged, refused: true })
    assert.deepStrictEqual(go(refused), { moved: [], already: [], left: [] })
    assert.match(lines.join('\n'), /::notice title=Board not moved::#486 is not moved to "Pronta"/)
    lines.length = 0
    assert.ok(rules)
    const other = { ...withReady, ready: { ...rules, status: { ...rules.status, ready: 'Mancante' } } }
    go(fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged }), other)
    assert.match(lines.join('\n'), /"Mancante" is not an option of Stato \(Nuova, Pronta\)/)
  })

  it('no Projects token: a notice and nothing else', () => {
    lines.length = 0
    const { gh, writes } = fakeBoard({ 69: { blocking: [486] }, 486: {} }, { merged })
    assert.strictEqual(readyAfterMerge({ gh, repo: 'o/r', config: withReady, log: (l) => lines.push(l) }, merge), null)
    assert.match(lines.join('\n'), /no token with the Projects permission/)
    assert.deepStrictEqual(writes, [])
  })

  it('a project with no board or no blocked-by relation has no check', () => {
    const fake = fakeBoard({})
    assert.strictEqual(go(fake, config), null)
    assert.ok(rules)
    assert.strictEqual(go(fake, { ...config, ready: { ...rules, blockedBy: false } }), null)
    assert.deepStrictEqual(fake.writes, [])
  })

  it('a rerun does not write the comment twice', () => {
    const fake = fakeBoard(
      { 69: { blocking: [486] }, 486: { status: 'Pronta' } },
      {
        merged,
        comments: [`${readyMarker('candidate/4')}\nbefore`],
      },
    )
    go(fake)
    assert.deepStrictEqual(fake.writes, [])
  })

  it('an issue that cannot be read does not stop the others, and fails the run after the comment', () => {
    const fake = fakeBoard({ 69: { blocking: [1, 2] }, 2: {} }, { merged })
    assert.throws(() => go(fake), /#1: /)
    assert.deepStrictEqual(fake.writes, ['board item=I_2 option=b', 'pr comment 40 --repo o/r --body-file -'])
  })

  it("the candidate's merge closes its issues before it checks who waited on them", () => {
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
    assert.deepStrictEqual(order, ['close', 'check'])
  })
})
