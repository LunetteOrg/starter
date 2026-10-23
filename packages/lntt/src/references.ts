// What the schema cannot say: a value that must name an entry of another list. `lntt
// validate` runs this after the schema; loading and `lntt set` do not, so a status
// option can be renamed in two steps and a reader of the file (commitlint, `lntt ci`)
// never loses the whole configuration over a board typo. Each reference is checked
// only when the list it names is present, and a value left unset is checked by its
// default, which is what the skills will use.

import { CANDIDATE_STATUS } from './ci/config.ts'

// The roles of board.fields.status and their defaults; initial defaults to the first
// option, always one of them.
const STATUS_ROLES: Record<string, string | undefined> = {
  initial: undefined,
  ready: 'Ready',
  inProgress: 'In progress',
  inReview: 'In review',
  done: 'Done',
}

type Tree = Record<string, unknown> | undefined

function at(data: unknown, ...keys: string[]): unknown {
  let value = data
  for (const key of keys) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

// One line per value that names no entry of its list, empty when every reference holds.
export function checkReferences(data: Record<string, unknown>): string[] {
  const wrong: string[] = []
  const expect = (key: string, value: unknown, allowed: string[]) => {
    if (value !== undefined && !allowed.includes(value as string)) {
      wrong.push(`${key} is ${JSON.stringify(value)}, not one of: ${allowed.join(', ')}`)
    }
  }

  const status = at(data, 'board', 'fields', 'status') as Tree
  const options = status?.options as string[] | undefined
  if (status && options) {
    for (const [role, fallback] of Object.entries(STATUS_ROLES)) {
      expect(`board.fields.status.${role}`, status[role] ?? fallback, options)
    }
    const candidate = at(data, 'delivery', 'candidate') as Tree
    if (candidate) {
      const named = { ...CANDIDATE_STATUS, ...(candidate.status as Tree) }
      for (const [key, value] of Object.entries(named)) expect(`delivery.candidate.status.${key}`, value, options)
    }
  }

  // Only parents carry the horizon, and only children an iteration: checked here, not
  // by the schema, so a file an older lntt accepted still loads.
  const horizon = at(data, 'board', 'fields', 'horizon') as Tree
  if (horizon) {
    expect('board.fields.horizon.type', horizon.type, ['singleSelect'])
    expect('board.fields.horizon.on', horizon.on ?? 'parents', ['parents'])
  }
  const iteration = at(data, 'board', 'fields', 'iteration') as Tree
  if (iteration) {
    expect('board.fields.iteration.type', iteration.type, ['iteration'])
    expect('board.fields.iteration.on', iteration.on ?? 'children', ['children'])
  }

  for (const [key, field] of Object.entries((at(data, 'board', 'fields') ?? {}) as Record<string, Tree>)) {
    const options = (field?.options ?? []) as string[]
    for (const name of Object.keys((field?.colors ?? {}) as Record<string, string>)) {
      if (!options.includes(name)) {
        wrong.push(`board.fields.${key}.colors.${name} names no option of the field: ${options.join(', ')}`)
      }
    }
  }

  const types = at(data, 'board', 'issueTypes') as Tree
  for (const type of (types?.permanent ?? []) as string[]) {
    expect('board.issueTypes.permanent', type, (types?.parents ?? []) as string[])
  }

  const listed = [...((types?.parents ?? []) as string[]), ...((types?.children ?? []) as string[])]
  for (const name of Object.keys((types?.descriptions ?? {}) as Record<string, string>)) {
    if (!listed.includes(name))
      wrong.push(`board.issueTypes.descriptions.${name} names no type of the board: ${listed.join(', ')}`)
  }

  const members = at(data, 'team', 'members') as Tree
  if (members) {
    const labels = (at(data, 'board', 'tracks', 'labels') ?? {}) as Record<string, Tree>
    for (const [name, label] of Object.entries(labels)) {
      expect(`board.tracks.labels.${name}.owner`, label?.owner, Object.keys(members))
    }
  }

  const lines = at(data, 'delivery', 'pullRequest', 'retrospective', 'lines') as string[] | undefined
  if (lines)
    expect(
      'cycle.retrospective.targetedReview.line',
      at(data, 'cycle', 'retrospective', 'targetedReview', 'line'),
      lines,
    )

  return wrong
}

// One line per key the board skills need and the configuration lacks, empty when none
// is missing. Checked here and not by the schema, so a board written in steps still
// loads for every other reader.
export function checkMissing(data: Record<string, unknown>): string[] {
  const missing: string[] = []
  if (at(data, 'board') !== undefined && at(data, 'board', 'fields', 'horizon') === undefined) {
    missing.push(
      'board.fields.horizon is missing: every board plans on its horizon, with the status, the priority and the issue type',
    )
  }
  return missing
}
