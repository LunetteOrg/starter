// The Ready check: which issues at the board's first status meet the criteria of
// `board.fields.status.ready`, as far as a machine can tell, and what is missing for the
// others (docs/process/board.md, Status). Two entry points use it: `lntt board ready`
// (./board-cli.ts) reads every issue at the first status; the candidate's merge
// (./ci/candidate.ts) reads the issues waiting on what it closed. Whether the body lets
// an agent start cold is a judgement, and no part of it.
//
// The rules come from the configuration, with no name written here, and each criterion
// holds only when the configuration has what it reads: no board.fields.size, no size to
// ask for. The reads split the issue from its board item because the candidate workflow
// holds two tokens, one for the repository and one for the Projects permission.
//
// Plain logic, no node: module: the queries and how an answer reads. lntt board ready runs
// them as Effects over the Gh service (src/board/ready.ts); the candidate's merge runs them
// over its synchronous Graphql (readWaiting, readIssueOnBoard, moveToReady) until lntt ci
// moves to Effect (#340).

import { type Graphql, same } from './board.ts'

export const DEFAULT_READY = 'Ready'

interface FieldRule {
  name: string
  // Where the value lives: on the board's item, or on the issue (an organization's
  // issue field, which reads back null on the item).
  onIssue: boolean
}

export interface ReadyRules {
  project: { owner: string; ownerType: string; number: number; title?: string }
  status: { name: string; initial: string; ready: string }
  priority?: FieldRule
  size?: FieldRule
  types?: { known: string[]; children: string[]; standalone: string[] }
  subIssues: boolean
  blockedBy: boolean
}

interface FieldConfig {
  name?: string
  kind?: string
  options?: string[]
  initial?: string
  ready?: string
}

interface BoardSection {
  provider?: string
  github?: { project?: { owner: string; ownerType?: string; number: number; title?: string } }
  issueTypes?: { parents?: string[]; children?: string[]; standalone?: string[] }
  subIssues?: boolean
  blockedBy?: boolean
  fields?: Record<string, FieldConfig | undefined>
}

const fieldRule = (field: FieldConfig | undefined): FieldRule | undefined =>
  field?.name ? { name: field.name, onIssue: field.kind === 'issue' } : undefined

// The rules of a project's configuration, or null when it has no GitHub board with a
// status on the board's items: there is nothing to check.
export function readyRules(data: Record<string, unknown>): ReadyRules | null {
  const board = data.board as BoardSection | undefined
  const project = board?.github?.project
  const status = board?.fields?.status
  if (!board || (board.provider ?? 'github') !== 'github' || !project || !status?.name || status.kind === 'issue') {
    return null
  }
  const initial = status.initial ?? status.options?.[0]
  if (!initial) return null
  const { parents, children, standalone } = board.issueTypes ?? {}
  const priority = fieldRule(board.fields?.priority)
  const size = fieldRule(board.fields?.size)
  return {
    project: { ...project, ownerType: project.ownerType ?? 'organization' },
    status: { name: status.name, initial, ready: status.ready ?? DEFAULT_READY },
    ...(priority ? { priority } : {}),
    ...(size ? { size } : {}),
    ...(board.issueTypes
      ? {
          types: {
            known: [...(parents ?? []), ...(children ?? [])],
            children: children ?? [],
            standalone: standalone ?? [],
          },
        }
      : {}),
    subIssues: board.subIssues === true,
    blockedBy: board.blockedBy === true,
  }
}

export interface ReadyFacts {
  number: number
  title: string
  type: string | null
  parent: number | null
  openSubIssues: number
  // null: a blocker the token cannot read.
  blockers: Array<{ number: number; repo: string; open: boolean } | null>
  moreBlockers: boolean
  // It has more issue fields than one read holds: one not seen may still be set.
  moreFields: boolean
  // The names of the priority and the size, when set.
  fields: string[]
}

export type Verdict = { kind: 'eligible' } | { kind: 'missing'; missing: string[] } | { kind: 'holds'; open: number }

export const holdsLine = (open: number) => `holds ${open} open sub-issue${open === 1 ? '' : 's'}`

// An issue that holds open sub-issues is picked up through them, and is out of the check.
// A blocker that cannot be read counts as open: a wrong move costs a status change, and
// a missing line says what to look at.
export function assess(rules: ReadyRules, issue: ReadyFacts, repo: string): Verdict {
  if (issue.openSubIssues > 0) return { kind: 'holds', open: issue.openSubIssues }
  const missing: string[] = []
  const { types } = rules
  if (types) {
    if (!issue.type) missing.push('type')
    else if (!types.known.some((t) => same(t, issue.type as string))) {
      missing.push(`a type of board.issueTypes (not ${issue.type})`)
    }
    const isChild = issue.type !== null && types.children.some((t) => same(t, issue.type as string))
    const alone = issue.type !== null && types.standalone.some((t) => same(t, issue.type as string))
    if (rules.subIssues && isChild && !alone && issue.parent === null) missing.push('parent')
  }
  for (const rule of [rules.priority, rules.size]) {
    if (rule && !issue.fields.includes(rule.name)) {
      missing.push(
        rule.onIssue && issue.moreFields ? `${rule.name} (more issue fields than one read holds)` : rule.name,
      )
    }
  }
  if (rules.blockedBy) {
    for (const blocker of issue.blockers) {
      if (blocker === null) missing.push('a blocker this token cannot read')
      else if (blocker.open) missing.push(`open blocker ${blockerRef(blocker, repo)}`)
    }
    if (issue.moreBlockers) missing.push('more blockers than one read holds')
  }
  return missing.length > 0 ? { kind: 'missing', missing } : { kind: 'eligible' }
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const blockerRef = ({ number, repo }: { number: number; repo: string }, here: string) =>
  sameRepo(repo, here) ? `#${number}` : `${repo}#${number}`

// --- Reading the board ------------------------------------------------------------

const ANY_VALUE = `{ __typename }`

// The two aliased fields of an item: f0 the priority, f1 the size, when they are on it.
const itemFields = (rules: ReadyRules) =>
  [rules.priority, rules.size]
    .map((rule, i) =>
      rule && !rule.onIssue ? `f${i}: fieldValueByName(name:${JSON.stringify(rule.name)}) ${ANY_VALUE}` : '',
    )
    .join(' ')

const STATUS_VALUE = (rules: ReadyRules) =>
  `status: fieldValueByName(name:${JSON.stringify(rules.status.name)}){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }`

const STATUS_FIELD = (rules: ReadyRules) =>
  `field(name:${JSON.stringify(rules.status.name)}){ ... on ProjectV2SingleSelectField{ id options{ id name } } }`

const ISSUE_FIELD_NAME = '{ ... on IssueFieldCommon{ name } }'

const issueFields = (rules: ReadyRules) => `number title state repository{ nameWithOwner } issueType{ name }
  parent{ number } subIssuesSummary{ total completed }
  blockedBy(first:50){ pageInfo{ hasNextPage } nodes{ number state repository{ nameWithOwner } } }
  ${
    rules.priority?.onIssue || rules.size?.onIssue
      ? `issueFieldValues(first:100){ pageInfo{ hasNextPage } nodes{
    ... on IssueFieldDateValue{ field ${ISSUE_FIELD_NAME} }
    ... on IssueFieldMultiSelectValue{ field ${ISSUE_FIELD_NAME} }
    ... on IssueFieldNumberValue{ field ${ISSUE_FIELD_NAME} }
    ... on IssueFieldSingleSelectValue{ field ${ISSUE_FIELD_NAME} }
    ... on IssueFieldTextValue{ field ${ISSUE_FIELD_NAME} } } }`
      : ''
  }`

interface LiveIssue {
  number: number
  title: string
  state: string
  repository: { nameWithOwner: string }
  issueType: { name: string } | null
  parent: { number: number } | null
  subIssuesSummary?: { total: number; completed: number } | null
  blockedBy?: {
    pageInfo: { hasNextPage: boolean }
    nodes: Array<{ number: number; state: string; repository: { nameWithOwner: string } } | null>
  } | null
  issueFieldValues?: {
    pageInfo?: { hasNextPage: boolean }
    nodes: Array<{ field?: { name?: string } | null } | null>
  } | null
}

interface LiveValues {
  id: string
  isArchived?: boolean
  status?: { name?: string } | null
  f0?: unknown
  f1?: unknown
}

interface StatusField {
  id?: string
  options?: Array<{ id: string; name: string }>
}

function factsOf(rules: ReadyRules, issue: LiveIssue, item: LiveValues | null): ReadyFacts {
  const summary = issue.subIssuesSummary
  const onIssue = (issue.issueFieldValues?.nodes ?? []).flatMap((value) =>
    value?.field?.name ? [value.field.name] : [],
  )
  const fields = [rules.priority, rules.size].flatMap((rule, i) => {
    if (!rule) return []
    const set = rule.onIssue ? onIssue.includes(rule.name) : Boolean(item?.[i === 0 ? 'f0' : 'f1'])
    return set ? [rule.name] : []
  })
  return {
    number: issue.number,
    title: issue.title,
    type: issue.issueType?.name ?? null,
    parent: issue.parent?.number ?? null,
    openSubIssues: summary ? summary.total - summary.completed : 0,
    blockers: (issue.blockedBy?.nodes ?? []).map((node) =>
      node ? { number: node.number, repo: node.repository.nameWithOwner, open: isOpen(node.state) } : null,
    ),
    moreBlockers: issue.blockedBy?.pageInfo.hasNextPage ?? false,
    moreFields: issue.issueFieldValues?.pageInfo?.hasNextPage ?? false,
    fields,
  }
}

const isOpen = (state: string) => state.toUpperCase() === 'OPEN'

// What a move writes on the configured Project.
export interface ReadyTarget {
  project: string
  item: string
  field: string
  option: string
}

// The Project does not have what the configuration names: for a person to bring into
// line (lntt board sync), never created here.
export class NotOnBoard extends Error {}

// The option id of the ready status, or an error naming the options the Project has.
function readyOption(rules: ReadyRules, field: StatusField | null | undefined): { field: string; option: string } {
  const { name, ready } = rules.status
  if (!field?.id) throw new NotOnBoard(`the Project has no single select field ${name}`)
  const option = field.options?.find((o) => same(o.name, ready))
  if (!option) {
    throw new NotOnBoard(
      `"${ready}" is not an option of ${name} (${(field.options ?? []).map((o) => o.name).join(', ')})`,
    )
  }
  return { field: field.id, option: option.id }
}

export interface ProjectIssue extends ReadyFacts {
  verdict: Verdict
  target: ReadyTarget
}

// The query that reads a page of the configured Project's items, with the status field.
export function firstStatusQuery(rules: ReadyRules): string {
  const root = rules.project.ownerType === 'user' ? 'user' : 'organization'
  return `query($owner:String!,$number:Int!,$after:String){ ${root}(login:$owner){ projectV2(number:$number){
    id ${STATUS_FIELD(rules)}
    items(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id isArchived ${STATUS_VALUE(rules)} ${itemFields(rules)}
      content{ __typename ... on Issue{ ${issueFields(rules)} } } } } } } }`
}

// The open issues of `repo` at the first status in one page GitHub answered, and the cursor of
// the next page, null at the last: the Project may be shared by an organization's
// repositories, and this configuration speaks for its own.
export function firstStatusPage(
  rules: ReadyRules,
  answer: Record<string, unknown>,
  repo: string,
): { found: ProjectIssue[]; after: string | null } {
  const root = rules.project.ownerType === 'user' ? 'user' : 'organization'
  const project = (
    answer[root] as
      | {
          projectV2: {
            id: string
            field?: StatusField | null
            items: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
              nodes: Array<LiveValues & { content?: (LiveIssue & { __typename: string }) | null }>
            }
          } | null
        }
      | null
      | undefined
  )?.projectV2
  // A Project that does not exist, or one the token cannot see, reads as null.
  if (!project) throw new NotOnBoard(`no Project ${rules.project.number} of ${rules.project.owner}`)
  const where = readyOption(rules, project.field)
  const found: ProjectIssue[] = []
  for (const node of project.items.nodes) {
    const issue = node.content
    if (node.isArchived || issue?.__typename !== 'Issue' || !isOpen(issue.state)) continue
    if (!sameRepo(issue.repository.nameWithOwner, repo)) continue
    if (!same(node.status?.name ?? '', rules.status.initial)) continue
    const facts = factsOf(rules, issue, node)
    found.push({
      ...facts,
      verdict: assess(rules, facts, repo),
      target: { project: project.id, item: node.id, ...where },
    })
  }
  return { found, after: project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null }
}

// The write that moves an item to the ready status.
export const MOVE_TO_READY = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }`

// The move, synchronous, for the candidate's merge until lntt ci moves to Effect (#340); lntt
// board ready writes it through the Gh service (src/board/ready.ts).
export function moveToReady(graphql: Graphql, target: ReadyTarget): void {
  graphql(MOVE_TO_READY, { ...target })
}

// --- One issue, for the candidate's merge -----------------------------------------

export interface Waiting {
  // The closed issue's state as read: only a closed one unblocks anything.
  closed: boolean
  // The open issues of this repository blocked by it: another repository's configuration
  // speaks for that repository's.
  blocked: number[]
  // It blocks more issues than one read holds.
  more: boolean
}

// Who waits on `number`, read with the repository's token.
export function readWaiting(graphql: Graphql, repo: string, number: number): Waiting {
  const [owner, name] = repo.split('/')
  const data = graphql(
    `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){
      state blocking(first:100){ pageInfo{ hasNextPage } nodes{ number state repository{ nameWithOwner } } } } } }`,
    { owner, name, number },
  ).repository as {
    issue: {
      state: string
      blocking: {
        pageInfo: { hasNextPage: boolean }
        nodes: Array<{ number: number; state: string; repository: { nameWithOwner: string } } | null>
      }
    }
  }
  const { issue } = data
  return {
    closed: !isOpen(issue.state),
    blocked: issue.blocking.nodes.flatMap((node) =>
      node && isOpen(node.state) && sameRepo(node.repository.nameWithOwner, repo) ? [node.number] : [],
    ),
    more: issue.blocking.pageInfo.hasNextPage,
  }
}

export interface IssueOnBoard {
  facts: ReadyFacts
  verdict: Verdict
  // The issue's status on the configured Project; null when it is not on it.
  status: string | null
  target: ReadyTarget | null
}

// One issue's facts with the repository's token (`graphql`) and its item on the
// configured Project with the Projects token (`board`).
export function readIssueOnBoard(
  graphql: Graphql,
  board: Graphql,
  rules: ReadyRules,
  repo: string,
  number: number,
): IssueOnBoard {
  const [owner, name] = repo.split('/')
  const issue = (
    graphql(
      `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){ ${issueFields(rules)} } } }`,
      { owner, name, number },
    ).repository as { issue: LiveIssue }
  ).issue
  const items = (
    board(
      `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){
        projectItems(first:50){ nodes{ id isArchived ${STATUS_VALUE(rules)} ${itemFields(rules)}
          project{ id number owner{ ... on Organization{ login } ... on User{ login } } ${STATUS_FIELD(rules)} } } } } } }`,
      { owner, name, number },
    ).repository as {
      issue: {
        projectItems: {
          nodes: Array<
            LiveValues & {
              project: { id: string; number: number; owner?: { login?: string } | null; field?: StatusField | null }
            }
          >
        }
      }
    }
  ).issue.projectItems.nodes
  const item = items.find(
    (node) =>
      !node.isArchived &&
      node.project.number === rules.project.number &&
      same(node.project.owner?.login ?? '', rules.project.owner),
  )
  const facts = factsOf(rules, issue, item ?? null)
  return {
    facts,
    verdict: assess(rules, facts, repo),
    status: item?.status?.name ?? null,
    target: item ? { project: item.project.id, item: item.id, ...readyOption(rules, item.project.field) } : null,
  }
}
