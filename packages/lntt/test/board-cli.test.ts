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
// gets a new one). Each call is logged: "read", or the mutation's name.
const GH = `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'))
const { query, variables: v } = JSON.parse(fs.readFileSync(0, 'utf8'))
const log = (line) => fs.appendFileSync(process.env.GH_LOG, line + '\\n')
let n = Object.keys(state).length + JSON.stringify(state).length
const id = (p) => p + '_' + ++n
const save = () => fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state))
const reply = (data) => process.stdout.write(JSON.stringify({ data }))
const name = (query.match(/(createProjectV2Field|updateProjectV2Field|createIssueType|updateIssueType)/) || [])[1]
if (process.env.GH_FAIL && name === process.env.GH_FAIL) {
  process.stderr.write('gh: Resource not accessible by integration\\n'); process.exit(1)
}
log(name || 'read')
if (name) fs.appendFileSync(process.env.GH_LOG + '.times', Date.now() + '\\n')
if (!name && process.env.GH_NO_ORG && query.includes('organization(')) {
  process.stderr.write("gh: Could not resolve to an Organization with the login of 'DemoOrg'.\\n"); process.exit(1)
}
if (name && name === process.env.GH_NOOP) { reply({ [name]: {} }); process.exit(0) }
const withIds = (options) => options.map((o) => ({ id: o.id || id('o'), name: o.name, color: o.color, description: o.description }))
const page = { hasNextPage: !!process.env.GH_MORE }
if (!name && query.includes('user(')) {
  reply({ user: { id: 'U_1', projectV2: { id: 'PVT_1', fields: { nodes: state.fields, pageInfo: page } } } })
} else if (!name) {
  reply({ organization: { id: 'O_1', projectV2: { id: 'PVT_1', fields: { nodes: state.fields, pageInfo: page } },
    issueTypes: { nodes: state.issueTypes, pageInfo: { hasNextPage: false } } } })
} else if (name === 'createProjectV2Field') {
  const f = { id: id('F'), name: v.input.name, dataType: v.input.dataType }
  if (v.input.singleSelectOptions) f.options = withIds(v.input.singleSelectOptions)
  state.fields.push(f); save(); reply({ createProjectV2Field: { projectV2Field: { id: f.id } } })
} else if (name === 'updateProjectV2Field') {
  const f = state.fields.find((x) => x.id === v.input.fieldId)
  f.options = withIds(v.input.singleSelectOptions); save(); reply({ updateProjectV2Field: { projectV2Field: { id: f.id } } })
} else if (name === 'createIssueType') {
  state.issueTypes.push({ id: id('T'), name: v.input.name, description: v.input.description || null }); save()
  reply({ createIssueType: { issueType: { id: 'T' } } })
} else {
  const t = state.issueTypes.find((x) => x.id === v.input.issueTypeId)
  t.description = v.input.description; save(); reply({ updateIssueType: { issueType: { id: t.id } } })
}
`

const CONFIG = {
  board: {
    github: { project: { owner: 'DemoOrg', ownerType: 'organization', number: 1, title: 'Demo' } },
    issueTypes: { parents: ['Feature', 'Debt'], children: ['Task'], descriptions: { Debt: 'A debt to pay back' } },
    fields: {
      status: { name: 'Status', type: 'singleSelect', options: ['Todo', 'Ready', 'Done'] },
      horizon: { name: 'Horizon', type: 'singleSelect', options: ['Now', 'Next'], on: 'parents' },
    },
  },
}

const LIVE = {
  fields: [
    {
      id: 'F_status',
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
    { id: 'T_task', name: 'Task', description: null },
  ],
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

describe('lntt board sync', () => {
  test('a dry run by default: prints the plan, writes nothing, and says how to apply it', () => {
    const r = lntt(['sync'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(calls(), ['read'])
    assert.match(r.stdout, /DemoOrg project 1 \(Demo\), dry run/)
    assert.match(r.stdout, /add options to Status: Ready/)
    assert.match(r.stdout, /create field Horizon \(single select\): Now, Next/)
    assert.match(r.stdout, /create issue type Debt: A debt to pay back/)
    assert.match(r.stdout, /by hand, in GitHub's UI:\n {2}.*Archived/)
    assert.match(r.stdout, /--apply/)
  })

  test('--apply makes the changes, keeps the ids of the existing options, and reads the board back', () => {
    const r = lntt(['sync', '--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(calls(), ['read', 'updateProjectV2Field', 'createProjectV2Field', 'createIssueType', 'read'])
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
      after.fields.find((f) => f.name === 'Horizon')?.options.map((o) => o.name),
      ['Now', 'Next'],
    )
    assert.ok(after.issueTypes.some((t) => t.name === 'Debt' && t.description === 'A debt to pay back'))
    assert.match(r.stdout, /applied 3 changes/)
    assert.match(r.stdout, /Archived/, 'what is left to the UI is still listed')
  })

  test('idempotent: once applied, a second run has nothing to change and writes nothing', () => {
    assert.equal(lntt(['sync', '--apply']).status, 0)
    writeFileSync(gh.log, '')
    const r = lntt(['sync', '--apply'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(calls(), ['read', 'read'])
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
    assert.equal(times.length, 3)
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

  test('a write refused after others prints what is left to the UI too', () => {
    const r = lntt(['sync', '--apply'], { GH_FAIL: 'createIssueType' })
    assert.match(r.stdout, /Archived/)
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
  })
})
