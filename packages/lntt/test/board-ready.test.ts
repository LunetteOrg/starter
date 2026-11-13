import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

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

// The main paths of lntt board ready, through the CLI as a process with a gh on PATH; the rest of
// its behaviour is in src/board/command.spec.ts, the Ready check itself in src/board-ready.spec.ts.
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

  test('a project with no check says why, and --check is not an option of ready', () => {
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ board: { ...BOARD, fields: {} } }))
    const r = lntt([])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /board\.github\.project and board\.fields\.status/)
    assert.equal(lntt(['--check']).status, 2)
  })
})
