// `lntt board sync`: brings a GitHub Project and its organization's issue types to the
// state the `board` section declares (usage: bin/lntt.ts). Through the API it adds a
// missing field with its options, a missing option, a missing issue type; it sets the
// colors of `board.fields.<key>.colors` and the descriptions of
// `board.issueTypes.descriptions`; it renames a field, an option or a type that differs
// only in case. Each keeps its id, so no item or issue loses a value: an option is
// written back with its id, the input GitHub documents as "preserving the option's
// identity during updates, preventing item field values from being cleared".
//
// What the API cannot do (change a field's type, create an iteration field without its
// iterations) or what is risky (remove an option or a type: the value goes from every
// item or issue that has it) is left to a person, with the reason, the count it
// touches, the settings page and the steps.
//
// The plan is computed from what GitHub shows and the configuration (planBoard, plain
// logic here), then applied one write at a time; the reads and the writes are Effects
// over the Gh service (src/board/github.ts), the command src/board/command.ts.

// The Project is not what the configuration names, or not read whole: said as it is.
export class BoardUnread extends Error {}

export interface LiveOption {
  id: string
  name: string
  color: string
  description: string
}

export interface BoardState {
  projectId: string
  // The Project's page, which its settings pages start from.
  url: string
  owner: string
  // The organization's node id, which creates an issue type; null for a user's Project.
  ownerId: string | null
  fields: { id: string; databaseId: number; name: string; dataType: string; options?: LiveOption[] }[]
  // null for a user's Project: issue types belong to an organization.
  issueTypes: { id: string; name: string; description: string | null }[] | null
  // false when the Project has more views (or a view more visible fields) than one read
  // holds: a board that declares views stops rather than recreate one it did not see.
  viewsComplete: boolean
  // The Project's views; fields, groupBy and columns by field name, in their order.
  views: {
    id: string
    number: number
    name: string
    layout: string
    filter: string
    fields: string[]
    groupBy: string[]
    columns: string[]
  }[]
}

type NewOption = { name: string; color: string; description: string }

export type Step =
  | { kind: 'createField'; key: string; name: string; dataType: string; options?: NewOption[] }
  | { kind: 'renameField'; fieldId: string; from: string; to: string }
  | {
      kind: 'updateOptions'
      key: string
      fieldId: string
      name: string
      // What the update does, one entry per option it adds, renames or recolors.
      changes: string[]
      options: (LiveOption | NewOption)[]
    }
  | { kind: 'createIssueType'; name: string; description?: string }
  | { kind: 'renameIssueType'; id: string; from: string; to: string }
  | { kind: 'describeIssueType'; id: string; name: string; description: string }
  | { kind: 'createView'; name: string; layout: string; filter?: string; fields?: string[] }
  | {
      kind: 'updateView'
      id: string
      name: string
      changes: string[]
      // fields by name: their ids are resolved when the step is applied, so a field the
      // same run creates can be named.
      input: { name?: string; layout?: string; filter?: string; fields?: string[] }
    }

// What the command leaves to a person: why, where and how.
export interface Manual {
  what: string
  why: string
  url: string | null
  steps: string[]
}

// How many items of the Project hold an option, or how many issues of the organization
// have a type: what a removal would touch.
export type Count = (what: { field: string; option: string } | { type: string }) => number

interface FieldConfig {
  name: string
  type: string
  kind?: string
  options?: string[]
  colors?: Record<string, string>
}

interface ViewConfig {
  name: string
  layout: 'table' | 'board' | 'roadmap'
  filter?: string
  fields?: string[]
  groupBy?: string
  columns?: string
}

export interface BoardConfig {
  github?: { project?: unknown; views?: ViewConfig[] }
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

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? ' has' : 's have'} it`

export function planBoard(board: BoardConfig, state: BoardState, count: Count): { steps: Step[]; manual: Manual[] } {
  const steps: Step[] = []
  const manual: Manual[] = []
  const fieldPage = (databaseId: number) => `${state.url}/settings/fields/${databaseId}`

  for (const [key, field] of Object.entries(board.fields ?? {})) {
    if (field.kind === 'issue') continue // an organization's issue field, not the Project's
    const colors = field.colors ?? {}
    const live = state.fields.find((f) => f.name === field.name) ?? state.fields.find((f) => same(f.name, field.name))
    if (!live) {
      if (field.type === 'iteration') {
        manual.push({
          what: `create the field ${field.name} (iteration)`,
          why: 'an iteration field is created with its iterations (a start and a length) the configuration does not give',
          url: `${state.url}/settings`,
          steps: [
            `New field, type Iteration, named "${field.name}"`,
            'Set the start date and the length of the iterations, then Save',
          ],
        })
      } else {
        steps.push({
          kind: 'createField',
          key,
          name: field.name,
          dataType: DATA_TYPES[field.type],
          ...(field.type === 'singleSelect'
            ? {
                options: (field.options ?? []).map((name) => ({
                  name,
                  color: colors[name] ?? 'GRAY',
                  description: '',
                })),
              }
            : {}),
        })
      }
      continue
    }
    if (live.dataType !== DATA_TYPES[field.type]) {
      manual.push({
        what: `the field ${live.name} is ${live.dataType} on the Project, ${field.type} in board.fields.${key}`,
        why: "the API never changes a field's type: a new field takes the values by hand, or the configuration is corrected",
        url: fieldPage(live.databaseId),
        steps: [
          `Create a field of type ${field.type} (the Project's settings, New field), then move each item's value to it`,
          `Delete the old field, and give the new one the name "${field.name}"`,
        ],
      })
      continue
    }
    if (live.name !== field.name) steps.push({ kind: 'renameField', fieldId: live.id, from: live.name, to: field.name })
    if (field.type !== 'singleSelect') continue

    const options = live.options ?? []
    const matched = new Set<string>()
    const changes: string[] = []
    const next: (LiveOption | NewOption)[] = []
    for (const name of field.options ?? []) {
      const found = options.find((o) => o.name === name) ?? options.find((o) => same(o.name, name))
      if (!found) {
        changes.push(`add "${name}"`)
        next.push({ name, color: colors[name] ?? 'GRAY', description: '' })
        continue
      }
      matched.add(found.id)
      const option = { ...found }
      if (option.name !== name) {
        changes.push(`rename "${option.name}" → "${name}"`)
        option.name = name
      }
      if (colors[name] && option.color !== colors[name]) {
        changes.push(`color "${name}" ${colors[name]}`)
        option.color = colors[name]
      }
      next.push(option)
    }
    for (const option of options.filter((o) => !matched.has(o.id))) {
      next.push(option)
      const held = count({ field: live.name, option: option.name })
      manual.push({
        what: `${live.name}: the option "${option.name}" is not in board.fields.${key}`,
        why: `removing it clears it from every item that has it, and ${plural(held, 'item')}: a person decides, or the configuration lists it`,
        url: fieldPage(live.databaseId),
        steps: [
          `Filter the Project with ${live.name}:"${option.name}" and move each item to another option`,
          `In the field's settings, delete the option "${option.name}"`,
        ],
      })
    }
    if (changes.length > 0) {
      steps.push({ kind: 'updateOptions', key, fieldId: live.id, name: field.name, changes, options: next })
    }
  }

  const types = board.issueTypes
  if (types) {
    const wanted = [...new Set([...(types.parents ?? []), ...(types.children ?? [])])]
    if (state.issueTypes === null) {
      manual.push({
        what: `the issue types ${wanted.join(', ')}`,
        why: 'a Project owned by a user has no issue types: they belong to an organization, so board.issueTypes cannot hold here',
        url: null,
        steps: ['Move the Project to an organization, or remove board.issueTypes from the configuration'],
      })
    } else {
      const live = state.issueTypes
      const matched = new Set<string>()
      const after: Step[] = []
      for (const name of wanted) {
        const found = live.find((t) => t.name === name) ?? live.find((t) => same(t.name, name))
        const description = types.descriptions?.[name]
        if (!found) {
          steps.push({ kind: 'createIssueType', name, ...(description ? { description } : {}) })
          continue
        }
        matched.add(found.id)
        if (found.name !== name) after.push({ kind: 'renameIssueType', id: found.id, from: found.name, to: name })
        if (description && (found.description ?? '').trim() !== description.trim()) {
          after.push({ kind: 'describeIssueType', id: found.id, name, description })
        }
      }
      steps.push(...after)
      for (const type of live.filter((t) => !matched.has(t.id))) {
        const held = count({ type: type.name })
        manual.push({
          what: `the issue type ${type.name} is not in board.issueTypes`,
          why: `removing it takes it off every issue of the organization, and ${plural(held, 'issue')}: a person decides, or the configuration lists it`,
          url: `https://github.com/organizations/${state.owner}/settings/issue-types`,
          steps: [
            `Search the organization's issues with type:"${type.name}" and give each another type`,
            `Disable or delete the type ${type.name}`,
          ],
        })
      }
    }
  }
  planViews(board.github?.views ?? [], state, steps, manual)
  return { steps, manual }
}

const LAYOUTS: Record<string, string> = { table: 'TABLE_LAYOUT', board: 'BOARD_LAYOUT', roadmap: 'ROADMAP_LAYOUT' }

// The views the configuration names: what the API sets (name, layout, filter, visible
// fields) as steps, the grouping and the columns it cannot set as entries for a person.
// A key a view leaves out is not managed; a view the configuration does not name is
// left alone.
function planViews(views: ViewConfig[], state: BoardState, steps: Step[], manual: Manual[]): void {
  if (views.length > 0 && !state.viewsComplete) {
    throw new BoardUnread('the Project has more than 50 views, or a view more than 50 visible fields: not read whole')
  }
  // The fields the Project has, and those this run creates before the views.
  const known = new Set([
    ...state.fields.map((f) => f.name),
    ...steps.flatMap((s) => (s.kind === 'createField' ? [s.name] : [])),
  ])
  const filterOf = (filter: string) => filter.trim().replace(/\s+/g, ' ')
  const used = new Set<string>()
  // Each live view answers one configured view, an exact name before a case match.
  const claim = (name: string) => {
    const free = state.views.filter((v) => !used.has(v.id))
    const live = free.find((v) => v.name === name) ?? free.find((v) => same(v.name, name))
    if (live) used.add(live.id)
    return live
  }
  for (const view of views) used.add(state.views.find((v) => v.name === view.name)?.id ?? '')
  used.delete('')
  for (const view of views) {
    const layout = LAYOUTS[view.layout]
    const unknown = [view.groupBy, view.columns, ...(view.fields ?? [])].filter(
      (name): name is string => name !== undefined && !known.has(name),
    )
    if (unknown.length > 0) {
      for (const name of unknown) {
        manual.push({
          what: `the view ${view.name} names the field ${name}, which the Project does not have`,
          why: 'a view shows or groups by fields of its Project only: the configuration names another one',
          url: `${state.url}/settings`,
          steps: [`Correct board.github.views, or create the field ${name}`],
        })
      }
      continue
    }
    const exact = state.views.find((v) => v.name === view.name)
    const live = exact ?? claim(view.name)
    const page = live ? `${state.url}/views/${live.number}` : `${state.url}/views`
    if (!live) {
      steps.push({
        kind: 'createView',
        name: view.name,
        layout,
        // A new view has no filter: a blank one is none.
        ...(view.filter?.trim() ? { filter: view.filter.trim() } : {}),
        ...(view.fields ? { fields: view.fields } : {}),
      })
    } else {
      const changes: string[] = []
      const input: Extract<Step, { kind: 'updateView' }>['input'] = {}
      if (live.name !== view.name) {
        changes.push(`rename "${live.name}" → "${view.name}"`)
        input.name = view.name
      }
      if (live.layout !== layout) {
        changes.push(`layout ${layout}`)
        input.layout = layout
      }
      if (view.filter !== undefined && filterOf(live.filter) !== filterOf(view.filter)) {
        // Written trimmed; a blank filter clears the view's.
        const filter = view.filter.trim()
        changes.push(filter ? `filter "${filter}"` : 'clear filter')
        input.filter = filter
      }
      if (view.fields && live.fields.join('\n') !== view.fields.join('\n')) {
        changes.push(`fields ${view.fields.join(', ')}`)
        input.fields = view.fields
      }
      if (changes.length > 0) steps.push({ kind: 'updateView', id: live.id, name: view.name, changes, input })
    }
    const grouping = (key: 'groupBy' | 'columns', verb: string, menu: string) => {
      const wanted = view[key]
      const has = live?.[key] ?? []
      if (wanted === undefined || (has.length === 1 && has[0] === wanted)) return
      manual.push({
        what: `the view ${view.name} ${verb} ${has.length ? has.join(', ') : '(none)'}, board.github.views says ${wanted}`,
        why: `the API sets no view's ${key === 'groupBy' ? 'grouping' : 'columns'}: it is set in the view, in the UI`,
        url: page,
        steps: [
          `Open the view ${view.name}${live ? '' : ' (after --apply creates it)'}, then its menu (the arrow beside its name)`,
          `${menu} → ${wanted}`,
          'Save the changes to the view',
        ],
      })
    }
    grouping('groupBy', 'groups by', 'Group by')
    if (view.layout === 'board') grouping('columns', 'has columns by', 'Column by')
  }
}

const optionText = (o: { name: string; color: string }) => (o.color === 'GRAY' ? o.name : `${o.name} ${o.color}`)

export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'createField': {
      const type = { SINGLE_SELECT: 'single select', DATE: 'date', NUMBER: 'number', TEXT: 'text' }[step.dataType]
      return `create field ${step.name} (${type})${step.options ? `: ${step.options.map(optionText).join(', ')}` : ''}`
    }
    case 'renameField':
      return `rename field "${step.from}" → "${step.to}"`
    case 'updateOptions':
      return `update options of ${step.name}: ${step.changes.join(', ')}`
    case 'createIssueType':
      return `create issue type ${step.name}${step.description ? `: ${step.description}` : ''}`
    case 'renameIssueType':
      return `rename issue type "${step.from}" → "${step.to}"`
    case 'describeIssueType':
      return `describe issue type ${step.name}: ${step.description}`
    case 'createView': {
      const parts = [
        ...(step.filter?.trim() ? [`filter "${step.filter}"`] : []),
        ...(step.fields ? [`fields ${step.fields.join(', ')}`] : []),
      ]
      return `create view ${step.name} (${step.layout})${parts.length ? `: ${parts.join(', ')}` : ''}`
    }
    case 'updateView':
      return `update view ${step.name}: ${step.changes.join(', ')}`
  }
}

// Between two writes: GitHub's secondary rate limit drops writes sent faster, and does
// not show in rate_limit.
export const PAUSE_MS = 1200
