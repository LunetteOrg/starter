import { assert, describe, it } from '@effect/vitest'
import { assess, holdsLine, type ReadyFacts, readIssueOnBoard, readWaiting, readyRules } from './board-ready.ts'

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
  it('the statuses and the criteria come from the configuration', () => {
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
    assert.deepStrictEqual(r?.status, { name: 'Stato', initial: 'Da fare', ready: 'Pronta' })
    assert.strictEqual(r?.priority?.name, 'Priorità')
  })

  it('the first status defaults to the first option, the ready one to Ready', () => {
    assert.deepStrictEqual(rules().status, { name: 'Status', initial: 'Todo', ready: 'Ready' })
  })

  it('a project with no board, another provider or no status has no check', () => {
    assert.strictEqual(readyRules({}), null)
    assert.strictEqual(readyRules({ board: { ...BOARD, provider: 'linear' } }), null)
    assert.strictEqual(readyRules({ board: { ...BOARD, fields: {} } }), null)
    assert.strictEqual(readyRules({ board: { ...BOARD, github: {} } }), null)
  })
})

describe('assess', () => {
  it('type, priority, size, parent and no open blocker: eligible', () => {
    assert.deepStrictEqual(assess(rules(), facts(), 'o/r'), { kind: 'eligible' })
  })

  it('each criterion that fails is named', () => {
    const missing = (over: Partial<ReadyFacts>) => assess(rules(), facts(over), 'o/r')
    assert.deepStrictEqual(missing({ type: null }), { kind: 'missing', missing: ['type'] })
    assert.deepStrictEqual(missing({ type: 'Chore' }), {
      kind: 'missing',
      missing: ['a type of board.issueTypes (not Chore)'],
    })
    assert.deepStrictEqual(missing({ fields: ['Size'] }), { kind: 'missing', missing: ['Priority'] })
    assert.deepStrictEqual(missing({ fields: ['Priority'] }), { kind: 'missing', missing: ['Size'] })
    assert.deepStrictEqual(missing({ parent: null }), { kind: 'missing', missing: ['parent'] })
    assert.deepStrictEqual(missing({ blockers: [{ number: 3, repo: 'o/r', open: true }] }), {
      kind: 'missing',
      missing: ['open blocker #3'],
    })
  })

  it('a closed blocker does not count, an open one of another repository does and is named in full', () => {
    assert.deepStrictEqual(
      assess(rules(), facts({ blockers: [{ number: 3, repo: 'o/r', open: false }] }), 'o/r').kind,
      'eligible',
    )
    assert.deepStrictEqual(assess(rules(), facts({ blockers: [{ number: 3, repo: 'o/x', open: true }] }), 'o/r'), {
      kind: 'missing',
      missing: ['open blocker o/x#3'],
    })
  })

  it('a blocker that cannot be read, or more than one read holds, is never eligible', () => {
    assert.deepStrictEqual(assess(rules(), facts({ blockers: [null] }), 'o/r'), {
      kind: 'missing',
      missing: ['a blocker this token cannot read'],
    })
    assert.deepStrictEqual(assess(rules(), facts({ moreBlockers: true }), 'o/r'), {
      kind: 'missing',
      missing: ['more blockers than one read holds'],
    })
  })

  it('a parent type needs no parent, and a stand-alone child type neither', () => {
    assert.strictEqual(assess(rules(), facts({ type: 'Feature', parent: null }), 'o/r').kind, 'eligible')
    assert.strictEqual(assess(rules(), facts({ type: 'Bug', parent: null }), 'o/r').kind, 'eligible')
  })

  it('a stand-alone type matches whatever its case, and with no standalone every child needs a parent', () => {
    assert.strictEqual(assess(rules(), facts({ type: 'BUG', parent: null }), 'o/r').kind, 'eligible')
    const every = readyRules({
      board: { ...BOARD, issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'] } },
    })
    assert.ok(every)
    assert.deepStrictEqual(assess(every, facts({ type: 'Bug', parent: null }), 'o/r'), {
      kind: 'missing',
      missing: ['parent'],
    })
  })

  it('an issue field past one read is named as such, a field on the item never is', () => {
    const onIssue = readyRules({
      board: { ...BOARD, fields: { ...BOARD.fields, priority: { ...BOARD.fields.priority, kind: 'issue' } } },
    })
    assert.ok(onIssue)
    assert.deepStrictEqual(assess(onIssue, facts({ fields: ['Size'], moreFields: true }), 'o/r'), {
      kind: 'missing',
      missing: ['Priority (more issue fields than one read holds)'],
    })
    assert.deepStrictEqual(assess(rules(), facts({ fields: ['Size'], moreFields: true }), 'o/r'), {
      kind: 'missing',
      missing: ['Priority'],
    })
  })

  it('with no sub-issues on the board, a child type needs no parent', () => {
    const r = readyRules({ board: { ...BOARD, subIssues: false } })
    assert.ok(r)
    assert.strictEqual(assess(r, facts({ parent: null }), 'o/r').kind, 'eligible')
  })

  it('what the configuration leaves out is not a criterion', () => {
    const bare = readyRules({
      board: {
        github: BOARD.github,
        fields: { status: BOARD.fields.status },
      },
    })
    assert.ok(bare)
    const none = facts({ type: null, parent: null, fields: [], blockers: [{ number: 3, repo: 'o/r', open: true }] })
    assert.deepStrictEqual(assess(bare, none, 'o/r'), { kind: 'eligible' })
  })

  it('an issue that holds open sub-issues is out of the check, a finished parent is in', () => {
    assert.deepStrictEqual(assess(rules(), facts({ type: 'Feature', openSubIssues: 3, fields: [] }), 'o/r'), {
      kind: 'holds',
      open: 3,
    })
    assert.strictEqual(holdsLine(3), 'holds 3 open sub-issues')
    assert.strictEqual(holdsLine(1), 'holds 1 open sub-issue')
    assert.strictEqual(
      assess(rules(), facts({ type: 'Feature', parent: null, openSubIssues: 0 }), 'o/r').kind,
      'eligible',
    )
  })
})

describe('the reads of one issue', () => {
  const waiting = (number: number, state: string, repo = 'o/r') => ({
    number,
    state,
    repository: { nameWithOwner: repo },
  })

  it('only the open issues of this repository wait on a closed one', () => {
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
    assert.deepStrictEqual(readWaiting(graphql, 'o/r', 9), { closed: true, blocked: [1], more: false })
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

  it("the item is the one on the configured Project: another owner's project with the same number is not it", () => {
    const found = onBoard([boardItem('other', 'SomeoneElse'), boardItem('ours', 'DemoOrg')])
    assert.strictEqual(found.target?.item, 'ours')
    assert.strictEqual(onBoard([boardItem('other', 'SomeoneElse')]).target, null)
  })

  it('an issue field past the read comes back as such, from the query that asks for it', () => {
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
    assert.strictEqual(found.facts.moreFields, true)
    assert.match(queries[0] ?? '', /issueFieldValues\(first:100\)\{ pageInfo\{ hasNextPage \}/)
  })

  it('an archived item is not on the board', () => {
    const found = onBoard([boardItem('old', 'DemoOrg', { isArchived: true })])
    assert.strictEqual(found.status, null)
    assert.strictEqual(found.target, null)
  })
})
