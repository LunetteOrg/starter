// Who is talking to the agent. The profile is personal and never tracked, and git
// worktrees share none of their untracked files, so it is read from places every
// worktree of a project reaches:
//
//   1. ~/.agents/operator.*                                   every project
//   2. <main checkout>/.agents/local/operator.*               this project, found from
//      any worktree through `git rev-parse --git-common-dir`
//   3. ~/.agents/projects/<org>/<repo>/operator.*             this project, when the
//      main checkout has none (a fresh clone, a cloud session)
//
// A project profile wins over the global one key by key. With no profile at all the
// speaker is treated as a developer.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import schema from '../schema/operator.schema.json' with { type: 'json' }
import { check, type Located, locate, parse } from './files.ts'

export type Operator = Record<string, unknown>

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)

const DEFAULT: Operator = { role: 'developer' }

function gitOut(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

// `<org>/<repo>` from the origin URL (git@host:org/repo.git, https://host/org/repo).
function slug(cwd: string): string | undefined {
  const url = gitOut(cwd, 'remote', 'get-url', 'origin')
  const match = url?.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : undefined
}

function projectProfile(cwd: string, home: string): Located | undefined {
  const common = gitOut(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) return undefined
  if (common.endsWith('/.git')) {
    const local = locate(join(common.slice(0, -'/.git'.length), '.agents', 'local'), 'operator')
    if (local) return local
  }
  const repo = slug(cwd)
  return repo ? locate(join(home, '.agents', 'projects', repo), 'operator') : undefined
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

export function loadOperator(cwd: string, options: { home?: string } = {}): { profile: Operator; sources: string[] } {
  const home = options.home ?? homedir()
  const sources = [locate(join(home, '.agents'), 'operator'), projectProfile(cwd, home)].filter(
    (l): l is Located => l !== undefined,
  )
  if (sources.length === 0) return { profile: { ...DEFAULT }, sources: [] }
  const profile = sources
    .map((l) => check(validate, parse(readFileSync(l.path, 'utf8'), l) ?? {}, l.path))
    .reduce(merge, {})
  delete profile.$schema
  return { profile, sources: sources.map((l) => l.path) }
}
