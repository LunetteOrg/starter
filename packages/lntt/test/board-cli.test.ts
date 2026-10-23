import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

// A fake gh for `gh api graphql --input -`: the Project and the organization's issue
// types live in the JSON file $GH_STATE, the read query answers from it, and the four
// mutations lntt board sync sends change it as GitHub would (a new option without an id
// gets a new one, a name or a color given replaces the old). The items of the Project
// are state.items ({ Status: "Archived" }), the issues of each type state.typeCounts.
// Each call is logged: "read", "items", "search", or the mutation's name.
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'))
const { query, variables: v } = JSON.parse(fs.readFileSync(0, 'utf8'))
const log = (line) => fs.appendFileSync(process.env.GH_LOG, line + '\\n')
let n = Object.keys(state).length + JSON.stringify(state).length
const id = (p) => p + '_' + ++n
const save = () => fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state))
const reply = (data) => process.stdout.write(JSON.stringify({ data }))
const name = (query.match(/(createProjectV2Field|updateProjectV2Field|createIssueType|updateIssueType|createProjectV2View|updateProjectV2View)/) || [])[1]
if (process.env.GH_FAIL && name === process.env.GH_FAIL) {
  process.stderr.write('gh: Resource not accessible by integration\\n'); process.exit(1)
}
const kind = name || (query.includes('items(') ? 'items' : query.includes('search(') ? 'search' : 'read')
log(kind)
if (name) fs.appendFileSync(process.env.GH_LOG + '.times', Date.now() + '\\n')
if (!name && process.env.GH_NO_ORG && query.includes('organization(')) {
  process.stderr.write("gh: Could not resolve to an Organization with the login of 'DemoOrg'.\\n"); process.exit(1)
}
if (name && name === process.env.GH_NOOP) { reply({ [name]: {} }); process.exit(0) }
const withIds = (options) => options.map((o) => ({ id: o.id || id('o'), name: o.name, color: o.color, description: o.description }))
const page = { hasNextPage: !!process.env.GH_MORE }
if (kind === 'items') {
  // GH_PAGES=2 serves the items in two pages, the second after the cursor "p2".
  const all = (state.items || []).map((values) => ({ v: values[v.field] ? { name: values[v.field] } : null }))
  const half = process.env.GH_PAGES ? Math.ceil(all.length / 2) : all.length
  const nodes = v.after === 'p2' ? all.slice(half) : all.slice(0, half)
  const more = !!process.env.GH_PAGES && v.after !== 'p2'
  reply({ node: { items: { nodes, pageInfo: { hasNextPage: more, endCursor: more ? 'p2' : null } } } })
} else if (kind === 'search') {
  const type = v.q.match(/type:"([^"]+)"/)[1]
  reply({ search: { issueCount: (state.typeCounts || {})[type] || 0 } })
} else if (!name && query.includes('user(')) {
  reply({ user: { id: 'U_1', projectV2: { id: 'PVT_1', url: 'https://github.com/users/someone/projects/1', fields: { nodes: state.fields, pageInfo: page }, views: { nodes: state.views, pageInfo: { hasNextPage: false } } } } })
} else if (!name) {
  reply({ organization: { id: 'O_1', projectV2: { id: 'PVT_1', url: 'https://github.com/orgs/DemoOrg/projects/1', fields: { nodes: state.fields, pageInfo: page }, views: { nodes: state.views, pageInfo: { hasNextPage: false } } },
    issueTypes: { nodes: state.issueTypes, pageInfo: { hasNextPage: !!process.env.GH_MORE_TYPES } } } })
} else if (name === 'createProjectV2View') {
  const view = { id: id('V'), number: state.views.length + 1, name: v.input.name, layout: v.input.layout, filter: '',
    fields: { nodes: (v.input.configuration?.visibleFieldIds || []).map((f) => ({ name: state.fields.find((x) => x.id === f).name })) },
    groupByFields: { nodes: [] }, verticalGroupByFields: { nodes: [] } }
  state.views.push(view); save(); reply({ createProjectV2View: { projectV2View: { id: view.id } } })
} else if (name === 'updateProjectV2View') {
  const view = state.views.find((x) => x.id === v.input.viewId)
  for (const k of ['name', 'layout', 'filter']) if (v.input[k] !== undefined) view[k] = v.input[k]
  if (v.input.configuration) view.fields = { nodes: v.input.configuration.visibleFieldIds.map((f) => ({ name: state.fields.find((x) => x.id === f).name })) }
  save(); reply({ updateProjectV2View: { projectV2View: { id: view.id } } })
} else if (name === 'createProjectV2Field') {
  const f = { id: id('F'), name: v.input.name, dataType: v.input.dataType }
  if (v.input.singleSelectOptions) f.options = withIds(v.input.singleSelectOptions)
  state.fields.push(f); save(); reply({ createProjectV2Field: { projectV2Field: { id: f.id } } })
} else if (name === 'updateProjectV2Field') {
  const f = state.fields.find((x) => x.id === v.input.fieldId)
  if (v.input.name) f.name = v.input.name
  if (v.input.singleSelectOptions) f.options = withIds(v.input.singleSelectOptions)
  save(); reply({ updateProjectV2Field: { projectV2Field: { id: f.id } } })
} else if (name === 'createIssueType') {
  state.issueTypes.push({ id: id('T'), name: v.input.name, description: v.input.description || null }); save()
  reply({ createIssueType: { issueType: { id: 'T' } } })
} else {
  const t = state.issueTypes.find((x) => x.id === v.input.issueTypeId)
  if (v.input.name) t.name = v.input.name
  if (v.input.description) t.description = v.input.description
  save(); reply({ updateIssueType: { issueType: { id: t.id } } })
}
`

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
  views: [] as unknown[],
  typeCounts: { Chore: 4 },
}

let tmp: string
let repo: string
let stubs: string
let gh: { state: string; log: string }

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-board-')))
  repo = join(tmp, 'repo')
  stubs = join(tmp, 'bin')
  mkdirSync(join(repo, '.agents'), { recursive: true })
  mkdirSync(stubs)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(CONFIG))
  writeFileSync(join(stubs, 'gh'), GH)
  chmodSync(join(stubs, 'gh'), 0o755)
  gh = { state: join(tmp, 'state.json'), log: join(tmp, 'gh.log') }
  writeFileSync(gh.state, JSON.stringify(LIVE))
  writeFileSync(gh.log, '')
})

afterEach(() => rmSync(tmp, { recursive: true, force: true }))

function lntt(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [BIN, 'board', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GH_STATE: gh.state, GH_LOG: gh.log, PATH: `${stubs}:${process.env.PATH}`, ...env },
  })
}
const calls = () => readFileSync(gh.log, 'utf8').trim().split('\n').filter(Boolean)
const live = () => JSON.parse(readFileSync(gh.state, 'utf8')) as typeof LIVE
// The reads and writes, without the counts of what a removal would touch.
const io = () => calls().filter((c) => c !== 'items' && c !== 'search')

describe('lntt board sync', () => {
  test('a dry run by default: prints the plan, writes nothing, and says how to apply it', () => {
    const r = lntt(['sync'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(io(), ['read'])
    assert.match(r.stdout, /DemoOrg project 1 \(Demo\), dry run/)
    assert.match(r.stdout, /update options of Status: add "Ready"/)
    assert.match(r.stdout, /create field Horizon \(single select\): Now GREEN, Next BLUE/)
    assert.match(r.stdout, /rename issue type "task" → "Task"/)
    assert.match(r.stdout, /create issue type Debt: A debt to pay back/)
    assert.match(r.stdout, /by hand, in GitHub's UI:\n {2}.*Archived/)
    assert.match(r.stdout, /--apply/)
  })

  test('--apply makes the changes, keeps the ids of the existing options, and reads the board back', () => {
    const r = lntt(['sync', '--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(io(), [
      'read',
      'updateProjectV2Field',
      'createProjectV2Field',
      'createIssueType',
      'updateIssueType',
      'read',
    ])
    const after = live()
    const status = after.fields.find((f) => f.name === 'Status')
    assert.deepEqual(
      status?.options.map((o) => [o.id.startsWith('o_') ? 'new' : o.id, o.name, o.color]),
      [
        ['s1', 'Todo', 'GREEN'],
        ['new', 'Ready', 'GRAY'],
        ['s3', 'Done', 'PURPLE'],
        ['s9', 'Archived', 'GRAY'],
      ],
    )
    assert.deepEqual(
      after.fields.find((f) => f.name === 'Horizon')?.options.map((o) => [o.name, o.color]),
      [
        ['Now', 'GREEN'],
        ['Next', 'BLUE'],
      ],
    )
    assert.ok(after.issueTypes.some((t) => t.name === 'Debt' && t.description === 'A debt to pay back'))
    assert.ok(
      after.issueTypes.some((t) => t.id === 'T_task' && t.name === 'Task'),
      'renamed, same id',
    )
    assert.match(r.stdout, /applied 4 changes/)
    assert.match(r.stdout, /Archived/, 'what is left to the UI is still listed')
  })

  test('idempotent: once applied, a second run has nothing to change and writes nothing', () => {
    assert.equal(lntt(['sync', '--apply']).status, 0)
    writeFileSync(gh.log, '')
    const r = lntt(['sync', '--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(io(), ['read', 'read'])
    assert.match(r.stdout, /nothing to change/)
  })

  test('a write gh refuses stops the run, exit 1, with what was applied before it', () => {
    const r = lntt(['sync', '--apply'], { GH_FAIL: 'createIssueType' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /create issue type Debt.*Resource not accessible/s)
    assert.match(r.stderr, /applied 2 changes before it/)
  })

  test('the writes are 1.2 s apart: the secondary rate limit drops faster ones', () => {
    assert.equal(lntt(['sync', '--apply']).status, 0)
    const times = readFileSync(`${gh.log}.times`, 'utf8').trim().split('\n').map(Number)
    assert.equal(times.length, 4)
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 1100, `${times[i] - times[i - 1]} ms`)
  })

  test('a change that does not show on the read-back: exit 1, naming it', () => {
    const r = lntt(['sync', '--apply'], { GH_NOOP: 'createIssueType' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /still differs after --apply:\n {2}create issue type Debt/)
  })

  test("a user's Project: no issue types are read, and the board's are left to the person", () => {
    const user = structuredClone(CONFIG)
    Object.assign(user.board.github.project, { owner: 'someone', ownerType: 'user' })
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(user))
    const r = lntt(['sync'])
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /create issue type/)
    assert.match(r.stdout, /owned by a user/)
  })

  test('an organization that does not resolve: the error says ownerType defaults to organization', () => {
    const r = lntt(['sync'], { GH_NO_ORG: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Could not resolve to an Organization/)
    assert.match(r.stderr, /board\.github\.project\.ownerType.*organization/)
  })

  test('a Project with more fields than one page: stop, rather than create one that exists', () => {
    const r = lntt(['sync', '--apply'], { GH_MORE: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /more than 100 fields/)
    assert.deepEqual(calls(), ['read'])
  })

  test('an organization with more issue types than one page: stop, rather than create one that exists', () => {
    const r = lntt(['sync', '--apply'], { GH_MORE_TYPES: '1' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /more than 50 issue types/)
  })

  test('the items an option holds are counted across every page of the Project', () => {
    const r = lntt(['sync'], { GH_PAGES: '2' })
    assert.equal(calls().filter((c) => c === 'items').length, 2)
    assert.match(r.stdout, /"Archived"[^\n]*2 items have it/)
  })

  test('--check: a removal left to the UI is a difference too, with no change to make', () => {
    assert.equal(lntt(['sync', '--apply']).status, 0)
    const r = lntt(['sync', '--check'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /nothing to change/)
    assert.match(r.stderr, /0 changes, 2 by hand/)
  })

  test('a write refused after others prints what is left to the UI too', () => {
    const r = lntt(['sync', '--apply'], { GH_FAIL: 'createIssueType' })
    assert.match(r.stdout, /Archived/)
  })

  test('what is left to the UI says why, how many items or issues it touches, where to go and what to do', () => {
    const r = lntt(['sync'])
    assert.match(r.stdout, /Status: the option "Archived"[^\n]*2 items have it/)
    assert.match(r.stdout, /https:\/\/github\.com\/orgs\/DemoOrg\/projects\/1\/settings\/fields\/21/)
    assert.match(r.stdout, /Status:"Archived"/)
    assert.match(r.stdout, /the issue type Chore[^\n]*4 issues have it/)
    assert.match(r.stdout, /https:\/\/github\.com\/organizations\/DemoOrg\/settings\/issue-types/)
  })

  test('--check: exit 1 when the board differs, naming what differs, and nothing is written', () => {
    const r = lntt(['sync', '--check'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /create field Horizon/)
    assert.match(r.stderr, /the board differs from the configuration: 4 changes, 2 by hand/)
    assert.deepEqual(io(), ['read'])
  })

  test('--check: exit 0 once the Project and the types are as the board declares them', () => {
    assert.equal(lntt(['sync', '--apply']).status, 0)
    const aligned = live()
    aligned.fields[0].options = aligned.fields[0].options.filter((o) => o.name !== 'Archived')
    aligned.issueTypes = aligned.issueTypes.filter((t) => t.name !== 'Chore')
    writeFileSync(gh.state, JSON.stringify(aligned))
    const r = lntt(['sync', '--check'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /nothing to change/)
  })

  test('views: a missing one is created with its filter and fields, and its grouping is left to the UI', () => {
    const config = structuredClone(CONFIG) as typeof CONFIG & { board: { github: { views?: unknown[] } } }
    config.board.github.views = [
      { name: 'Open', layout: 'table', filter: 'is:open', fields: ['Status'], groupBy: 'Status' },
    ]
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify(config))
    const dry = lntt(['sync'])
    assert.match(dry.stdout, /create view Open \(TABLE_LAYOUT\): filter "is:open", fields Status/)
    const r = lntt(['sync', '--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(io().includes('createProjectV2View') && io().includes('updateProjectV2View'))
    const open = (
      live() as unknown as { views: { name: string; filter: string; fields: { nodes: { name: string }[] } }[] }
    ).views[0]
    assert.equal(open.filter, 'is:open')
    assert.deepEqual(
      open.fields.nodes.map((f) => f.name),
      ['Status'],
    )
    assert.match(
      r.stdout,
      /the view Open groups by \(none\), board\.github\.views says Status[^\n]*\n {4}https:\/\/github\.com\/orgs\/DemoOrg\/projects\/1\/views\/1/,
    )
    assert.equal(lntt(['sync', '--check']).status, 1, 'the grouping is still a difference')
  })

  test('no board section: exit 1, and gh is not called', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), '{}')
    const r = lntt(['sync'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no board/)
    assert.deepEqual(calls(), [])
  })

  test('usage: an unknown subcommand or option is exit 2', () => {
    assert.equal(lntt(['pull']).status, 2)
    assert.equal(lntt(['sync', '--force']).status, 2)
    assert.equal(lntt(['sync', '--check', '--apply']).status, 2)
  })
})
