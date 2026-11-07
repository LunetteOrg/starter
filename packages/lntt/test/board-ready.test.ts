import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assess, holdsLine, type ReadyFacts, readIssueOnBoard, readWaiting, readyRules } from '../src/board-ready.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const BOARD = {
  github: { project: { owner: 'DemoOrg', number: 1, title: 'Demo' } },
  issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'], standalone: ['Bug'] },
  subIssues: true,
  blockedBy: true,
  fields: {
    status: { name: 'Status', type: 'singleSelect', options: ['Todo', 'Ready', 'Done'] },
    priority: { name: 'Priority', type: 'singleSelect', options: ['P0'] },
    size: { name: 'Size', type: 'singleSelect', options: ['S'] },
    horizon: { name: 'Horizon', type: 'singleSelect', options: ['Now'] },
  },
}

const rules = () => {
  const r = readyRules({ board: BOARD })
  assert.ok(r)
  return r
}

const facts = (over: Partial<ReadyFacts> = {}): ReadyFacts => ({
  number: 7,
  title: 'a task',
  type: 'Task',
  parent: 1,
  openSubIssues: 0,
  blockers: [],
  moreBlockers: false,
  moreFields: false,
  fields: ['Priority', 'Size'],
  ...over,
})

describe('readyRules', () => {
  test('the statuses and the criteria come from the configuration', () => {
    const r = readyRules({
      board: {
        ...BOARD,
        fields: {
          ...BOARD.fields,
          status: {
            name: 'Stato',
            type: 'singleSelect',
            options: ['Idee', 'Da fare', 'Pronta'],
            initial: 'Da fare',
            ready: 'Pronta',
          },
          priority: { name: 'Priorità', type: 'singleSelect', options: ['A'] },
        },
      },
    })
    assert.deepEqual(r?.status, { name: 'Stato', initial: 'Da fare', ready: 'Pronta' })
    assert.equal(r?.priority?.name, 'Priorità')
  })

  test('the first status defaults to the first option, the ready one to Ready', () => {
    assert.deepEqual(rules().status, { name: 'Status', initial: 'Todo', ready: 'Ready' })
  })

  test('a project with no board, another provider or no status has no check', () => {
    assert.equal(readyRules({}), null)
    assert.equal(readyRules({ board: { ...BOARD, provider: 'linear' } }), null)
    assert.equal(readyRules({ board: { ...BOARD, fields: {} } }), null)
    assert.equal(readyRules({ board: { ...BOARD, github: {} } }), null)
  })
})

describe('assess', () => {
  test('type, priority, size, parent and no open blocker: eligible', () => {
    assert.deepEqual(assess(rules(), facts(), 'o/r'), { kind: 'eligible' })
  })

  test('each criterion that fails is named', () => {
    const missing = (over: Partial<ReadyFacts>) => assess(rules(), facts(over), 'o/r')
    assert.deepEqual(missing({ type: null }), { kind: 'missing', missing: ['type'] })
    assert.deepEqual(missing({ type: 'Chore' }), {
      kind: 'missing',
      missing: ['a type of board.issueTypes (not Chore)'],
    })
    assert.deepEqual(missing({ fields: ['Size'] }), { kind: 'missing', missing: ['Priority'] })
    assert.deepEqual(missing({ fields: ['Priority'] }), { kind: 'missing', missing: ['Size'] })
    assert.deepEqual(missing({ parent: null }), { kind: 'missing', missing: ['parent'] })
    assert.deepEqual(missing({ blockers: [{ number: 3, repo: 'o/r', open: true }] }), {
      kind: 'missing',
      missing: ['open blocker #3'],
    })
  })

  test('a closed blocker does not count, an open one of another repository does and is named in full', () => {
    assert.deepEqual(
      assess(rules(), facts({ blockers: [{ number: 3, repo: 'o/r', open: false }] }), 'o/r').kind,
      'eligible',
    )
    assert.deepEqual(assess(rules(), facts({ blockers: [{ number: 3, repo: 'o/x', open: true }] }), 'o/r'), {
      kind: 'missing',
      missing: ['open blocker o/x#3'],
    })
  })

  test('a blocker that cannot be read, or more than one read holds, is never eligible', () => {
    assert.deepEqual(assess(rules(), facts({ blockers: [null] }), 'o/r'), {
      kind: 'missing',
      missing: ['a blocker this token cannot read'],
    })
    assert.deepEqual(assess(rules(), facts({ moreBlockers: true }), 'o/r'), {
      kind: 'missing',
      missing: ['more blockers than one read holds'],
    })
  })

  test('a parent type needs no parent, and a stand-alone child type neither', () => {
    assert.equal(assess(rules(), facts({ type: 'Feature', parent: null }), 'o/r').kind, 'eligible')
    assert.equal(assess(rules(), facts({ type: 'Bug', parent: null }), 'o/r').kind, 'eligible')
  })

  test('a stand-alone type matches whatever its case, and with no standalone every child needs a parent', () => {
    assert.equal(assess(rules(), facts({ type: 'BUG', parent: null }), 'o/r').kind, 'eligible')
    const every = readyRules({
      board: { ...BOARD, issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'] } },
    })
    assert.ok(every)
    assert.deepEqual(assess(every, facts({ type: 'Bug', parent: null }), 'o/r'), {
      kind: 'missing',
      missing: ['parent'],
    })
  })

  test('an issue field past one read is named as such, a field on the item never is', () => {
    const onIssue = readyRules({
      board: { ...BOARD, fields: { ...BOARD.fields, priority: { ...BOARD.fields.priority, kind: 'issue' } } },
    })
    assert.ok(onIssue)
    assert.deepEqual(assess(onIssue, facts({ fields: ['Size'], moreFields: true }), 'o/r'), {
      kind: 'missing',
      missing: ['Priority (more issue fields than one read holds)'],
    })
    assert.deepEqual(assess(rules(), facts({ fields: ['Size'], moreFields: true }), 'o/r'), {
      kind: 'missing',
      missing: ['Priority'],
    })
  })

  test('with no sub-issues on the board, a child type needs no parent', () => {
    const r = readyRules({ board: { ...BOARD, subIssues: false } })
    assert.ok(r)
    assert.equal(assess(r, facts({ parent: null }), 'o/r').kind, 'eligible')
  })

  test('what the configuration leaves out is not a criterion', () => {
    const bare = readyRules({
      board: {
        github: BOARD.github,
        fields: { status: BOARD.fields.status },
      },
    })
    assert.ok(bare)
    const none = facts({ type: null, parent: null, fields: [], blockers: [{ number: 3, repo: 'o/r', open: true }] })
    assert.deepEqual(assess(bare, none, 'o/r'), { kind: 'eligible' })
  })

  test('an issue that holds open sub-issues is out of the check, a finished parent is in', () => {
    assert.deepEqual(assess(rules(), facts({ type: 'Feature', openSubIssues: 3, fields: [] }), 'o/r'), {
      kind: 'holds',
      open: 3,
    })
    assert.equal(holdsLine(3), 'holds 3 open sub-issues')
    assert.equal(holdsLine(1), 'holds 1 open sub-issue')
    assert.equal(assess(rules(), facts({ type: 'Feature', parent: null, openSubIssues: 0 }), 'o/r').kind, 'eligible')
  })
})

describe('the reads of one issue', () => {
  const waiting = (number: number, state: string, repo = 'o/r') => ({
    number,
    state,
    repository: { nameWithOwner: repo },
  })

  test('only the open issues of this repository wait on a closed one', () => {
    const graphql = () => ({
      repository: {
        issue: {
          state: 'CLOSED',
          blocking: {
            pageInfo: { hasNextPage: false },
            nodes: [waiting(1, 'OPEN'), waiting(2, 'CLOSED'), waiting(3, 'OPEN', 'o/other'), null],
          },
        },
      },
    })
    assert.deepEqual(readWaiting(graphql, 'o/r', 9), { closed: true, blocked: [1], more: false })
  })

  const onBoard = (items: unknown[]) => {
    const issue = {
      number: 7,
      title: 'a task',
      state: 'OPEN',
      repository: { nameWithOwner: 'o/r' },
      issueType: { name: 'Task' },
      parent: { number: 1 },
    }
    const graphql = () => ({ repository: { issue } })
    const board = () => ({ repository: { issue: { projectItems: { nodes: items } } } })
    return readIssueOnBoard(graphql, board, rules(), 'o/r', 7)
  }
  const boardItem = (id: string, owner: string, over: Record<string, unknown> = {}) => ({
    id,
    isArchived: false,
    status: { name: 'Todo' },
    project: {
      id: `P_${id}`,
      number: 1,
      owner: { login: owner },
      field: { id: 'F', options: [{ id: 'o_ready', name: 'Ready' }] },
    },
    ...over,
  })

  test("the item is the one on the configured Project: another owner's project with the same number is not it", () => {
    const found = onBoard([boardItem('other', 'SomeoneElse'), boardItem('ours', 'DemoOrg')])
    assert.equal(found.target?.item, 'ours')
    assert.equal(onBoard([boardItem('other', 'SomeoneElse')]).target, null)
  })

  test('an issue field past the read comes back as such, from the query that asks for it', () => {
    const onIssue = readyRules({
      board: { ...BOARD, fields: { ...BOARD.fields, priority: { ...BOARD.fields.priority, kind: 'issue' } } },
    })
    assert.ok(onIssue)
    const queries: string[] = []
    const graphql = (query: string) => {
      queries.push(query)
      return {
        repository: {
          issue: {
            number: 7,
            title: 'a task',
            state: 'OPEN',
            repository: { nameWithOwner: 'o/r' },
            issueType: { name: 'Task' },
            parent: { number: 1 },
            issueFieldValues: { pageInfo: { hasNextPage: true }, nodes: [] },
          },
        },
      }
    }
    const board = () => ({ repository: { issue: { projectItems: { nodes: [boardItem('ours', 'DemoOrg')] } } } })
    const found = readIssueOnBoard(graphql, board, onIssue, 'o/r', 7)
    assert.equal(found.facts.moreFields, true)
    assert.match(queries[0] ?? '', /issueFieldValues\(first:100\)\{ pageInfo\{ hasNextPage \}/)
  })

  test('an archived item is not on the board', () => {
    const found = onBoard([boardItem('old', 'DemoOrg', { isArchived: true })])
    assert.equal(found.status, null)
    assert.equal(found.target, null)
  })
})

// A fake gh for `gh api graphql --input -` and `gh repo view`: the Project's items are in
// the JSON file $GH_STATE, served in pages of $GH_PAGE items, and the mutation changes an
// item's status there. Each write is logged in $GH_LOG.
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === 'repo') {
  if (process.env.GH_REPO_FAIL) { process.stderr.write('gh: no default repository\\n'); process.exit(1) }
  process.stdout.write('o/r\\n')
  process.exit(0)
}
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'))
const { query, variables: v } = JSON.parse(fs.readFileSync(0, 'utf8'))
const log = (line) => fs.appendFileSync(process.env.GH_LOG, line + '\\n')
if (query.includes('updateProjectV2ItemFieldValue')) {
  if (process.env.GH_FAIL && (process.env.GH_FAIL === '1' || process.env.GH_FAIL === v.item)) { process.stderr.write('gh: Resource not accessible\\n'); process.exit(1) }
  log('move ' + v.item + ' ' + v.option)
  if (!process.env.GH_NOOP) {
    const item = state.items.find((i) => i.id === v.item)
    item.status = { name: state.options.find((o) => o.id === v.option).name }
    fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state))
  }
  process.stdout.write(JSON.stringify({ data: {} }))
  process.exit(0)
}
const size = Number(process.env.GH_PAGE || 100)
const start = v.after ? Number(v.after) : 0
const end = start + size
const project = { id: 'PVT_1', field: { id: 'F_status', options: state.options }, items: {
  nodes: state.items.slice(start, end),
  pageInfo: { hasNextPage: end < state.items.length, endCursor: String(end) } } }
process.stdout.write(JSON.stringify({ data: { organization: { projectV2: project } } }))
`

const item = (id: string, status: string, number: number, over: Record<string, unknown> = {}) => ({
  id,
  isArchived: false,
  status: { name: status },
  f0: { __typename: 'ProjectV2ItemFieldSingleSelectValue' },
  f1: { __typename: 'ProjectV2ItemFieldSingleSelectValue' },
  ...over,
  content: {
    __typename: 'Issue',
    number,
    title: `issue ${number}`,
    state: 'OPEN',
    repository: { nameWithOwner: 'o/r' },
    issueType: { name: 'Task' },
    parent: { number: 1 },
    subIssuesSummary: { total: 0, completed: 0 },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
    ...(over.content as object),
  },
})

const STATE = {
  options: [
    { id: 'o_todo', name: 'Todo' },
    { id: 'o_ready', name: 'Ready' },
    { id: 'o_done', name: 'Done' },
  ],
  items: [
    item('I_10', 'Todo', 10),
    item('I_11', 'Todo', 11, {
      content: {
        blockedBy: {
          pageInfo: { hasNextPage: false },
          nodes: [{ number: 10, state: 'OPEN', repository: { nameWithOwner: 'o/r' } }],
        },
      },
    }),
    item('I_12', 'Todo', 12, { f1: null }),
    item('I_13', 'Todo', 13, {
      content: { issueType: { name: 'Feature' }, subIssuesSummary: { total: 3, completed: 1 } },
    }),
    // Not at the first status, in another repository, closed, archived, a pull request.
    item('I_14', 'Ready', 14),
    item('I_15', 'Todo', 15, { content: { repository: { nameWithOwner: 'o/other' } } }),
    item('I_16', 'Todo', 16, { content: { state: 'CLOSED' } }),
    item('I_17', 'Todo', 17, { isArchived: true }),
    { id: 'I_18', isArchived: false, status: { name: 'Todo' }, content: { __typename: 'PullRequest' } },
  ],
}

describe('lntt board ready', () => {
  let tmp: string
  let repo: string
  let stubs: string
  let gh: { state: string; log: string }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-ready-')))
    repo = join(tmp, 'repo')
    stubs = join(tmp, 'bin')
    mkdirSync(join(repo, '.agents'), { recursive: true })
    mkdirSync(stubs)
    execFileSync('git', ['init', '-q'], { cwd: repo })
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ board: BOARD }))
    writeFileSync(join(stubs, 'gh'), GH)
    chmodSync(join(stubs, 'gh'), 0o755)
    gh = { state: join(tmp, 'state.json'), log: join(tmp, 'gh.log') }
    writeFileSync(gh.state, JSON.stringify(STATE))
    writeFileSync(gh.log, '')
  })

  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function lntt(args: string[], env: Record<string, string> = {}) {
    const clean = { ...process.env }
    delete clean.GITHUB_REPOSITORY
    return spawnSync(process.execPath, [BIN, 'board', 'ready', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...clean, GH_STATE: gh.state, GH_LOG: gh.log, PATH: `${stubs}:${process.env.PATH}`, ...env },
    })
  }
  const writes = () => readFileSync(gh.log, 'utf8').trim().split('\n').filter(Boolean)
  const status = (id: string) =>
    (JSON.parse(readFileSync(gh.state, 'utf8')) as typeof STATE).items.find((i) => i.id === id)?.status?.name

  test('lists the issues at the first status, what is missing for the others, and writes nothing', () => {
    const r = lntt([])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /DemoOrg project 1 \(Demo\), o\/r, dry run/)
    assert.match(r.stdout, /Ready-eligible:\n {4}#10 issue 10\n/)
    assert.match(r.stdout, /#11 issue 11: missing open blocker #10/)
    assert.match(r.stdout, /#12 issue 12: missing Size/)
    assert.match(r.stdout, /#13 issue 13: holds 2 open sub-issues/)
    assert.doesNotMatch(r.stdout, /#1[4-8] /)
    assert.match(r.stdout, /--apply/)
    assert.deepEqual(writes(), [])
  })

  test('--apply moves only the eligible ones, to the option of the configuration', () => {
    const r = lntt(['--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(writes(), ['move I_10 o_ready'])
    assert.equal(status('I_10'), 'Ready')
    assert.equal(status('I_11'), 'Todo')
    assert.match(r.stdout, /moved 1 issue to Ready/)
  })

  test('every page of the Project is read', () => {
    const r = lntt([], { GH_PAGE: '2' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /#10 issue 10/)
    assert.match(r.stdout, /#13 issue 13/)
  })

  test('other status names work unchanged', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        board: {
          ...BOARD,
          fields: {
            ...BOARD.fields,
            status: { name: 'Stato', type: 'singleSelect', options: ['Nuova', 'Pronta'], ready: 'Pronta' },
          },
        },
      }),
    )
    const renamed = {
      options: [
        { id: 'o_new', name: 'Nuova' },
        { id: 'o_go', name: 'Pronta' },
      ],
      items: [item('I_20', 'Nuova', 20)],
    }
    writeFileSync(gh.state, JSON.stringify(renamed))
    const r = lntt(['--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(writes(), ['move I_20 o_go'])
  })

  test('a field of kind issue is read on the issue, not on the item', () => {
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        board: { ...BOARD, fields: { ...BOARD.fields, priority: { ...BOARD.fields.priority, kind: 'issue' } } },
      }),
    )
    const onItem = item('I_30', 'Todo', 30, {
      content: { issueFieldValues: { nodes: [{ field: { name: 'Other' } }] } },
    })
    const onIssue = item('I_31', 'Todo', 31, {
      content: { issueFieldValues: { nodes: [{ field: { name: 'Priority' } }] } },
    })
    writeFileSync(gh.state, JSON.stringify({ options: STATE.options, items: [onItem, onIssue] }))
    const r = lntt([])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /#30 issue 30: missing Priority/)
    assert.match(r.stdout, /Ready-eligible:\n {4}#31 issue 31\n/)
  })

  test('a ready status the Project does not have stops the run, naming its options', () => {
    writeFileSync(gh.state, JSON.stringify({ ...STATE, options: STATE.options.filter((o) => o.name !== 'Ready') }))
    const r = lntt(['--apply'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /"Ready" is not an option of Status \(Todo, Done\)/)
    assert.deepEqual(writes(), [])
  })

  test('a move that fails stops with its message', () => {
    const r = lntt(['--apply'], { GH_FAIL: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /#10.*Resource not accessible/)
  })

  test('a move that fails on the second eligible says how many moved before it', () => {
    writeFileSync(
      gh.state,
      JSON.stringify({ options: STATE.options, items: [item('I_40', 'Todo', 40), item('I_41', 'Todo', 41)] }),
    )
    const r = lntt(['--apply'], { GH_FAIL: 'I_41' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /#41.*Resource not accessible/)
    assert.match(r.stderr, /moved 1 before it/)
    assert.deepEqual(writes(), ['move I_40 o_ready'])
  })

  test('a configuration that does not validate, or a repository gh cannot name, stops with why', () => {
    const noRepo = lntt([], { GH_REPO_FAIL: '1' })
    assert.equal(noRepo.status, 1)
    assert.match(noRepo.stderr, /reading the repository: .*no default repository/)
    assert.match(noRepo.stderr, /gh repo set-default, or GITHUB_REPOSITORY/)
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ board: { nope: true } }))
    const bad = lntt([])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /nope/)
  })

  test('--apply reads the board back, and says what did not move', () => {
    const r = lntt(['--apply'], { GH_NOOP: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /still at Todo after --apply: #10/)
  })

  test('a project with no check says why, and --check is not an option of ready', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ board: { ...BOARD, fields: {} } }))
    const r = lntt([])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /board\.github\.project and board\.fields\.status/)
    assert.equal(lntt(['--check']).status, 2)
  })
})
