import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type BoardConfig, type BoardState, type Count, planBoard } from '../src/board.ts'

// A board as the configuration writes it, and a Project that already has part of it.
const board = {
  github: { project: { owner: 'DemoOrg', number: 1 } },
  issueTypes: {
    parents: ['Feature', 'Platform'],
    children: ['Task', 'Bug'],
    descriptions: { Platform: 'What the product runs on', Feature: 'For the people who use it' },
  },
  fields: {
    status: { name: 'Status', type: 'singleSelect', options: ['Todo', 'Ready', 'In progress', 'Done'] },
    horizon: { name: 'Horizon', type: 'singleSelect', options: ['Now', 'Next'], on: 'parents' },
    targetDate: { name: 'Target date', type: 'date' },
    startDate: { name: 'Start date', kind: 'issue', type: 'date' },
  },
}

const option = (id: string, name: string) => ({ id, name, color: 'GREEN', description: `${name}, described` })
const PROJECT = 'https://github.com/orgs/DemoOrg/projects/1'

function state(over: Partial<BoardState> = {}): BoardState {
  return {
    projectId: 'PVT_1',
    url: PROJECT,
    owner: 'DemoOrg',
    ownerId: 'O_1',
    fields: [
      { id: 'F_title', databaseId: 1, name: 'Title', dataType: 'TITLE' },
      {
        id: 'F_status',
        databaseId: 2,
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [option('s1', 'Todo'), option('s5', 'Ready'), option('s2', 'In progress'), option('s3', 'Done')],
      },
      {
        id: 'F_horizon',
        databaseId: 3,
        name: 'Horizon',
        dataType: 'SINGLE_SELECT',
        options: [option('h1', 'Now'), option('h2', 'Next')],
      },
      { id: 'F_target', databaseId: 4, name: 'Target date', dataType: 'DATE' },
    ],
    issueTypes: [
      { id: 'T_feature', name: 'Feature', description: 'For the people who use it' },
      { id: 'T_task', name: 'Task', description: null },
      { id: 'T_bug', name: 'Bug', description: null },
      { id: 'T_platform', name: 'Platform', description: 'What the product runs on' },
    ],
    ...over,
  }
}

const withFields = (fields: Record<string, unknown>): BoardConfig => ({ ...board, fields }) as BoardConfig
// How many items or issues a removal would touch: 7 for anything, unless told otherwise.
const count: Count = () => 7
const plan = (config: BoardConfig, live: BoardState) => planBoard(config, live, count)

describe('planBoard: what lntt board sync would change', () => {
  test('a Project and issue types as the board declares them: nothing to do', () => {
    assert.deepEqual(plan(board, state()), { steps: [], manual: [] })
  })

  test('a missing single select is created with its options in the configured order, and their colors', () => {
    const size = { name: 'Size', type: 'singleSelect', options: ['S', 'M', 'L'], colors: { S: 'GREEN', L: 'RED' } }
    const { steps } = plan(withFields({ ...board.fields, size }), state())
    assert.deepEqual(steps, [
      {
        kind: 'createField',
        key: 'size',
        name: 'Size',
        dataType: 'SINGLE_SELECT',
        options: [
          { name: 'S', color: 'GREEN', description: '' },
          { name: 'M', color: 'GRAY', description: '' },
          { name: 'L', color: 'RED', description: '' },
        ],
      },
    ])
  })

  test('a missing date, number or text field is created; a missing iteration is left to the UI', () => {
    const fields = {
      ...board.fields,
      estimate: { name: 'Estimate', type: 'number' },
      notes: { name: 'Notes', type: 'text' },
      startDate: { name: 'Begins', type: 'date' },
      iteration: { name: 'Iteration', type: 'iteration', on: 'children' },
    }
    const { steps, manual } = plan(withFields(fields), state())
    assert.deepEqual(
      steps.map((s) => s.kind === 'createField' && [s.name, s.dataType]),
      [
        ['Begins', 'DATE'],
        ['Estimate', 'NUMBER'],
        ['Notes', 'TEXT'],
      ],
    )
    assert.equal(manual.length, 1)
    assert.match(manual[0].what, /Iteration/)
    assert.match(manual[0].why, /iterations/)
    assert.equal(manual[0].url, `${PROJECT}/settings`)
    assert.ok(manual[0].steps.length > 0)
  })

  test('a field of kind issue belongs to the organization, not the Project: nothing is planned for it', () => {
    const { steps, manual } = plan(board, state())
    assert.ok(![...steps, ...manual].some((s) => JSON.stringify(s).includes('Start date')))
  })

  test('missing options are added, every existing option kept with its id, color and description', () => {
    const status = { ...board.fields.status, options: ['Todo', 'Ready', 'In progress', 'In review', 'Done'] }
    assert.deepEqual(plan(withFields({ ...board.fields, status }), state()).steps, [
      {
        kind: 'updateOptions',
        key: 'status',
        fieldId: 'F_status',
        name: 'Status',
        changes: ['add "In review"'],
        options: [
          option('s1', 'Todo'),
          option('s5', 'Ready'),
          option('s2', 'In progress'),
          { name: 'In review', color: 'GRAY', description: '' },
          option('s3', 'Done'),
        ],
      },
    ])
  })

  test('a color the configuration declares is set on the option, keeping its id; an undeclared one stays', () => {
    const horizon = { ...board.fields.horizon, colors: { Now: 'GREEN', Next: 'BLUE' } }
    const [step] = plan(withFields({ ...board.fields, horizon }), state()).steps
    assert.ok(step?.kind === 'updateOptions')
    assert.deepEqual(step.changes, ['color "Next" BLUE'])
    assert.deepEqual(step.options, [option('h1', 'Now'), { ...option('h2', 'Next'), color: 'BLUE' }])
  })

  test('an option that differs only in case is renamed through the API, keeping its id', () => {
    const live = state()
    live.fields[1].options = [
      option('s1', 'Todo'),
      option('s5', 'Ready'),
      option('s2', 'In Progress'),
      option('s3', 'Done'),
    ]
    const { steps, manual } = plan(board, live)
    assert.deepEqual(manual, [])
    assert.ok(steps[0]?.kind === 'updateOptions')
    assert.deepEqual(steps[0].changes, ['rename "In Progress" → "In progress"'])
    assert.deepEqual(steps[0].options[2], { ...option('s2', 'In Progress'), name: 'In progress' })
  })

  test('an option the configuration lacks is kept, and its removal left to the UI, with the items it holds', () => {
    const live = state()
    live.fields[1].options?.push(option('s4', 'Discussing'))
    const seen: unknown[] = []
    const { steps, manual } = planBoard(board, live, (what) => {
      seen.push(what)
      return 3
    })
    assert.deepEqual(steps, [], 'nothing to add: no update')
    assert.deepEqual(seen, [{ field: 'Status', option: 'Discussing' }])
    assert.equal(manual.length, 1)
    assert.match(manual[0].what, /Discussing/)
    assert.match(manual[0].why, /3 items have it/)
    assert.equal(manual[0].url, `${PROJECT}/settings/fields/2`)
    assert.ok(manual[0].steps.some((s) => /Status:"Discussing"/.test(s)))
  })

  test('an option kept by an update stays after the configured ones', () => {
    const live = state()
    live.fields[1].options?.push(option('s4', 'Discussing'))
    const status = { ...board.fields.status, options: ['Todo', 'Ready', 'In progress', 'In review', 'Done'] }
    const [step] = plan(withFields({ ...board.fields, status }), live).steps
    assert.ok(step?.kind === 'updateOptions')
    assert.equal((step.options.at(-1) as { id?: string }).id, 's4')
  })

  test('a field whose name differs only in case is renamed through the API, then its options compared', () => {
    const live = state()
    live.fields[2] = { ...live.fields[2], name: 'horizon' }
    const { steps, manual } = plan(board, live)
    assert.deepEqual(manual, [])
    assert.deepEqual(steps, [{ kind: 'renameField', fieldId: 'F_horizon', from: 'horizon', to: 'Horizon' }])
  })

  test('an iteration field on the Project, as the board declares it: nothing to do', () => {
    const live = state()
    live.fields.push({ id: 'F_it', databaseId: 5, name: 'Iteration', dataType: 'ITERATION' })
    const fields = { ...board.fields, iteration: { name: 'Iteration', type: 'iteration', on: 'children' } }
    assert.deepEqual(plan(withFields(fields), live), { steps: [], manual: [] })
  })

  test('a description that differs only by surrounding blanks is the same', () => {
    const live = state()
    live.issueTypes?.splice(3, 1, { id: 'T_platform', name: 'Platform', description: ' What the product runs on\n' })
    assert.deepEqual(plan(board, live).steps, [])
  })

  test('an exact name wins over one that differs only in case: no rename, the exact one kept', () => {
    const live = state()
    live.fields[2].options = [option('h0', 'now'), option('h1', 'Now'), option('h2', 'Next')]
    live.issueTypes?.push({ id: 'T_platform2', name: 'platform', description: null })
    const { steps, manual } = plan(board, live)
    assert.deepEqual(steps, [])
    assert.deepEqual(
      manual.map((m) => m.what),
      [
        'Horizon: the option "now" is not in board.fields.horizon',
        'the issue type platform is not in board.issueTypes',
      ],
    )
  })

  test('a configured description with surrounding blanks is the same as the trimmed one', () => {
    const blanks = {
      ...board,
      issueTypes: { ...board.issueTypes, descriptions: { Platform: 'What the product runs on\n' } },
    }
    assert.deepEqual(plan(blanks, state()).steps, [])
  })

  test('an option renamed by case and recolored is one entry of the update, with both changes', () => {
    const live = state()
    live.fields[2].options = [option('h1', 'now'), option('h2', 'Next')]
    const horizon = { ...board.fields.horizon, colors: { Now: 'BLUE' } }
    const [step] = plan(withFields({ ...board.fields, horizon }), live).steps
    assert.ok(step?.kind === 'updateOptions')
    assert.deepEqual(step.changes, ['rename "now" → "Now"', 'color "Now" BLUE'])
    assert.deepEqual(step.options[0], { ...option('h1', 'now'), name: 'Now', color: 'BLUE' })
  })

  test('a field of another type on the Project is left to the UI: the API never changes a type', () => {
    const live = state()
    live.fields[2] = { id: 'F_horizon', databaseId: 3, name: 'Horizon', dataType: 'TEXT' }
    const { steps, manual } = plan(board, live)
    assert.deepEqual(steps, [])
    assert.match(manual[0].what, /Horizon/)
    assert.match(manual[0].why, /type/)
    assert.equal(manual[0].url, `${PROJECT}/settings/fields/3`)
  })

  test('a missing issue type is created with its description; one with another description is described', () => {
    const live = state({
      issueTypes: [
        { id: 'T_feature', name: 'Feature', description: 'A request, idea, or new functionality' },
        { id: 'T_task', name: 'Task', description: null },
        { id: 'T_bug', name: 'Bug', description: null },
      ],
    })
    assert.deepEqual(plan(board, live).steps, [
      { kind: 'createIssueType', name: 'Platform', description: 'What the product runs on' },
      { kind: 'describeIssueType', id: 'T_feature', name: 'Feature', description: 'For the people who use it' },
    ])
  })

  test('an issue type that differs only in case is renamed through the API', () => {
    const live = state()
    live.issueTypes?.splice(0, 1, { id: 'T_feature', name: 'feature', description: 'For the people who use it' })
    assert.deepEqual(plan(board, live), {
      steps: [{ kind: 'renameIssueType', id: 'T_feature', from: 'feature', to: 'Feature' }],
      manual: [],
    })
  })

  test('an issue type the board does not list is left to the organization settings, with the issues it holds', () => {
    const live = state()
    live.issueTypes?.push({ id: 'T_debt', name: 'Debt', description: null })
    const { steps, manual } = planBoard(board, live, (what) => ('type' in what && what.type === 'Debt' ? 12 : 0))
    assert.deepEqual(steps, [])
    assert.match(manual[0].what, /Debt/)
    assert.match(manual[0].why, /12 issues have it/)
    assert.equal(manual[0].url, 'https://github.com/organizations/DemoOrg/settings/issue-types')
  })

  test('a Project owned by a user has no issue types: a board that lists them is left to the person', () => {
    const { steps, manual } = plan(board, state({ ownerId: null, issueTypes: null }))
    assert.deepEqual(steps, [])
    assert.match(manual[0].why, /user/)
  })

  test('no issueTypes in the board: the organization types are not read into the plan', () => {
    const { issueTypes: _, ...noTypes } = board
    const live = state()
    live.issueTypes?.push({ id: 'T_debt', name: 'Debt', description: null })
    assert.deepEqual(plan(noTypes, live), { steps: [], manual: [] })
  })
})
