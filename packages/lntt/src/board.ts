// `lntt board sync`: brings a GitHub Project and its organization's issue types to the
// state the `board` section declares (usage: bin/lntt.ts). It only adds: a missing
// field with its options, a missing option, a missing issue type, an issue type's
// description. A rename or a removal is left to GitHub's UI, with the reason: a field
// or a type the API renames is a new one to GitHub's readers, and a removal clears the
// value from every item or issue that has it.
//
// The plan is computed from what GitHub shows (readBoard) and the configuration
// (planBoard), then applied one write at a time (applyStep), each through `gh api
// graphql`. Adding options keeps every existing option by its id, the input GitHub
// documents as "preserving the option's identity during updates, preventing item field
// values from being cleared".

import { spawnSync } from 'node:child_process'

export interface LiveOption {
  id: string
  name: string
  color: string
  description: string
}

export interface BoardState {
  projectId: string
  // The organization's node id, which creates an issue type; null for a user's Project.
  ownerId: string | null
  fields: { id: string; name: string; dataType: string; options?: LiveOption[] }[]
  // null for a user's Project: issue types belong to an organization.
  issueTypes: { id: string; name: string; description: string | null }[] | null
}

type NewOption = { name: string; color: string; description: string }

export type Step =
  | { kind: 'createField'; key: string; name: string; dataType: string; options?: string[] }
  | {
      kind: 'addOptions'
      key: string
      fieldId: string
      name: string
      add: string[]
      options: (LiveOption | NewOption)[]
    }
  | { kind: 'createIssueType'; name: string; description?: string }
  | { kind: 'describeIssueType'; id: string; name: string; description: string }

// What the command leaves to a person, and why.
export interface Manual {
  what: string
  why: string
}

interface FieldConfig {
  name: string
  type: string
  kind?: string
  options?: string[]
}

export interface BoardConfig {
  issueTypes?: { parents?: string[]; children?: string[]; descriptions?: Record<string, string> }
  fields?: Record<string, FieldConfig>
}

// The GitHub data type of each field type the configuration names.
const DATA_TYPES: Record<string, string> = {
  singleSelect: 'SINGLE_SELECT',
  date: 'DATE',
  number: 'NUMBER',
  text: 'TEXT',
  iteration: 'ITERATION',
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function planBoard(board: BoardConfig, state: BoardState): { steps: Step[]; manual: Manual[] } {
  const steps: Step[] = []
  const manual: Manual[] = []

  for (const [key, field] of Object.entries(board.fields ?? {})) {
    if (field.kind === 'issue') continue // an organization's issue field, not the Project's
    const live = state.fields.find((f) => f.name === field.name) ?? state.fields.find((f) => same(f.name, field.name))
    if (!live) {
      if (field.type === 'iteration') {
        manual.push({
          what: `create the field ${field.name} (iteration)`,
          why: "an iteration field is created with its iterations, in the Project's settings",
        })
      } else {
        steps.push({
          kind: 'createField',
          key,
          name: field.name,
          dataType: DATA_TYPES[field.type],
          ...(field.type === 'singleSelect' ? { options: field.options ?? [] } : {}),
        })
      }
      continue
    }
    if (live.name !== field.name) {
      manual.push({
        what: `rename the field "${live.name}" → "${field.name}"`,
        why: "board.fields names it so; rename it in the field's settings",
      })
      continue
    }
    if (live.dataType !== DATA_TYPES[field.type]) {
      manual.push({
        what: `the field ${field.name} is ${live.dataType} on the Project, ${field.type} in board.fields.${key}`,
        why: 'a field never changes type: create it anew in the UI and move the values, or correct the configuration',
      })
      continue
    }
    if (field.type !== 'singleSelect') continue

    const options = live.options ?? []
    const matched = new Set<string>()
    const add: string[] = []
    const next: (LiveOption | NewOption)[] = []
    for (const name of field.options ?? []) {
      const exact = options.find((o) => o.name === name)
      const cased = exact ?? options.find((o) => same(o.name, name))
      if (cased) {
        matched.add(cased.id)
        next.push(cased)
        if (!exact) {
          manual.push({
            what: `${field.name}: rename the option "${cased.name}" → "${name}"`,
            why: "rename it in the field's settings, which keeps its id and every item's value",
          })
        }
      } else {
        add.push(name)
        next.push({ name, color: 'GRAY', description: '' })
      }
    }
    for (const option of options.filter((o) => !matched.has(o.id))) {
      next.push(option)
      manual.push({
        what: `${field.name}: the option "${option.name}" is not in board.fields.${key}`,
        why: 'remove it in the UI only if no item needs it: removing an option clears it from every item that has it',
      })
    }
    if (add.length > 0) steps.push({ kind: 'addOptions', key, fieldId: live.id, name: field.name, add, options: next })
  }

  const types = board.issueTypes
  if (types) {
    const wanted = [...new Set([...(types.parents ?? []), ...(types.children ?? [])])]
    if (state.issueTypes === null) {
      manual.push({
        what: `the issue types ${wanted.join(', ')}`,
        why: 'a Project owned by a user has no issue types: they belong to an organization',
      })
    } else {
      const live = state.issueTypes
      const matched = new Set<string>()
      const describe: Step[] = []
      for (const name of wanted) {
        const exact = live.find((t) => t.name === name)
        const cased = exact ?? live.find((t) => same(t.name, name))
        const description = types.descriptions?.[name]
        if (!cased) {
          steps.push({ kind: 'createIssueType', name, ...(description ? { description } : {}) })
          continue
        }
        matched.add(cased.id)
        if (!exact) {
          manual.push({
            what: `rename the issue type "${cased.name}" → "${name}"`,
            why: "rename it in the organization's settings (Planning › Issue types), which keeps it on every issue",
          })
        } else if (description && cased.description !== description) {
          describe.push({ kind: 'describeIssueType', id: cased.id, name, description })
        }
      }
      steps.push(...describe)
      for (const type of live.filter((t) => !matched.has(t.id))) {
        manual.push({
          what: `the issue type ${type.name} is not in board.issueTypes`,
          why: "disable or remove it in the organization's settings only if no issue uses it: removing a type takes it off every issue of the organization",
        })
      }
    }
  }
  return { steps, manual }
}

// One request to GitHub's GraphQL API: its data, or an error with gh's message.
export type Graphql = (query: string, variables: Record<string, unknown>) => Record<string, unknown>

export const ghGraphql: Graphql = (query, variables) => {
  const run = spawnSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    encoding: 'utf8',
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error((run.stderr || run.stdout).trim())
  const body = JSON.parse(run.stdout) as { data?: Record<string, unknown>; errors?: { message: string }[] }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  return body.data ?? {}
}

const FIELDS = `fields(first:100){ nodes{
  ... on ProjectV2FieldCommon{ id name dataType }
  ... on ProjectV2SingleSelectField{ options{ id name color description } } } }`

export function readBoard(
  graphql: Graphql,
  project: { owner: string; ownerType?: string; number: number },
): BoardState {
  const user = project.ownerType === 'user'
  const query = user
    ? `query($owner:String!,$number:Int!){ user(login:$owner){ id projectV2(number:$number){ id ${FIELDS} } } }`
    : `query($owner:String!,$number:Int!){ organization(login:$owner){ id projectV2(number:$number){ id ${FIELDS} }
        issueTypes(first:50){ nodes{ id name description } } } }`
  const data = graphql(query, { owner: project.owner, number: project.number })
  const owner = data[user ? 'user' : 'organization'] as
    | {
        id: string
        projectV2: { id: string; fields: { nodes: BoardState['fields'] } } | null
        issueTypes?: { nodes: NonNullable<BoardState['issueTypes']> }
      }
    | undefined
  if (!owner?.projectV2) throw new Error(`no Project ${project.number} of ${project.owner}`)
  return {
    projectId: owner.projectV2.id,
    ownerId: user ? null : owner.id,
    // A field the token cannot see comes back as an empty object.
    fields: owner.projectV2.fields.nodes.filter((f) => f.id),
    issueTypes: user ? null : (owner.issueTypes?.nodes ?? []),
  }
}

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'createField': {
      const type = { SINGLE_SELECT: 'single select', DATE: 'date', NUMBER: 'number', TEXT: 'text' }[step.dataType]
      return `create field ${step.name} (${type})${step.options ? `: ${step.options.join(', ')}` : ''}`
    }
    case 'addOptions':
      return `add options to ${step.name}: ${step.add.join(', ')}`
    case 'createIssueType':
      return `create issue type ${step.name}${step.description ? `: ${step.description}` : ''}`
    case 'describeIssueType':
      return `describe issue type ${step.name}: ${step.description}`
  }
}

export function applyStep(graphql: Graphql, state: BoardState, step: Step): void {
  switch (step.kind) {
    case 'createField':
      graphql(
        'mutation($input:CreateProjectV2FieldInput!){ createProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }',
        {
          input: {
            projectId: state.projectId,
            dataType: step.dataType,
            name: step.name,
            ...(step.options
              ? { singleSelectOptions: step.options.map((name) => ({ name, color: 'GRAY', description: '' })) }
              : {}),
          },
        },
      )
      break
    case 'addOptions':
      graphql(
        'mutation($input:UpdateProjectV2FieldInput!){ updateProjectV2Field(input:$input){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }',
        { input: { fieldId: step.fieldId, singleSelectOptions: step.options } },
      )
      break
    case 'createIssueType':
      if (!state.ownerId) throw new Error('a Project owned by a user has no issue types')
      graphql('mutation($input:CreateIssueTypeInput!){ createIssueType(input:$input){ issueType{ id } } }', {
        input: {
          ownerId: state.ownerId,
          name: step.name,
          isEnabled: true,
          color: 'GRAY',
          ...(step.description ? { description: step.description } : {}),
        },
      })
      break
    case 'describeIssueType':
      graphql('mutation($input:UpdateIssueTypeInput!){ updateIssueType(input:$input){ issueType{ id } } }', {
        input: { issueTypeId: step.id, description: step.description },
      })
      break
  }
}
