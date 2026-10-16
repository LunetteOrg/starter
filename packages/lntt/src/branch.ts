// Branch names: `<type>/<issue>/<slug>`, or `<type>/no-issue/<slug>`, whatever tool
// created the branch. The rules are computed here, so every tool (Orca, Herdr, a git
// hook, CI) asks the same function instead of keeping its own copy of them.

export interface BranchRules {
  // Accepted types: delivery.branches.types, plus the hotfix prefix as one more type.
  types: string[]
  // Branches outside the convention by design, as exact names or prefixes ending in a
  // separator: the base, the candidates, Dependabot's.
  exempt: string[]
}

export type Check = { ok: true } | { ok: false; reason: string; expected?: string }

const DEFAULT_TYPES = ['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'ci', 'perf', 'build']
const NO_ISSUE = 'no-issue'
const MAX_WORDS = 4
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const STOP_WORDS = new Set(
  'a an and are as at be but by for from if in into is it its of on or so than that the this to was were with'.split(
    ' ',
  ),
)

interface Delivery {
  branches?: { types?: string[] }
  candidate?: { base?: string; prefix?: string; hotfix?: { prefix?: string } }
}

export function branchRules(config: { delivery?: Delivery }): BranchRules {
  const delivery = config.delivery ?? {}
  const hotfix = (delivery.candidate?.hotfix?.prefix ?? 'hotfix/').replace(/[/._-]+$/, '')
  const types = [...(delivery.branches?.types ?? DEFAULT_TYPES)]
  if (!types.includes(hotfix)) types.push(hotfix)
  const exempt = [delivery.candidate?.base ?? 'main', delivery.candidate?.prefix ?? 'candidate/', 'dependabot/']
  return { types, exempt }
}

// The first meaningful words of a title, in kebab case: the same title always gives
// the same slug.
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '' && !STOP_WORDS.has(word))
    .slice(0, MAX_WORDS)
    .join('-')
}

// The native issue type first (Bug, Feature, Task), then the labels; feat otherwise.
export function typeFor(issue: { type?: string | null; labels: string[] }): string {
  const native = issue.type?.toLowerCase()
  if (native === 'bug') return 'fix'
  if (native === 'feature') return 'feat'
  if (native === 'task') return 'chore'
  const labels = issue.labels.map((l) => l.toLowerCase())
  if (labels.includes('bug')) return 'fix'
  if (labels.includes('documentation')) return 'docs'
  return 'feat'
}

export function branchName(type: string, issue: number | null, slug: string): string {
  return `${type}/${issue ?? NO_ISSUE}/${slug}`
}

function exempt(name: string, rules: BranchRules): boolean {
  return rules.exempt.some((e) => (/[/._-]$/.test(e) ? name.startsWith(e) : name === e))
}

export function checkBranch(name: string, rules: BranchRules): Check {
  if (exempt(name, rules)) return { ok: true }
  const reason = violation(name, rules)
  if (reason === null) return { ok: true }
  const expected = fromToolName(name, rules)
  return expected ? { ok: false, reason, expected } : { ok: false, reason }
}

// Why a name breaks the convention, or null when it follows it.
function violation(name: string, rules: BranchRules): string | null {
  const parts = name.split('/')
  if (parts.length !== 3) return `${name} is not type/issue/slug`
  const [type, issue, slug] = parts as [string, string, string]
  if (!rules.types.includes(type)) return `type ${type} is not one of ${rules.types.join(', ')}`
  if (issue !== NO_ISSUE && !/^[1-9]\d*$/.test(issue)) return `issue ${issue} is not a number or ${NO_ISSUE}`
  if (!SLUG.test(slug) || slug.split('-').length > MAX_WORDS) {
    return `slug ${slug} is not 1 to ${MAX_WORDS} lower-case words joined by -`
  }
  return null
}

// Reads the convention back from the name a tool gave the branch: Orca's
// `<user>/<type>-<issue>-<slug>` (prefix added, slashes flattened) and the agent
// harness's `worktree-<type>+<issue>+<slug>`. Null when the name holds no type and
// issue to read.
export function fromToolName(name: string, rules: BranchRules): string | null {
  if (violation(name, rules) === null) return name
  const rest = name.replace(/^[^/]+\//, '').replace(/^worktree-/, '')
  const types = rules.types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const match = new RegExp(`^(${types})[-+](\\d+|${NO_ISSUE})[-+](.+)$`).exec(rest)
  if (!match) return null
  const [, type, issue, slug] = match as unknown as [string, string, string, string]
  const candidate = `${type}/${issue}/${slug.replace(/\+/g, '-')}`
  return violation(candidate, rules) === null ? candidate : null
}
