import { assert, describe, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import * as TestConsole from 'effect/testing/TestConsole'
import { ConfigInvalid, ProjectConfig } from '../config/load.ts'
import { Gh, GhError } from '../gh/gh.ts'
import { type BoardCommand, command } from './command.ts'

// GitHub's GraphQL API in memory, for lntt board: the Project and the organization's issue types
// live in `state`, the read query answers from it, and the mutations lntt board sends change it
// as GitHub would (a new option without an id gets a new one, a name or a color given replaces the
// old). The items of the Project are state.items ({ Status: "Archived" }), the issues of each type
// state.typeCounts. Each call is logged: "read", "items", "search", "field", or the mutation's
// name, and each mutation's time on the Clock.

// biome-ignore lint/suspicious/noExplicitAny: the state GitHub holds, as untyped as the JSON the API answers
type Json = Record<string, any>

const CONFIG = {
  board: {
    github: { project: { owner: 'DemoOrg', ownerType: 'organization', number: 1, title: 'Demo' } },
    issueTypes: { parents: ['Feature', 'Debt'], children: ['Task'], descriptions: { Debt: 'A debt to pay back' } },
    fields: {
      status: { name: 'Status', type: 'singleSelect', options: ['Todo', 'Ready', 'Done'] },
      horizon: {
        name: 'Horizon',
        type: 'singleSelect',
        options: ['Now', 'Next'],
        on: 'parents',
        colors: { Now: 'GREEN', Next: 'BLUE' },
      },
    },
  },
}

const LIVE = {
  fields: [
    {
      id: 'F_status',
      databaseId: 21,
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: [
        { id: 's1', name: 'Todo', color: 'GREEN', description: 'Not started' },
        { id: 's3', name: 'Done', color: 'PURPLE', description: 'Completed' },
        { id: 's9', name: 'Archived', color: 'GRAY', description: '' },
      ],
    },
  ],
  issueTypes: [
    { id: 'T_feature', name: 'Feature', description: null },
    { id: 'T_task', name: 'task', description: null },
    { id: 'T_chore', name: 'Chore', description: null },
  ],
  items: [{ Status: 'Archived' }, { Status: 'Todo' }, { Status: 'Archived' }],
  views: [] as Json[],
  typeCounts: { Chore: 4 } as Record<string, number>,
}

// How GitHub misbehaves: a mutation it refuses (fail) or answers without doing (noop), more pages
// than one read holds, items in two pages, an organization that does not resolve.
interface Quirks {
  fail?: string
  noop?: string
  more?: boolean
  moreTypes?: boolean
  moreViews?: boolean
  pages?: boolean
  noOrg?: boolean
}

// The project's configuration, read from the test's state when the command asks for it;
// `refused`: what a configuration that does not validate says.
const configOf = (state: { config: Json; refused: string | null }) =>
  Layer.succeed(ProjectConfig)(
    ProjectConfig.of({
      data: Effect.suspend(() =>
        state.refused === null
          ? Effect.succeed(state.config)
          : Effect.fail(new ConfigInvalid({ message: state.refused })),
      ),
    }),
  )

const MUTATION =
  /(createProjectV2Field|updateProjectV2Field|createIssueType|updateIssueType|createProjectV2View|updateProjectV2View)/

function github(live: Json = structuredClone(LIVE)) {
  // `refused`: what the loader throws, for a configuration that does not validate.
  const state = { live, config: structuredClone(CONFIG) as Json, quirks: {} as Quirks, refused: null as string | null }
  const calls: string[] = []
  const times: number[] = []
  let n = 1000
  const id = (p: string) => `${p}_${++n}`
  const withIds = (options: Json[]) =>
    options.map((o) => ({ id: o.id || id('o'), name: o.name, color: o.color, description: o.description }))
  const fieldName = (f: string) => state.live.fields.find((x: Json) => x.id === f).name

  const graphql = (query: string, v: Json) =>
    Effect.gen(function* () {
      const s = state.live
      const q = state.quirks
      const name = MUTATION.exec(query)?.[1]
      if (name && q.fail === name) {
        return yield* new GhError({ args: ['api', 'graphql'], output: 'gh: Resource not accessible by integration' })
      }
      const kind =
        name ??
        (query.includes('items(')
          ? 'items'
          : query.includes('search(')
            ? 'search'
            : query.includes('field(name:')
              ? 'field'
              : 'read')
      calls.push(kind)
      if (name) times.push(yield* Clock.currentTimeMillis)
      if (!name && q.noOrg && query.includes('organization(')) {
        return yield* new GhError({
          args: ['api', 'graphql'],
          output: "gh: Could not resolve to an Organization with the login of 'DemoOrg'.",
        })
      }
      if (name && name === q.noop) return { [name]: {} }
      const page = { hasNextPage: !!q.more }
      if (kind === 'field') {
        const f = s.fields.find((x: Json) => x.name === v.name)
        return { node: { field: f ? { id: f.id } : null } }
      }
      if (kind === 'items') {
        const all = (s.items ?? []).map((values: Json) => ({ v: values[v.field] ? { name: values[v.field] } : null }))
        const half = q.pages ? Math.ceil(all.length / 2) : all.length
        const nodes = v.after === 'p2' ? all.slice(half) : all.slice(0, half)
        const more = !!q.pages && v.after !== 'p2'
        return { node: { items: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'p2' : null } } } }
      }
      if (kind === 'search') {
        const type = (/type:"([^"]+)"/.exec(v.q) as RegExpExecArray)[1] as string
        return { search: { issueCount: s.typeCounts?.[type] ?? 0 } }
      }
      if (!name && query.includes('user(')) {
        return {
          user: {
            id: 'U_1',
            projectV2: {
              id: 'PVT_1',
              url: 'https://github.com/users/someone/projects/1',
              fields: { nodes: s.fields, pageInfo: page },
              views: { nodes: s.views, pageInfo: { hasNextPage: false } },
            },
          },
        }
      }
      if (!name) {
        return {
          organization: {
            id: 'O_1',
            projectV2: {
              id: 'PVT_1',
              url: 'https://github.com/orgs/DemoOrg/projects/1',
              fields: { nodes: s.fields, pageInfo: page },
              views: { nodes: s.views, pageInfo: { hasNextPage: !!q.moreViews } },
            },
            issueTypes: { nodes: s.issueTypes, pageInfo: { hasNextPage: !!q.moreTypes } },
          },
        }
      }
      const input = v.input as Json
      if (name === 'createProjectV2View') {
        const view = {
          id: id('V'),
          number: s.views.length + 1,
          name: input.name,
          layout: input.layout,
          filter: '',
          fields: { nodes: (input.configuration?.visibleFieldIds ?? []).map((f: string) => ({ name: fieldName(f) })) },
          groupByFields: { nodes: [] },
          verticalGroupByFields: { nodes: [] },
          configured: !!input.configuration,
        }
        s.views.push(view)
        return { createProjectV2View: { projectV2View: { id: view.id } } }
      }
      if (name === 'updateProjectV2View') {
        const view = s.views.find((x: Json) => x.id === input.viewId)
        for (const k of ['name', 'layout', 'filter']) if (input[k] !== undefined) view[k] = input[k]
        if (input.configuration) {
          view.fields = { nodes: input.configuration.visibleFieldIds.map((f: string) => ({ name: fieldName(f) })) }
        }
        return { updateProjectV2View: { projectV2View: { id: view.id } } }
      }
      if (name === 'createProjectV2Field') {
        const f: Json = { id: id('F'), name: input.name, dataType: input.dataType }
        if (input.singleSelectOptions) f.options = withIds(input.singleSelectOptions)
        s.fields.push(f)
        return { createProjectV2Field: { projectV2Field: { id: f.id } } }
      }
      if (name === 'updateProjectV2Field') {
        const f = s.fields.find((x: Json) => x.id === input.fieldId)
        if (input.name) f.name = input.name
        if (input.singleSelectOptions) f.options = withIds(input.singleSelectOptions)
        return { updateProjectV2Field: { projectV2Field: { id: f.id } } }
      }
      if (name === 'createIssueType') {
        s.issueTypes.push({ id: id('T'), name: input.name, description: input.description ?? null })
        return { createIssueType: { issueType: { id: 'T' } } }
      }
      const t = s.issueTypes.find((x: Json) => x.id === input.issueTypeId)
      if (input.name) t.name = input.name
      if (input.description) t.description = input.description
      return { updateIssueType: { issueType: { id: t.id } } }
    })

  // One run of `lntt board sync`: its exit code, stdout and stderr. The clock is moved past every
  // pause between writes.
  const lntt = (mode: 'dry run' | 'apply' | 'check' = 'dry run', quirks: Quirks = {}) =>
    run({ kind: 'sync', mode }, quirks)
  const run = (parsed: BoardCommand, quirks: Quirks = {}) =>
    Effect.gen(function* () {
      state.quirks = quirks
      const fiber = yield* Effect.forkChild(command(parsed))
      yield* TestClock.adjust('1 hour')
      const code = yield* Fiber.join(fiber)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code, out: `${out}\n`, err }
    }).pipe(Effect.provide(Layer.mergeAll(Gh.memory({ graphql }), configOf(state), Layer.fresh(TestConsole.layer))))
  // The reads and writes, without the counts of what a removal would touch.
  const io = () => calls.filter((c) => c !== 'items' && c !== 'search')
  const clear = () => {
    calls.length = 0
    times.length = 0
  }
  const withViews = (views: Json[], live?: Json[]) => {
    state.config.board.github.views = views
    if (live) state.live.views = live
  }
  return { state, calls, times, io, clear, lntt, run, withViews }
}

const liveView = (over: Json = {}) => ({
  id: 'V_old',
  number: 7,
  name: 'Old',
  layout: 'TABLE_LAYOUT',
  filter: '',
  fields: { nodes: [{ name: 'Status' }] },
  groupByFields: { nodes: [] },
  verticalGroupByFields: { nodes: [] },
  ...over,
})

describe('lntt board sync', () => {
  it.effect('a dry run by default: prints the plan, writes nothing, and says how to apply it', () =>
    Effect.gen(function* () {
      const g = github()
      const r = yield* g.lntt()
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(g.io(), ['read'])
      assert.match(r.out, /DemoOrg project 1 \(Demo\), dry run/)
      assert.match(r.out, /update options of Status: add "Ready"/)
      assert.match(r.out, /create field Horizon \(single select\): Now GREEN, Next BLUE/)
      assert.match(r.out, /rename issue type "task" → "Task"/)
      assert.match(r.out, /create issue type Debt: A debt to pay back/)
      assert.match(r.out, /by hand, in GitHub's UI:\n {2}.*Archived/)
      assert.match(r.out, /--apply/)
    }),
  )

  it.effect('--apply makes the changes, keeps the ids of the existing options, and reads the board back', () =>
    Effect.gen(function* () {
      const g = github()
      const r = yield* g.lntt('apply')
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(g.io(), [
        'read',
        'updateProjectV2Field',
        'createProjectV2Field',
        'createIssueType',
        'updateIssueType',
        'read',
      ])
      const after = g.state.live
      const status = after.fields.find((f: Json) => f.name === 'Status')
      assert.deepStrictEqual(
        status.options.map((o: Json) => [o.id.startsWith('o_') ? 'new' : o.id, o.name, o.color]),
        [
          ['s1', 'Todo', 'GREEN'],
          ['new', 'Ready', 'GRAY'],
          ['s3', 'Done', 'PURPLE'],
          ['s9', 'Archived', 'GRAY'],
        ],
      )
      assert.deepStrictEqual(
        after.fields.find((f: Json) => f.name === 'Horizon').options.map((o: Json) => [o.name, o.color]),
        [
          ['Now', 'GREEN'],
          ['Next', 'BLUE'],
        ],
      )
      assert.ok(after.issueTypes.some((t: Json) => t.name === 'Debt' && t.description === 'A debt to pay back'))
      assert.ok(
        after.issueTypes.some((t: Json) => t.id === 'T_task' && t.name === 'Task'),
        'renamed, same id',
      )
      assert.match(r.out, /applied 4 changes/)
      assert.match(r.out, /Archived/, 'what is left to the UI is still listed')
    }),
  )

  it.effect('idempotent: once applied, a second run has nothing to change and writes nothing', () =>
    Effect.gen(function* () {
      const g = github()
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      g.clear()
      const r = yield* g.lntt('apply')
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(g.io(), ['read', 'read'])
      assert.match(r.out, /nothing to change/)
    }),
  )

  it.effect(
    'a write gh refuses stops the run, exit 1, with what was applied before it and what is left to the UI',
    () =>
      Effect.gen(function* () {
        const r = yield* github().lntt('apply', { fail: 'createIssueType' })
        assert.strictEqual(r.code, 1)
        assert.match(r.err, /create issue type Debt.*Resource not accessible/s)
        assert.match(r.err, /applied 2 changes before it/)
        assert.match(r.out, /Archived/)
      }),
  )

  it.effect('the writes are 1.2 s apart: the secondary rate limit drops faster ones', () =>
    Effect.gen(function* () {
      const g = github()
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      assert.strictEqual(g.times.length, 4)
      for (let i = 1; i < g.times.length; i++)
        assert.strictEqual((g.times[i] as number) - (g.times[i - 1] as number), 1200)
    }),
  )

  it.effect('a change that does not show on the read-back: exit 1, naming it', () =>
    Effect.gen(function* () {
      const r = yield* github().lntt('apply', { noop: 'createIssueType' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /still differs after --apply:\n {2}create issue type Debt/)
    }),
  )

  it.effect("a user's Project: no issue types are read, and the board's are left to the person", () =>
    Effect.gen(function* () {
      const g = github()
      Object.assign(g.state.config.board.github.project, { owner: 'someone', ownerType: 'user' })
      const r = yield* g.lntt()
      assert.strictEqual(r.code, 0, r.err)
      assert.notMatch(r.out, /create issue type/)
      assert.match(r.out, /owned by a user/)
    }),
  )

  it.effect('an organization that does not resolve: the error says ownerType defaults to organization', () =>
    Effect.gen(function* () {
      const r = yield* github().lntt('dry run', { noOrg: true })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /^lntt board sync: reading the board: .*Could not resolve to an Organization/)
      assert.match(r.err, /board\.github\.project\.ownerType.*organization/)
    }),
  )

  it.effect('a Project with more fields, or an organization with more issue types, than one page: stop', () =>
    Effect.gen(function* () {
      const g = github()
      const fields = yield* g.lntt('apply', { more: true })
      assert.strictEqual(fields.code, 1)
      assert.match(fields.err, /more than 100 fields/)
      assert.deepStrictEqual(g.calls, ['read'])
      const types = yield* github().lntt('apply', { moreTypes: true })
      assert.strictEqual(types.code, 1)
      assert.match(types.err, /more than 50 issue types/)
    }),
  )

  it.effect('the items an option holds are counted across every page of the Project', () =>
    Effect.gen(function* () {
      const g = github()
      const r = yield* g.lntt('dry run', { pages: true })
      assert.strictEqual(g.calls.filter((c) => c === 'items').length, 2)
      assert.match(r.out, /"Archived"[^\n]*2 items have it/)
    }),
  )

  it.effect('what is left to the UI says why, how many items or issues it touches, where to go and what to do', () =>
    Effect.gen(function* () {
      const r = yield* github().lntt()
      assert.match(r.out, /Status: the option "Archived"[^\n]*2 items have it/)
      assert.match(r.out, /https:\/\/github\.com\/orgs\/DemoOrg\/projects\/1\/settings\/fields\/21/)
      assert.match(r.out, /Status:"Archived"/)
      assert.match(r.out, /the issue type Chore[^\n]*4 issues have it/)
      assert.match(r.out, /https:\/\/github\.com\/organizations\/DemoOrg\/settings\/issue-types/)
    }),
  )

  it.effect('--check: exit 1 when the board differs, a removal left to the UI included, and nothing is written', () =>
    Effect.gen(function* () {
      const g = github()
      const r = yield* g.lntt('check')
      assert.strictEqual(r.code, 1)
      assert.match(r.out, /create field Horizon/)
      assert.match(r.err, /the board differs from the configuration: 4 changes, 2 by hand/)
      assert.deepStrictEqual(g.io(), ['read'])
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      const left = yield* g.lntt('check')
      assert.strictEqual(left.code, 1)
      assert.match(left.out, /nothing to change/)
      assert.match(left.err, /0 changes, 2 by hand/)
    }),
  )

  it.effect('--check: exit 0 once the Project and the types are as the board declares them', () =>
    Effect.gen(function* () {
      const g = github()
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      const s = g.state.live
      s.fields[0].options = s.fields[0].options.filter((o: Json) => o.name !== 'Archived')
      s.issueTypes = s.issueTypes.filter((t: Json) => t.name !== 'Chore')
      const r = yield* g.lntt('check')
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /nothing to change/)
    }),
  )

  it.effect('no board section: exit 1, and gh is not called', () =>
    Effect.gen(function* () {
      const g = github()
      g.state.config = {}
      const r = yield* g.lntt()
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /no board/)
      assert.deepStrictEqual(g.calls, [])
    }),
  )

  it.effect('a configuration the loader refuses: exit 1 with its message', () =>
    Effect.gen(function* () {
      const g = github()
      g.state.refused = '.agents/config.jsonc: board.fields must be an object'
      const r = yield* g.lntt()
      assert.strictEqual(r.code, 1)
      assert.strictEqual(r.err, 'lntt board sync: .agents/config.jsonc: board.fields must be an object')
    }),
  )
})

describe('lntt board sync: views', () => {
  it.effect('a missing one is created with its filter and fields, and its grouping is left to the UI', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Open', layout: 'table', filter: 'is:open', fields: ['Status'], groupBy: 'Status' }])
      const dry = yield* g.lntt()
      assert.match(dry.out, /create view Open \(TABLE_LAYOUT\): filter "is:open", fields Status/)
      const r = yield* g.lntt('apply')
      assert.strictEqual(r.code, 0, r.err)
      assert.ok(g.io().includes('createProjectV2View') && g.io().includes('updateProjectV2View'))
      const open = g.state.live.views[0]
      assert.strictEqual(open.filter, 'is:open')
      assert.deepStrictEqual(
        open.fields.nodes.map((f: Json) => f.name),
        ['Status'],
      )
      assert.match(
        r.out,
        /the view Open groups by \(none\), board\.github\.views says Status[^\n]*\n {4}https:\/\/github\.com\/orgs\/DemoOrg\/projects\/1\/views\/1/,
      )
      assert.strictEqual((yield* g.lntt('check')).code, 1, 'the grouping is still a difference')
    }),
  )

  it.effect('a view naming a field this run creates gets its id once the field exists', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Plan', layout: 'table', fields: ['Status', 'Horizon'] }])
      const r = yield* g.lntt('apply')
      assert.strictEqual(r.code, 0, r.err)
      const plan = g.state.live.views.find((v: Json) => v.name === 'Plan')
      assert.deepStrictEqual(
        plan.fields.nodes.map((f: Json) => f.name),
        ['Status', 'Horizon'],
      )
    }),
  )

  it.effect(
    'one with no filter (or a blank one) and no fields is created alone, with no update and no configuration',
    () =>
      Effect.gen(function* () {
        for (const view of [
          { name: 'Plain', layout: 'table' },
          { name: 'Plain', layout: 'table', filter: '' },
        ]) {
          const g = github()
          g.withViews([view])
          assert.match((yield* g.lntt()).out, /create view Plain \(TABLE_LAYOUT\)\n/)
          assert.strictEqual((yield* g.lntt('apply')).code, 0)
          assert.ok(!g.io().includes('updateProjectV2View'))
          assert.deepStrictEqual(
            g.state.live.views.map((v: Json) => [v.filter, v.configured]),
            [['', false]],
          )
        }
      }),
  )

  it.effect('the filter of a new view is written 1.2 s after its create', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Open', layout: 'table', filter: 'is:open' }])
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      const names = g.calls.filter((c) => !['read', 'items', 'search', 'field'].includes(c))
      const at = names.indexOf('createProjectV2View')
      assert.strictEqual(names[at + 1], 'updateProjectV2View')
      assert.strictEqual((g.times[at + 1] as number) - (g.times[at] as number), 1200)
    }),
  )

  it.effect('an existing view that differs is updated, its layout, filter and fields', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Old', layout: 'board', filter: 'is:open', fields: ['Status', 'Horizon'] }], [liveView()])
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      const old = g.state.live.views[0]
      assert.deepStrictEqual(
        [old.layout, old.filter, old.fields.nodes.map((f: Json) => f.name)],
        ['BOARD_LAYOUT', 'is:open', ['Status', 'Horizon']],
      )
    }),
  )

  it.effect("a board's columns are read from the view: a different field is left to the UI", () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews(
        [{ name: 'Old', layout: 'board', columns: 'Horizon' }],
        [liveView({ layout: 'BOARD_LAYOUT', verticalGroupByFields: { nodes: [{ name: 'Status' }] } })],
      )
      assert.match((yield* g.lntt()).out, /the view Old has columns by Status, board\.github\.views says Horizon/)
    }),
  )

  it.effect('--check exits 0 when every declared view is as declared', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Old', layout: 'table', filter: '', fields: ['Status'] }])
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      const s = g.state.live
      s.fields[0].options = s.fields[0].options.filter((o: Json) => o.name !== 'Archived')
      s.issueTypes = s.issueTypes.filter((t: Json) => t.name !== 'Chore')
      s.views = [liveView()]
      const r = yield* g.lntt('check')
      assert.strictEqual(r.code, 0, r.out + r.err)
    }),
  )

  it.effect('the ids of fields read before the run are not asked again', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews(
        [{ name: 'Old', layout: 'table', fields: ['Status'], filter: 'is:open' }],
        [liveView({ fields: { nodes: [] } })],
      )
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      assert.ok(!g.calls.includes('field'), g.calls.join(' '))
    }),
  )

  it.effect('an update naming a field this run creates resolves its id too', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Old', layout: 'table', fields: ['Horizon'] }], [liveView()])
      assert.strictEqual((yield* g.lntt('apply')).code, 0)
      assert.ok(g.calls.includes('field'))
      assert.deepStrictEqual(
        g.state.live.views[0].fields.nodes.map((f: Json) => f.name),
        ['Horizon'],
      )
    }),
  )

  it.effect('a field that does not come back once created stops the run, naming it', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews([{ name: 'Plan', layout: 'table', fields: ['Horizon'] }])
      const r = yield* g.lntt('apply', { noop: 'createProjectV2Field' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /no field Horizon on the Project/)
    }),
  )

  it.effect('a view with more visible fields than one read stops a board that declares views', () =>
    Effect.gen(function* () {
      const g = github()
      g.withViews(
        [{ name: 'Old', layout: 'table' }],
        [liveView({ fields: { nodes: [], pageInfo: { hasNextPage: true } } })],
      )
      const r = yield* g.lntt()
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /more than 50 visible fields/)
    }),
  )

  it.effect('more than one page of views stops the run only when the board declares views', () =>
    Effect.gen(function* () {
      const g = github()
      assert.strictEqual((yield* g.lntt('dry run', { moreViews: true })).code, 0)
      g.withViews([{ name: 'Old', layout: 'table' }])
      const r = yield* g.lntt('dry run', { moreViews: true })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /more than 50 views/)
    }),
  )
})

// GitHub for lntt board ready: the Project's items in `state`, served in pages of `page` items,
// and the mutation that changes an item's status there. Each move is logged.
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

const item = (id: string, status: string, number: number, over: Json = {}) => ({
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
    ...over.content,
  },
})

const OPTIONS = [
  { id: 'o_todo', name: 'Todo' },
  { id: 'o_ready', name: 'Ready' },
  { id: 'o_done', name: 'Done' },
]

const ITEMS = () => [
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
]

// `fail`: the item whose move gh refuses ('any' for every one); `noop`: the moves answer without
// doing; `noRepo`: gh names no repository.
interface ReadyQuirks {
  fail?: string
  noop?: boolean
  noRepo?: boolean
  page?: number
  // GITHUB_REPOSITORY, as board-cli.ts reads it.
  repository?: string
  // The Project is not there, or the token cannot see it.
  noProject?: boolean
}

function readyBoard() {
  const state = {
    options: OPTIONS as Json[],
    items: ITEMS() as Json[],
    config: { board: structuredClone(BOARD) } as Json,
    refused: null as string | null,
    quirks: {} as ReadyQuirks,
  }
  const moves: string[] = []
  const times: number[] = []
  const graphql = (query: string, v: Json) =>
    Effect.gen(function* () {
      if (query.includes('updateProjectV2ItemFieldValue')) {
        if (state.quirks.fail === 'any' || state.quirks.fail === v.item) {
          return yield* new GhError({ args: ['api', 'graphql'], output: 'gh: Resource not accessible' })
        }
        moves.push(`move ${v.item} ${v.option}`)
        times.push(yield* Clock.currentTimeMillis)
        if (!state.quirks.noop) {
          const moved = state.items.find((i) => i.id === v.item) as Json
          moved.status = { name: (state.options.find((o) => o.id === v.option) as Json).name }
        }
        return {}
      }
      if (state.quirks.noProject) return { organization: { projectV2: null } }
      const size = state.quirks.page ?? 100
      const start = v.after ? Number(v.after) : 0
      const end = start + size
      return {
        organization: {
          projectV2: {
            id: 'PVT_1',
            field: { id: 'F_status', options: state.options },
            items: {
              nodes: structuredClone(state.items.slice(start, end)),
              pageInfo: { hasNextPage: end < state.items.length, endCursor: String(end) },
            },
          },
        },
      }
    })
  const repository = Effect.suspend(() =>
    state.quirks.noRepo
      ? Effect.fail(new GhError({ args: ['repo', 'view'], output: 'gh: no default repository' }))
      : Effect.succeed('o/r'),
  )
  const lntt = (apply = false, quirks: ReadyQuirks = {}) =>
    Effect.gen(function* () {
      state.quirks = quirks
      const repository = quirks.repository ? { repository: quirks.repository } : {}
      const fiber = yield* Effect.forkChild(command({ kind: 'ready', apply, ...repository }))
      yield* TestClock.adjust('1 hour')
      const code = yield* Fiber.join(fiber)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code, out: `${out}\n`, err }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Gh.memory({ graphql, repository }), configOf(state), Layer.fresh(TestConsole.layer)),
      ),
    )
  const status = (id: string) => state.items.find((i) => i.id === id)?.status?.name
  return { state, moves, times, lntt, status }
}

describe('lntt board ready', () => {
  it.effect('lists the issues at the first status, what is missing for the others, and writes nothing', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      const r = yield* b.lntt()
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /DemoOrg project 1 \(Demo\), o\/r, dry run/)
      assert.match(r.out, /Ready-eligible:\n {4}#10 issue 10\n/)
      assert.match(r.out, /#11 issue 11: missing open blocker #10/)
      assert.match(r.out, /#12 issue 12: missing Size/)
      assert.match(r.out, /#13 issue 13: holds 2 open sub-issues/)
      assert.notMatch(r.out, /#1[4-8] /)
      assert.match(r.out, /--apply/)
      assert.deepStrictEqual(b.moves, [])
    }),
  )

  it.effect('--apply moves only the eligible ones, to the option of the configuration', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      const r = yield* b.lntt(true)
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(b.moves, ['move I_10 o_ready'])
      assert.strictEqual(b.status('I_10'), 'Ready')
      assert.strictEqual(b.status('I_11'), 'Todo')
      assert.match(r.out, /moved 1 issue to Ready/)
    }),
  )

  it.effect('GITHUB_REPOSITORY names the repository: gh is not asked', () =>
    Effect.gen(function* () {
      const r = yield* readyBoard().lntt(false, { noRepo: true, repository: 'o/other' })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /o\/other, dry run[\s\S]*#15 issue 15/)
    }),
  )

  it.effect('every page of the Project is read', () =>
    Effect.gen(function* () {
      const r = yield* readyBoard().lntt(false, { page: 2 })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /#10 issue 10/)
      assert.match(r.out, /#13 issue 13/)
    }),
  )

  it.effect('other status names work unchanged', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      b.state.config.board.fields.status = {
        name: 'Stato',
        type: 'singleSelect',
        options: ['Nuova', 'Pronta'],
        ready: 'Pronta',
      }
      b.state.options = [
        { id: 'o_new', name: 'Nuova' },
        { id: 'o_go', name: 'Pronta' },
      ]
      b.state.items = [item('I_20', 'Nuova', 20)]
      const r = yield* b.lntt(true)
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(b.moves, ['move I_20 o_go'])
    }),
  )

  it.effect('a field of kind issue is read on the issue, not on the item', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      b.state.config.board.fields.priority.kind = 'issue'
      b.state.items = [
        item('I_30', 'Todo', 30, { content: { issueFieldValues: { nodes: [{ field: { name: 'Other' } }] } } }),
        item('I_31', 'Todo', 31, { content: { issueFieldValues: { nodes: [{ field: { name: 'Priority' } }] } } }),
      ]
      const r = yield* b.lntt()
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /#30 issue 30: missing Priority/)
      assert.match(r.out, /Ready-eligible:\n {4}#31 issue 31\n/)
    }),
  )

  it.effect('a ready status the Project does not have stops the run, naming its options', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      b.state.options = OPTIONS.filter((o) => o.name !== 'Ready')
      const r = yield* b.lntt(true)
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /^lntt board ready: reading the board: "Ready" is not an option of Status \(Todo, Done\)/)
      assert.deepStrictEqual(b.moves, [])
    }),
  )

  it.effect('a move that fails stops with its message, and says how many moved before it', () =>
    Effect.gen(function* () {
      const first = yield* readyBoard().lntt(true, { fail: 'any' })
      assert.strictEqual(first.code, 1)
      assert.match(first.err, /#10.*Resource not accessible/)
      const b = readyBoard()
      b.state.items = [item('I_40', 'Todo', 40), item('I_41', 'Todo', 41)]
      const r = yield* b.lntt(true, { fail: 'I_41' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /#41.*Resource not accessible/)
      assert.match(r.err, /moved 1 before it/)
      assert.deepStrictEqual(b.moves, ['move I_40 o_ready'])
    }),
  )

  it.effect('a configuration that does not validate, or a repository gh cannot name, stops with why', () =>
    Effect.gen(function* () {
      const noRepo = yield* readyBoard().lntt(false, { noRepo: true })
      assert.strictEqual(noRepo.code, 1)
      assert.match(noRepo.err, /reading the repository: .*no default repository/)
      assert.match(noRepo.err, /gh repo set-default, or GITHUB_REPOSITORY/)
      const b = readyBoard()
      b.state.refused = '.agents/config.jsonc: board has an unknown key nope'
      const bad = yield* b.lntt()
      assert.strictEqual(bad.code, 1)
      assert.match(bad.err, /nope/)
    }),
  )

  it.effect('--apply reads the board back, and says what did not move', () =>
    Effect.gen(function* () {
      const r = yield* readyBoard().lntt(true, { noop: true })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /still at Todo after --apply: #10/)
    }),
  )

  it.effect('the moves are 1.2 s apart', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      b.state.items = [item('I_40', 'Todo', 40), item('I_41', 'Todo', 41)]
      const r = yield* b.lntt(true)
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(b.moves, ['move I_40 o_ready', 'move I_41 o_ready'])
      assert.strictEqual((b.times[1] as number) - (b.times[0] as number), 1200)
    }),
  )

  it.effect('a Project that is not there, or the token cannot see: exit 1, naming it', () =>
    Effect.gen(function* () {
      const r = yield* readyBoard().lntt(false, { noProject: true })
      assert.strictEqual(r.code, 1)
      assert.strictEqual(r.err, 'lntt board ready: reading the board: no Project 1 of DemoOrg')
    }),
  )

  it.effect('a project with no check says why', () =>
    Effect.gen(function* () {
      const b = readyBoard()
      b.state.config.board.fields = {}
      const r = yield* b.lntt()
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /board\.github\.project and board\.fields\.status/)
    }),
  )
})
