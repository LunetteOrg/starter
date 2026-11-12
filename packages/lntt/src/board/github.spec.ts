import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import type { BoardState } from '../board.ts'
import { Gh } from '../gh/gh.ts'
import { applyStep } from './github.ts'

// GitHub's GraphQL API that records each request and answers the field query.
function recorder(answer?: (query: string, variables: Record<string, unknown>) => Record<string, unknown>) {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  const layer = Gh.memory({
    graphql: (query, variables) =>
      Effect.sync(() => {
        calls.push({ query, variables })
        if (answer) return answer(query, variables)
        if (query.includes('field(name:')) return { node: { field: { id: `F_${variables.name}` } } }
        if (query.includes('createProjectV2View')) return { createProjectV2View: { projectV2View: { id: 'V_new' } } }
        if (query.includes('updateProjectV2View')) return { updateProjectV2View: { projectV2View: { id: 'V_1' } } }
        throw new Error(`unexpected query: ${query}`)
      }),
  })
  return { calls, layer }
}

const live: BoardState = {
  projectId: 'PVT_1',
  url: 'https://github.com/orgs/DemoOrg/projects/1',
  owner: 'DemoOrg',
  ownerId: 'O_1',
  fields: [{ id: 'F_status', databaseId: 2, name: 'Status', dataType: 'SINGLE_SELECT', options: [] }],
  issueTypes: [],
  viewsComplete: true,
  views: [],
}

const visible = (call: { variables: Record<string, unknown> } | undefined) =>
  (call?.variables.input as { configuration?: { visibleFieldIds: string[] } } | undefined)?.configuration
    ?.visibleFieldIds

describe('applyStep: the writes of a view', () => {
  it.effect('a known field is written by the id read before the run, with no query', () => {
    const { calls, layer } = recorder()
    return Effect.gen(function* () {
      yield* applyStep(live, { kind: 'createView', name: 'A', layout: 'TABLE_LAYOUT', fields: ['Status'] })
      yield* applyStep(live, { kind: 'updateView', id: 'V_1', name: 'A', changes: [], input: { fields: ['Status'] } })
      assert.ok(!calls.some((c) => c.query.includes('field(name:')))
      assert.deepStrictEqual(
        calls.map((c) => (c.query.includes('createProjectV2View') ? 'create' : 'update')),
        ['create', 'update'],
      )
      for (const c of calls) assert.deepStrictEqual(visible(c), ['F_status'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('a field the run created is asked of the Project by name, on a create and on an update', () => {
    const { calls, layer } = recorder()
    return Effect.gen(function* () {
      yield* applyStep(live, { kind: 'createView', name: 'A', layout: 'TABLE_LAYOUT', fields: ['Status', 'Size'] })
      assert.strictEqual(calls.filter((c) => c.query.includes('field(name:')).length, 1)
      assert.deepStrictEqual(visible(calls.at(-1)), ['F_status', 'F_Size'])
      calls.length = 0
      yield* applyStep(live, { kind: 'updateView', id: 'V_1', name: 'A', changes: [], input: { fields: ['Size'] } })
      assert.strictEqual(calls.filter((c) => c.query.includes('field(name:')).length, 1)
      assert.deepStrictEqual(visible(calls.at(-1)), ['F_Size'])
    }).pipe(Effect.provide(layer))
  })

  it.effect('a Project that does not answer the field query: a BoardFailed that names the field', () => {
    const { layer } = recorder(() => ({ node: null }))
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyStep(live, { kind: 'createView', name: 'A', layout: 'TABLE_LAYOUT', fields: ['Size'] }),
      )
      assert.strictEqual(error._tag, 'BoardFailed')
      assert.match(error.message, /no field Size on the Project/)
    }).pipe(Effect.provide(layer))
  })

  it.effect('a blank filter on a new view takes no second write', () => {
    const { calls, layer } = recorder()
    return Effect.gen(function* () {
      yield* applyStep(live, { kind: 'createView', name: 'A', layout: 'TABLE_LAYOUT', filter: '  ' })
      assert.strictEqual(calls.length, 1, 'the create only')
    }).pipe(Effect.provide(layer))
  })

  it.effect('an issue type is created enabled, gray, on the organization, with its description', () => {
    const { calls, layer } = recorder(() => ({ createIssueType: { issueType: { id: 'T' } } }))
    return Effect.gen(function* () {
      yield* applyStep(live, { kind: 'createIssueType', name: 'Bug', description: 'Something broken' })
      assert.deepStrictEqual(calls[0]?.variables, {
        input: { ownerId: 'O_1', name: 'Bug', isEnabled: true, color: 'GRAY', description: 'Something broken' },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("a user's Project creates no issue type", () => {
    const { calls, layer } = recorder()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(applyStep({ ...live, ownerId: null }, { kind: 'createIssueType', name: 'Bug' }))
      assert.strictEqual(error.message, 'a Project owned by a user has no issue types')
      assert.strictEqual(calls.length, 0)
    }).pipe(Effect.provide(layer))
  })
})
