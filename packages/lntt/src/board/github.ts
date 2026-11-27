// What `lntt board sync` reads from GitHub and writes to it, each an Effect over GitHub's GraphQL
// API through the Gh service (docs/adr/effect-in-lntt.md#services): the Project and the
// organization's issue types as a BoardState, the counts a removal would touch, and one step of
// the plan. The plan itself is plain logic (src/board.ts).

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { type BoardState, BoardUnread, PAUSE_MS, type Step } from '../board.ts'
import { NotOnBoard } from '../board-ready.ts'
import { Gh } from '../gh/gh.ts'

// The board is not what the configuration names, or not read whole (what the plain logic throws
// as a BoardUnread or a NotOnBoard): an expected failure, said by its message.
export class BoardFailed extends Data.TaggedError('BoardFailed')<{ message: string }> {}

// What `f` gives; what it throws as a BoardUnread or a NotOnBoard is a BoardFailed, anything else
// a defect of lntt.
export const planned = <A>(f: () => A): Effect.Effect<A, BoardFailed> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (error) {
      if (error instanceof BoardUnread || error instanceof NotOnBoard) {
        return Effect.fail(new BoardFailed({ message: error.message }))
      }
      return Effect.die(error)
    }
  })

const FIELDS = `fields(first:100){ pageInfo{ hasNextPage } nodes{
  ... on ProjectV2FieldCommon{ id databaseId name dataType }
  ... on ProjectV2SingleSelectField{ options{ id name color description } } } }`

const NAMES = 'nodes{ ... on ProjectV2FieldCommon{ name } }'
const VIEWS = `views(first:50){ pageInfo{ hasNextPage } nodes{ id number name layout filter
  fields(first:50){ pageInfo{ hasNextPage } ${NAMES} } groupByFields(first:5){ ${NAMES} }
  verticalGroupByFields(first:5){ ${NAMES} } } }`

type Page<T> = { nodes: T[]; pageInfo?: { hasNextPage: boolean } }
type Names = { nodes: { name?: string }[]; pageInfo?: { hasNextPage: boolean } }
type LiveView = {
  id: string
  number: number
  name: string
  layout: string
  filter: string | null
  fields?: Names
  groupByFields?: Names
  verticalGroupByFields?: Names
}
const names = (list?: Names) => (list?.nodes ?? []).flatMap((n) => (n.name ? [n.name] : []))

export interface ProjectRef {
  owner: string
  ownerType?: string
  number: number
}

// The query that reads the Project, its fields and views, and the organization's issue types.
export function boardQuery(project: ProjectRef): string {
  return project.ownerType === 'user'
    ? `query($owner:String!,$number:Int!){ user(login:$owner){ id projectV2(number:$number){ id url ${FIELDS} ${VIEWS} } } }`
    : `query($owner:String!,$number:Int!){ organization(login:$owner){ id projectV2(number:$number){ id url ${FIELDS} ${VIEWS} }
        issueTypes(first:50){ pageInfo{ hasNextPage } nodes{ id name description } } } }`
}

// The board GitHub answered; a missing Project, or one past what one read holds, is a BoardUnread.
export function boardStateOf(data: Record<string, unknown>, project: ProjectRef): BoardState {
  const user = project.ownerType === 'user'
  const owner = data[user ? 'user' : 'organization'] as
    | {
        id: string
        projectV2: {
          id: string
          url: string
          fields: Page<BoardState['fields'][number]>
          views?: Page<LiveView>
        } | null
        issueTypes?: Page<NonNullable<BoardState['issueTypes']>[number]>
      }
    | undefined
  if (!owner?.projectV2) throw new BoardUnread(`no Project ${project.number} of ${project.owner}`)
  // One page each: past it, a field or a type that exists would look missing, and be created again.
  if (owner.projectV2.fields.pageInfo?.hasNextPage)
    throw new BoardUnread('the Project has more than 100 fields: not read whole')
  if (owner.issueTypes?.pageInfo?.hasNextPage)
    throw new BoardUnread('the organization has more than 50 issue types: not read whole')
  return {
    projectId: owner.projectV2.id,
    url: owner.projectV2.url,
    owner: project.owner,
    ownerId: user ? null : owner.id,
    // A field the token cannot see comes back as an empty object.
    fields: owner.projectV2.fields.nodes.filter((f) => f.id),
    issueTypes: user ? null : (owner.issueTypes?.nodes ?? []),
    viewsComplete:
      !owner.projectV2.views?.pageInfo?.hasNextPage &&
      !(owner.projectV2.views?.nodes ?? []).some((v) => v.fields?.pageInfo?.hasNextPage),
    views: (owner.projectV2.views?.nodes ?? []).map((v) => ({
      id: v.id,
      number: v.number,
      name: v.name,
      layout: v.layout,
      filter: v.filter ?? '',
      fields: names(v.fields),
      groupBy: names(v.groupByFields),
      columns: names(v.verticalGroupByFields),
    })),
  }
}

// The Project and the issue types as they are on GitHub.
export const readBoard = Effect.fnUntraced(function* (project: ProjectRef) {
  const data = yield* (yield* Gh).graphql(boardQuery(project), { owner: project.owner, number: project.number })
  return yield* planned(() => boardStateOf(data, project))
})

// What a removal would touch: how many items of the Project hold an option, or how many issues
// of the organization have a type.
export type Removal = { field: string; option: string } | { type: string }

// The counts of the removals a plan has, read only for those: the items of the Project once per
// field (a full read, ~1 point per item), the issues of a type by a search.
export const countRemovals = Effect.fnUntraced(function* (state: BoardState, removals: Removal[]) {
  const gh = yield* Gh
  const values = new Map<string, Map<string, number>>()
  const counts = new Map<string, number>()
  for (const what of removals) {
    if ('type' in what) {
      const data = (yield* gh.graphql('query($q:String!){ search(query:$q, type:ISSUE, first:1){ issueCount } }', {
        q: `org:${state.owner} type:"${what.type}"`,
      })) as { search: { issueCount: number } }
      counts.set(removalKey(what), data.search.issueCount)
      continue
    }
    let held = values.get(what.field)
    if (!held) {
      held = new Map()
      let after: string | null = null
      do {
        const data = (yield* gh.graphql(
          `query($p:ID!,$field:String!,$after:String){ node(id:$p){ ... on ProjectV2{ items(first:100, after:$after){
            pageInfo{ hasNextPage endCursor }
            nodes{ v: fieldValueByName(name:$field){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } }`,
          { p: state.projectId, field: what.field, after },
        )) as {
          node: {
            items: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
              nodes: { v: { name?: string } | null }[]
            }
          }
        }
        for (const item of data.node.items.nodes) {
          if (item.v?.name) held.set(item.v.name, (held.get(item.v.name) ?? 0) + 1)
        }
        after = data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null
      } while (after)
      values.set(what.field, held)
    }
    counts.set(removalKey(what), held.get(what.option) ?? 0)
  }
  return counts
})

export const removalKey = (what: Removal) =>
  'type' in what ? `type\u0000${what.type}` : `option\u0000${what.field}\u0000${what.option}`

const UPDATE_FIELD =
  'mutation($input:UpdateProjectV2FieldInput!){ updateProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }'
const UPDATE_VIEW =
  'mutation($input:UpdateProjectV2ViewInput!){ updateProjectV2View(input:$input){ projectV2View{ id } } }'
const UPDATE_TYPE = 'mutation($input:UpdateIssueTypeInput!){ updateIssueType(input:$input){ issueType{ id } } }'

// The ids of fields by name: from the state read before the run, or asked of the Project for a
// field this run created.
const fieldIds = Effect.fnUntraced(function* (state: BoardState, wanted: string[]) {
  const gh = yield* Gh
  return yield* Effect.forEach(wanted, (name) =>
    Effect.gen(function* () {
      const known = state.fields.find((f) => f.name === name)?.id
      if (known) return known
      const data = (yield* gh.graphql(
        'query($p:ID!,$name:String!){ node(id:$p){ ... on ProjectV2{ field(name:$name){ ... on ProjectV2FieldCommon{ id } } } } }',
        { p: state.projectId, name },
      )) as { node: { field: { id: string } | null } | null }
      if (!data.node?.field) return yield* new BoardFailed({ message: `no field ${name} on the Project` })
      return data.node.field.id
    }),
  )
})

// One step of the plan, written. A view created with a filter takes a second write, after the
// pause GitHub's secondary rate limit asks between writes.
export const applyStep = Effect.fnUntraced(function* (state: BoardState, step: Step) {
  const gh = yield* Gh
  switch (step.kind) {
    case 'createField':
      yield* gh.graphql(
        'mutation($input:CreateProjectV2FieldInput!){ createProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }',
        {
          input: {
            projectId: state.projectId,
            dataType: step.dataType,
            name: step.name,
            ...(step.options ? { singleSelectOptions: step.options } : {}),
          },
        },
      )
      return
    case 'renameField':
      yield* gh.graphql(UPDATE_FIELD, { input: { fieldId: step.fieldId, name: step.to } })
      return
    case 'updateOptions':
      yield* gh.graphql(UPDATE_FIELD, { input: { fieldId: step.fieldId, singleSelectOptions: step.options } })
      return
    case 'createIssueType':
      if (!state.ownerId) {
        return yield* new BoardFailed({ message: 'a Project owned by a user has no issue types' })
      }
      yield* gh.graphql('mutation($input:CreateIssueTypeInput!){ createIssueType(input:$input){ issueType{ id } } }', {
        input: {
          ownerId: state.ownerId,
          name: step.name,
          isEnabled: true,
          color: 'GRAY',
          ...(step.description ? { description: step.description } : {}),
        },
      })
      return
    case 'renameIssueType':
      yield* gh.graphql(UPDATE_TYPE, { input: { issueTypeId: step.id, name: step.to } })
      return
    case 'describeIssueType':
      yield* gh.graphql(UPDATE_TYPE, { input: { issueTypeId: step.id, description: step.description } })
      return
    case 'createView': {
      // The create takes the name, the layout and the visible fields; the filter is set by an
      // update of the new view.
      const configuration = step.fields
        ? { configuration: { visibleFieldIds: yield* fieldIds(state, step.fields) } }
        : {}
      const data = (yield* gh.graphql(
        'mutation($input:CreateProjectV2ViewInput!){ createProjectV2View(input:$input){ projectV2View{ id } } }',
        { input: { projectId: state.projectId, name: step.name, layout: step.layout, ...configuration } },
      )) as { createProjectV2View: { projectV2View: { id: string } } }
      // A new view has no filter: a blank one needs no write.
      if (step.filter?.trim()) {
        yield* Effect.sleep(PAUSE_MS)
        yield* gh.graphql(UPDATE_VIEW, {
          input: { viewId: data.createProjectV2View.projectV2View.id, filter: step.filter },
        })
      }
      return
    }
    case 'updateView': {
      const { fields, ...rest } = step.input
      const configuration = fields ? { configuration: { visibleFieldIds: yield* fieldIds(state, fields) } } : {}
      yield* gh.graphql(UPDATE_VIEW, { input: { viewId: step.id, ...rest, ...configuration } })
      return
    }
  }
})
