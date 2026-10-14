// The branch and path filters of a GitHub Actions trigger, matched as GitHub does:
// patterns in order, a `!` pattern excludes, the last pattern that matches wins.
// `*` stops at a slash, `**` crosses it.

export interface BranchFilters {
  branches?: string[]
  'branches-ignore'?: string[]
}

export interface PathFilters {
  paths?: string[]
  'paths-ignore'?: string[]
}

export interface FilterResult {
  match: boolean
  // The filter could not be evaluated (no diff to read): it is taken as a match.
  unknown?: boolean
}

export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` also matches nothing, so `**/*.md` takes a file at the root.
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

// Whether `value` is included by `patterns`, where `!` patterns exclude.
function included(patterns: string[], value: string): boolean {
  let result = false
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    if (globToRegExp(negated ? pattern.slice(1) : pattern).test(value)) result = !negated
  }
  return result
}

export function branchFilter(filters: BranchFilters, branch: string): FilterResult {
  if (filters.branches) return { match: included(filters.branches, branch) }
  if (filters['branches-ignore']) return { match: !included(filters['branches-ignore'], branch) }
  return { match: true }
}

export function pathFilter(filters: PathFilters, changed: string[] | null): FilterResult {
  if (!filters.paths && !filters['paths-ignore']) return { match: true }
  if (changed === null) return { match: true, unknown: true }
  if (filters.paths) {
    const paths = filters.paths
    return { match: changed.some((file) => included(paths, file)) }
  }
  const ignored = filters['paths-ignore'] ?? []
  return { match: changed.some((file) => !included(ignored, file)) }
}
