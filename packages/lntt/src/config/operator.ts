// Who is talking to the agent, as plain logic. The profile is personal and never tracked, and git
// worktrees share none of their untracked files, so it is read from places every worktree of a
// project reaches:
//
//   1. ~/.agents/operator.*                                   every project
//   2. <main checkout>/.agents/local/operator.*               this project, found from
//      any worktree through `git rev-parse --git-common-dir`
//   3. ~/.agents/projects/<org>/<repo>/operator.*             this project, when the
//      main checkout has none (a fresh clone, a cloud session)
//
// A project profile wins over the global one key by key. With no profile at all the speaker is
// treated as a developer. No file system and no git here: src/config/load.ts finds and reads the
// files on Effect, src/config/sync.ts for the modules not yet on it.

import { Ajv } from 'ajv'
import schema from '../../schema/operator.schema.json' with { type: 'json' }
import { check, type Located, parse } from '../files.ts'

export type Operator = Record<string, unknown>

export interface Profile {
  profile: Operator
  sources: string[]
}

export const OPERATOR_NAME = 'operator'

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)

const DEFAULT: Operator = { role: 'developer' }

// `<org>/<repo>` from an origin URL (git@host:org/repo.git, https://host/org/repo).
export function slugOf(url: string): string | undefined {
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : undefined
}

// The main checkout of a clone, from its common git directory: none for a bare or separate one.
export function mainCheckout(common: string): string | undefined {
  return common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
}

// One profile file, validated.
export function readProfile(text: string, located: Located): Operator {
  return check(validate, parse(text, located) ?? {}, located.path)
}

function merge(base: Operator, over: Operator): Operator {
  const out: Operator = { ...base }
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key]
    const both = [prev, value].every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
    out[key] = both ? merge(prev as Operator, value as Operator) : value
  }
  return out
}

// The profiles read, the global one first: merged key by key, the later winning; the developer's
// default when there is none.
export function profileOf(read: { path: string; profile: Operator }[]): Profile {
  if (read.length === 0) return { profile: { ...DEFAULT }, sources: [] }
  const profile = read.map((r) => r.profile).reduce(merge, {})
  delete profile.$schema
  return { profile, sources: read.map((r) => r.path) }
}
