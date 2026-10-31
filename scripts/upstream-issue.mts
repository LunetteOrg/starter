// The issue of a red upstream check (.github/workflows/upstream.yml, the step `Open an
// issue`; docs/process/ci.md#upstream-tools).
//
//   node scripts/upstream-issue.mts --tool <t> --version <v> --step <text> --run <url>
//                                   --log <file> [--dry-run]
//
// One tool and version opens at most one issue, `<tool> <version> breaks lntt`: an issue
// with that title, open or closed, stops a second. A red whose tool fails at the same
// tests (or, with no test failing, the same step) as an open issue goes there as a
// comment, once per version: the issue's body carries the failure in a marker line. A
// new issue is opened with the type Bug of board.issueTypes, added to the Project of
// board.github.project and set to the status role `initial`; Priority is left to
// whoever triages it. GH_TOKEN writes the issue; PROJECTS_GH_TOKEN, when set, the
// Project. Inside Actions without it, the issue is opened off the board, with a notice.
// --dry-run prints every write instead of making it. Run from the repository root.

import { readFileSync } from 'node:fs'
import { argv, cwd, env, exit, stderr, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BOARD_MUTATION, type Gh, makeGh, NOT_PERMITTED, pickBoard } from '../packages/lntt/src/ci/candidate.ts'
import { loadConfig } from '../packages/lntt/src/index.ts'

// The issue type of a red, when board.issueTypes has it.
const BUG = 'Bug'
// The lines of the log the issue and the comments quote.
const TAIL = 80

export interface Failure {
  tool: string
  version: string
  // The step that failed, as the workflow names it.
  step: string
  run: string
  log: string
}

// Where a new issue goes, from `board`: each part is left out when the board lacks it.
export interface Target {
  type?: string
  project?: { owner: string; ownerType: 'organization' | 'user'; number: number }
  status?: { field: string; option: string }
}

export interface Report {
  gh: Gh
  // The same commands with a token that has the Projects permission.
  board?: Gh
  repo: string
  target: Target
  log: (line: string) => void
}

interface BoardSection {
  github?: { project?: { owner: string; ownerType?: 'organization' | 'user'; number: number } }
  issueTypes?: { parents?: string[]; children?: string[] }
  fields?: { status?: { name: string; options: string[]; initial?: string } }
}

export function boardTarget(board: BoardSection | undefined): Target {
  const project = board?.github?.project
  const types = [...(board?.issueTypes?.children ?? []), ...(board?.issueTypes?.parents ?? [])]
  const status = board?.fields?.status
  const option = status?.initial ?? status?.options[0]
  return {
    ...(types.includes(BUG) ? { type: BUG } : {}),
    ...(project
      ? { project: { owner: project.owner, ownerType: project.ownerType ?? 'organization', number: project.number } }
      : {}),
    ...(status && option ? { status: { field: status.name, option } } : {}),
  }
}

// The color codes of the log (ESC [ … m).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

// The tests node --test lists under "failing tests", by name: their line numbers move
// from one version of the test file to the next, their names do not.
export function failingTests(log: string): string[] {
  const lines = log.replace(ANSI, '').split('\n')
  const start = lines.findIndex((line) => line.trim() === '✖ failing tests:')
  if (start === -1) return []
  const names = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    const name = /^✖ (.+) \([\d.]+m?s\)$/.exec(line)?.[1]
    if (name) names.add(name)
  }
  return [...names].sort()
}

// What makes two reds of a tool the same failure.
function failureMarker(tool: string, tests: string[], step: string) {
  const key = tests.length > 0 ? `test: ${tests.join(' | ')}` : `step: ${step}`
  return `<!-- upstream-failure: ${tool}: ${key.replaceAll('--', '- -')} -->`
}

const versionMarker = (f: Failure) => `<!-- upstream-version: ${f.tool} ${f.version} -->`

function logTail(log: string): string[] {
  const lines = log.replace(ANSI, '').trimEnd().split('\n')
  return ['<details><summary>The end of the log</summary>', '', '````', ...lines.slice(-TAIL), '````', '', '</details>']
}

function issueBody(f: Failure, repo: string, tests: string[]): string {
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com'
  return [
    `The scheduled check of lntt against ${f.tool} ${f.version} failed at **${f.step}**.`,
    '',
    ...(tests.length > 0 ? ['The failing tests:', '', ...tests.map((t) => `- ${t}`), ''] : []),
    `Run: ${f.run}`,
    '',
    `A later red of ${f.tool} at the same ${tests.length > 0 ? 'tests' : 'step'} is added here as a comment while this issue is open: keep the marker at the end of this body.`,
    '',
    `What to do: ${server}/${repo}/blob/main/docs/process/ci.md#upstream-tools`,
    '',
    ...logTail(f.log),
    '',
    failureMarker(f.tool, tests, f.step),
    '',
  ].join('\n')
}

function commentBody(f: Failure): string {
  return [
    `${f.tool} ${f.version} fails the same way, at **${f.step}**.`,
    '',
    `Run: ${f.run}`,
    '',
    ...logTail(f.log),
    '',
    versionMarker(f),
    '',
  ].join('\n')
}

// Opens the issue of a red, adds it to the issue already open for the same failure, or
// does nothing when this tool and version already has its issue.
export function report(run: Report, f: Failure): { action: 'none' | 'commented' | 'opened'; number?: number } {
  const { gh, repo, target, log } = run
  const title = `${f.tool} ${f.version} breaks lntt`
  const named = JSON.parse(
    gh.read([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--search',
      `"${title}" in:title`,
      '--json',
      'number,title',
    ]),
  ) as Array<{ number: number; title: string }>
  const same = named.find((issue) => issue.title === title)
  if (same) {
    log(`#${same.number} is named "${title}": none opened`)
    return { action: 'none', number: same.number }
  }

  const tests = failingTests(f.log)
  const marker = failureMarker(f.tool, tests, f.step)
  const open = JSON.parse(
    gh.read(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,body']),
  ) as Array<{ number: number; body: string }>
  const reported = open.find((issue) => issue.body.includes(marker))
  if (reported) {
    const comments = gh.read([
      'api',
      `repos/${repo}/issues/${reported.number}/comments`,
      '--paginate',
      '--jq',
      '.[].body',
    ])
    if (comments.includes(versionMarker(f))) {
      log(`#${reported.number} already has ${f.tool} ${f.version}: nothing added`)
      return { action: 'none', number: reported.number }
    }
    gh.write(['issue', 'comment', String(reported.number), '--repo', repo, '--body-file', '-'], commentBody(f))
    log(`#${reported.number} reports the same failure of ${f.tool}: ${f.version} is added there as a comment`)
    return { action: 'commented', number: reported.number }
  }

  const body = issueBody(f, repo, tests)
  const create = (type?: string) =>
    gh.write(
      ['api', `repos/${repo}/issues`, '--method', 'POST', '--input', '-'],
      JSON.stringify({ title, body, ...(type ? { type } : {}) }),
    )
  let created: string
  try {
    created = create(target.type)
  } catch (error) {
    // A type the repository lacks is refused as a validation error (422): the issue
    // matters more than its type. Any other failure stands.
    if (!target.type || !/HTTP 422|Validation Failed/i.test((error as Error).message)) throw error
    log(
      `::notice title=Issue untyped::GitHub refused the type "${target.type}": ${(error as Error).message.split('\n')[0]}`,
    )
    created = create()
  }
  // A dry run creates nothing: there is no issue to put on the board.
  if (!created) return { action: 'opened' }
  const issue = JSON.parse(created) as {
    number: number
    node_id: string
    html_url: string
    type?: { name: string } | null
  }
  log(`opened #${issue.number}: ${issue.html_url}`)
  if (target.type && issue.type?.name !== target.type) {
    log(`::notice title=Issue untyped::#${issue.number} has no type: GitHub dropped "${target.type}"; set it by hand`)
  }
  putOnBoard(run, issue)
  return { action: 'opened', number: issue.number }
}

const PROJECT_QUERY = (owner: 'organization' | 'user') => `query($owner: String!, $number: Int!, $field: String!) {
  ${owner}(login: $owner) {
    projectV2(number: $number) {
      id
      title
      field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } }
    }
  }
}`

const ADD_MUTATION = `mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`

const READ_BACK = `query($item: ID!, $field: String!) {
  node(id: $item) {
    ... on ProjectV2Item {
      fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    }
  }
}`

// The issue is open whatever happens here: every failure is a notice, and the run goes on.
function putOnBoard({ board, target, log }: Report, issue: { number: number; node_id: string }) {
  const { project, status } = target
  if (!project) return
  // Once the item is added, a later failure leaves the issue on the Project with its
  // status unset, not off it.
  let placed = false
  const off = (why: string) =>
    log(
      placed
        ? `::notice title=Status not set::#${issue.number} is on the Project with its status unset: ${why}. Set it with the github-board skill (docs/process/ci.md#upstream-tools)`
        : `::notice title=Issue off the board::#${issue.number} is not on the Project: ${why}. Add it with the github-board skill (docs/process/ci.md#upstream-tools)`,
    )
  if (!board) return off('no token with the Projects permission')
  const field = status?.field ?? 'Status'
  try {
    const owner = project.ownerType
    const found = JSON.parse(
      board.read([
        'api',
        'graphql',
        '-f',
        `query=${PROJECT_QUERY(owner)}`,
        '-f',
        `owner=${project.owner}`,
        '-F',
        `number=${project.number}`,
        '-f',
        `field=${field}`,
      ]),
    ) as {
      data: Record<
        string,
        { projectV2: { id: string; field?: { id?: string; options?: Array<{ id: string; name: string }> } | null } }
      >
    }
    const projectV2 = found.data[owner]?.projectV2
    if (!projectV2) return off(`no Project ${project.owner}/${project.number}`)
    const added = JSON.parse(
      board.write([
        'api',
        'graphql',
        '-f',
        `query=${ADD_MUTATION}`,
        '-f',
        `project=${projectV2.id}`,
        '-f',
        `content=${issue.node_id}`,
      ]),
    ) as { data: { addProjectV2ItemById: { item: { id: string } } } }
    const item = added.data.addProjectV2ItemById.item.id
    placed = true
    if (!status) return log(`#${issue.number} on the Project, with no status field configured`)
    const option = projectV2.field?.options?.find((o) => o.name.toLowerCase() === status.option.toLowerCase())
    if (!projectV2.field?.id || !option) {
      const options = (projectV2.field?.options ?? []).map((o) => o.name).join(', ')
      return log(
        `::notice title=Status not set::"${status.option}" is not an option of ${field} on the Project (${options}): #${issue.number} is on it with no status set`,
      )
    }
    board.write([
      'api',
      'graphql',
      '-f',
      `query=${BOARD_MUTATION}`,
      '-f',
      `project=${projectV2.id}`,
      '-f',
      `item=${item}`,
      '-f',
      `field=${projectV2.field.id}`,
      '-f',
      `option=${option.id}`,
    ])
    // Read back: a workflow of the Project may write the status after this one.
    const back = JSON.parse(
      board.read(['api', 'graphql', '-f', `query=${READ_BACK}`, '-f', `item=${item}`, '-f', `field=${field}`]),
    ) as { data: { node?: { fieldValueByName?: { name?: string } | null } | null } }
    log(`#${issue.number} on the Project at "${back.data.node?.fieldValueByName?.name ?? 'no status'}"`)
  } catch (error) {
    const message = (error as Error).message.split('\n')[0] ?? ''
    off(NOT_PERMITTED.test(message) ? `the token was refused: ${message}` : message)
  }
}

function main(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      tool: { type: 'string' },
      version: { type: 'string' },
      step: { type: 'string' },
      run: { type: 'string' },
      log: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  const { tool, version, step, run } = values
  if (!tool || !version || !step || !run) {
    stderr.write(
      'usage: upstream-issue.mts --tool <t> --version <v> --step <text> --run <url> --log <file> [--dry-run]\n',
    )
    return 2
  }
  let text = ''
  try {
    text = values.log ? readFileSync(values.log, 'utf8') : ''
  } catch {
    // A job that failed before the first logged step has no log: the issue says so.
  }
  const log = (line: string) => stdout.write(`${line}\n`)
  const dryRun = values['dry-run']
  const gh = makeGh({ dryRun, log })
  const board = pickBoard(env.PROJECTS_GH_TOKEN, Boolean(env.GITHUB_ACTIONS), gh, (token) =>
    makeGh({ dryRun, log, token }),
  )
  const repo = env.GITHUB_REPOSITORY || gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const target = boardTarget(loadConfig(cwd()).data.board as BoardSection | undefined)
  report({ gh, ...(board ? { board } : {}), repo, target, log }, { tool, version, step, run, log: text || '(no log)' })
  return 0
}

if (argv[1] === fileURLToPath(import.meta.url)) exit(main(argv.slice(2)))
