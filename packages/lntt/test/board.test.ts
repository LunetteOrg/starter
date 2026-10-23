import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type BoardConfig, type BoardState, planBoard } from '../src/board.ts'

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

function state(over: Partial<BoardState> = {}): BoardState {
  return {
    projectId: 'PVT_1',
    ownerId: 'O_1',
    fields: [
      { id: 'F_title', name: 'Title', dataType: 'TITLE' },
      {
        id: 'F_status',
        name: 'Status',
        dataType: 'SINGLE_SELECT',
        options: [option('s1', 'Todo'), option('s5', 'Ready'), option('s2', 'In progress'), option('s3', 'Done')],
      },
      {
        id: 'F_horizon',
        name: 'Horizon',
        dataType: 'SINGLE_SELECT',
        options: [option('h1', 'Now'), option('h2', 'Next')],
      },
      { id: 'F_target', name: 'Target date', dataType: 'DATE' },
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

describe('planBoard: what lntt board sync would change', () => {
  test('a Project and issue types as the board declares them: nothing to do', () => {
    assert.deepEqual(planBoard(board, state()), { steps: [], manual: [] })
  })

  test('a missing single select is created with its options, in the order of the configuration', () => {
    const size = { name: 'Size', type: 'singleSelect', options: ['S', 'M', 'L'] }
    const { steps } = planBoard(withFields({ ...board.fields, size }), state())
    assert.deepEqual(steps, [
      { kind: 'createField', key: 'size', name: 'Size', dataType: 'SINGLE_SELECT', options: ['S', 'M', 'L'] },
    ])
  })

  test('a missing date, number or text field is created; an iteration is left to the UI, with why', () => {
    const fields = {
      ...board.fields,
      estimate: { name: 'Estimate', type: 'number' },
      notes: { name: 'Notes', type: 'text' },
      startDate: { name: 'Begins', type: 'date' },
      iteration: { name: 'Iteration', type: 'iteration', on: 'children' },
    }
    const { steps, manual } = planBoard(withFields(fields), state())
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
  })

  test('a field of kind issue belongs to the organization, not the Project: nothing is planned for it', () => {
    const { steps, manual } = planBoard(board, state())
    assert.ok(![...steps, ...manual].some((s) => JSON.stringify(s).includes('Start date')))
  })

  test('missing options are added, every existing option kept with its id, color and description', () => {
    const status = { ...board.fields.status, options: ['Todo', 'Ready', 'In progress', 'In review', 'Done'] }
    const plan = planBoard(withFields({ ...board.fields, status }), state())
    assert.deepEqual(plan.steps, [
      {
        kind: 'addOptions',
        key: 'status',
        fieldId: 'F_status',
        name: 'Status',
        add: ['In review'],
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

  test('an option the configuration lacks is kept, after the configured ones, and left to the UI', () => {
    const live = state()
    live.fields[1].options?.push(option('s4', 'Discussing'))
    assert.deepEqual(planBoard(board, live).steps, [], 'nothing to add: no update')
    const status = { ...board.fields.status, options: ['Todo', 'Ready', 'In progress', 'In review', 'Done'] }
    const { steps, manual } = planBoard(withFields({ ...board.fields, status }), live)
    const add = steps[0]
    assert.ok(add?.kind === 'addOptions')
    assert.equal((add.options.at(-1) as { id?: string }).id, 's4')
    assert.match(manual.map((m) => `${m.what} ${m.why}`).join('\n'), /Discussing[^\n]*every item/)
  })

  test('an option that differs only in case is a rename, left to the UI, and not added', () => {
    const live = state()
    live.fields[1].options = [
      option('s1', 'Todo'),
      option('s5', 'Ready'),
      option('s2', 'In Progress'),
      option('s3', 'Done'),
    ]
    const { steps, manual } = planBoard(board, live)
    assert.deepEqual(steps, [])
    assert.equal(manual.length, 1)
    assert.match(manual[0].what, /"In Progress" → "In progress"/)
  })

  test('a field whose name differs only in case is a rename, left to the UI', () => {
    const live = state()
    live.fields[2] = { ...live.fields[2], name: 'horizon' }
    const { steps, manual } = planBoard(board, live)
    assert.deepEqual(steps, [])
    assert.match(manual[0].what, /rename the field "horizon" → "Horizon"/)
  })

  test('an iteration field on the Project, as the board declares it: nothing to do', () => {
    const live = state()
    live.fields.push({ id: 'F_it', name: 'Iteration', dataType: 'ITERATION' })
    const fields = { ...board.fields, iteration: { name: 'Iteration', type: 'iteration', on: 'children' } }
    assert.deepEqual(planBoard(withFields(fields), live), { steps: [], manual: [] })
  })

  test('a description that differs only by surrounding blanks is the same', () => {
    const live = state()
    live.issueTypes?.splice(3, 1, { id: 'T_platform', name: 'Platform', description: ' What the product runs on\n' })
    assert.deepEqual(planBoard(board, live).steps, [])
  })

  test('a field of another type on the Project is left to the UI: a field never changes type', () => {
    const live = state()
    live.fields[2] = { id: 'F_horizon', name: 'Horizon', dataType: 'TEXT' }
    const { steps, manual } = planBoard(board, live)
    assert.deepEqual(steps, [])
    assert.match(manual[0].what, /Horizon/)
    assert.match(manual[0].why, /type/)
  })

  test('a missing issue type is created with its description; one with another description is described', () => {
    const live = state({
      issueTypes: [
        { id: 'T_feature', name: 'Feature', description: 'A request, idea, or new functionality' },
        { id: 'T_task', name: 'Task', description: null },
        { id: 'T_bug', name: 'Bug', description: null },
      ],
    })
    assert.deepEqual(planBoard(board, live).steps, [
      { kind: 'createIssueType', name: 'Platform', description: 'What the product runs on' },
      { kind: 'describeIssueType', id: 'T_feature', name: 'Feature', description: 'For the people who use it' },
    ])
  })

  test('an issue type the board does not list, or that differs only in case, is left to the organization settings', () => {
    const live = state()
    live.issueTypes?.push({ id: 'T_debt', name: 'Debt', description: null })
    live.issueTypes?.splice(0, 1, { id: 'T_feature', name: 'feature', description: 'For the people who use it' })
    const { steps, manual } = planBoard(board, live)
    assert.deepEqual(steps, [])
    const text = manual.map((m) => m.what).join('\n')
    assert.match(text, /"feature" → "Feature"/)
    assert.match(text, /Debt/)
  })

  test('a Project owned by a user has no issue types: a board that lists them is left to the person', () => {
    const { steps, manual } = planBoard(board, state({ ownerId: null, issueTypes: null }))
    assert.deepEqual(steps, [])
    assert.match(manual[0].why, /user/)
  })

  test('no issueTypes in the board: the organization types are not read into the plan', () => {
    const { issueTypes: _, ...noTypes } = board
    const live = state()
    live.issueTypes?.push({ id: 'T_debt', name: 'Debt', description: null })
    assert.deepEqual(planBoard(noTypes, live), { steps: [], manual: [] })
  })
})
