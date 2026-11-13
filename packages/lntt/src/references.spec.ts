import { assert, describe, it } from '@effect/vitest'
import { checkMissing, checkReferences } from './references.ts'

const STATUS = { name: 'Status', type: 'singleSelect', options: ['Todo', 'Ready', 'In progress', 'In review', 'Done'] }
const board = (over: Record<string, unknown> = {}) => ({ board: { fields: { status: STATUS }, ...over } })

describe('checkReferences', () => {
  it('a board whose names all hold: nothing to say', () => {
    assert.deepStrictEqual(checkReferences(board()), [])
    assert.deepStrictEqual(checkReferences({}), [])
  })

  it('each role of the status names one of its options, a role left unset by its default', () => {
    const wrong = checkReferences({
      board: { fields: { status: { ...STATUS, options: ['Todo', 'Done'], ready: 'Go' } } },
    })
    assert.deepStrictEqual(wrong, [
      'board.fields.status.ready is "Go", not one of: Todo, Done',
      'board.fields.status.inProgress is "In progress", not one of: Todo, Done',
      'board.fields.status.inReview is "In review", not one of: Todo, Done',
    ])
  })

  it("the candidate's statuses are the board's, checked only with a delivery.candidate", () => {
    const data = { ...board(), delivery: { candidate: { prefix: 'candidate/', status: { inRelease: 'Shipped' } } } }
    assert.deepStrictEqual(
      checkReferences(data).filter((line) => line.startsWith('delivery')),
      ['delivery.candidate.status.inRelease is "Shipped", not one of: Todo, Ready, In progress, In review, Done'],
    )
  })

  it('the horizon is a single select of the parents, the iteration an iteration of the children', () => {
    const wrong = checkReferences({
      board: {
        fields: {
          horizon: { name: 'Horizon', type: 'date', on: 'children' },
          iteration: { name: 'Iteration', type: 'iteration', on: 'parents' },
        },
      },
    })
    assert.deepStrictEqual(wrong, [
      'board.fields.horizon.type is "date", not one of: singleSelect',
      'board.fields.horizon.on is "children", not one of: parents',
      'board.fields.iteration.on is "parents", not one of: children',
    ])
  })

  it("a field's colors name its options", () => {
    const wrong = checkReferences({
      board: { fields: { size: { name: 'Size', type: 'singleSelect', options: ['S', 'L'], colors: { XL: 'RED' } } } },
    })
    assert.deepStrictEqual(wrong, ['board.fields.size.colors.XL names no option of the field: S, L'])
  })

  it('a view is named once, case aside, and only a board layout has columns', () => {
    const wrong = checkReferences({
      board: {
        github: {
          views: [
            { name: 'Board', layout: 'board' },
            { name: 'board', layout: 'board' },
            { name: 'T', layout: 'table', columns: 'Status' },
          ],
        },
      },
    })
    assert.deepStrictEqual(wrong, [
      'board.github.views names the view board twice',
      'board.github.views.T.columns is for a board layout, not table',
    ])
  })

  it('a permanent type is a parent, a stand-alone one a child, a description names a type of the board', () => {
    const wrong = checkReferences({
      board: {
        issueTypes: {
          parents: ['Feature'],
          children: ['Task'],
          permanent: ['Task'],
          standalone: ['Feature'],
          descriptions: { Ongoing: 'x' },
        },
      },
    })
    assert.deepStrictEqual(wrong, [
      'board.issueTypes.permanent is "Task", not one of: Feature',
      'board.issueTypes.standalone is "Feature", not one of: Task',
      'board.issueTypes.descriptions.Ongoing names no type of the board: Feature, Task',
    ])
  })

  it("a track's owner is a member of the team, and the targeted review's line one of the retrospective's", () => {
    const wrong = checkReferences({
      team: { members: { ada: {} } },
      board: { tracks: { labels: { ux: { owner: 'bob' } } } },
      delivery: { pullRequest: { retrospective: { lines: ['Friction'] } } },
      cycle: { retrospective: { targetedReview: { line: 'Unstable tests' } } },
    })
    assert.deepStrictEqual(wrong, [
      'board.tracks.labels.ux.owner is "bob", not one of: ada',
      'cycle.retrospective.targetedReview.line is "Unstable tests", not one of: Friction',
    ])
  })
})

describe('checkMissing', () => {
  it('a board with no horizon is said; no board, or one with a horizon, is not', () => {
    assert.strictEqual(checkMissing(board()).length, 1)
    assert.match(checkMissing(board())[0] as string, /^board\.fields\.horizon is missing/)
    assert.deepStrictEqual(checkMissing({}), [])
    const withHorizon = { board: { fields: { horizon: { name: 'Horizon', type: 'singleSelect' } } } }
    assert.deepStrictEqual(checkMissing(withHorizon), [])
  })
})
