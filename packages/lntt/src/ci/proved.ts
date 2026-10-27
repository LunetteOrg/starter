// `lntt ci proved`: whether a push's tree is one a pull request's CI has already proved
// green, read from the GitHub API (docs/process/ci.md#a-tree-already-proved). It answers
// *proved* only when every condition holds; anything else, an API error included, is
// *not proved*, and the caller runs the whole job.

import type { Gh } from './candidate.ts'

export interface ProvedInput {
  repo: string
  // The pushed commit and the commit the branch pointed at before the push.
  sha: string
  before: string
  // The branch pushed to: the pull request must have been merged into it.
  branch: string
  // The workflow file whose pull request run proves the tree, and its jobs that must
  // all be green in that run.
  workflow: string
  jobs: string[]
  // A step every job must have run green: the marker of the level that proves (a step
  // that runs only at the full level). Without one, the green jobs prove.
  step?: string | undefined
}

export interface Proved {
  proved: boolean
  reason: string
}

const SHA = /^[0-9a-f]{40}$/
const NO_COMMIT = /^0{40}$/
// The events of a pull request's run: a push run on the head proves nothing about the
// merge ref a pull request tests.
const PR_EVENTS = new Set(['pull_request', 'pull_request_review'])

function fail(reason: string): never {
  throw new Error(reason)
}

function api<T>(gh: Gh, path: string): T {
  return JSON.parse(gh.read(['api', path])) as T
}

function treeOf(gh: Gh, repo: string, sha: string): string {
  const tree = api<{ tree?: { sha?: unknown } | null }>(gh, `repos/${repo}/git/commits/${sha}`).tree?.sha
  if (typeof tree !== 'string' || !SHA.test(tree)) fail(`no tree for ${sha}`)
  return tree
}

interface PullRequest {
  number: number
  merged_at: string | null
  base: { ref: string }
  head: { sha: string }
}

interface WorkflowRun {
  id: number
  event: string
  status: string
  conclusion: string | null
  html_url?: string
}

interface RunJob {
  name: string
  conclusion: string | null
  steps?: Array<{ name: string; conclusion: string | null }>
}

// The run's jobs are all green, and each ran the marker step green.
function runProves(gh: Gh, input: ProvedInput, run: WorkflowRun): boolean {
  if (!PR_EVENTS.has(run.event) || run.status !== 'completed') return false
  const { jobs } = api<{ jobs: RunJob[] }>(gh, `repos/${input.repo}/actions/runs/${run.id}/jobs?per_page=100`)
  return input.jobs.every((name) => {
    const job = jobs.find((j) => j.name === name)
    if (job?.conclusion !== 'success') return false
    if (input.step === undefined) return true
    return (job?.steps ?? []).some((s) => s.name === input.step && s.conclusion === 'success')
  })
}

function prove(gh: Gh, input: ProvedInput): string {
  const { repo, sha, before, branch } = input
  if (!SHA.test(sha)) fail(`the pushed sha is not a commit id: ${sha}`)
  if (input.jobs.length === 0) fail('no job named: give --job')
  if (!SHA.test(before) || NO_COMMIT.test(before)) fail(`no previous tip of ${branch} to compare with`)

  const merged = api<PullRequest[]>(gh, `repos/${repo}/commits/${sha}/pulls`).filter(
    (pr) => pr.merged_at !== null && pr.base?.ref === branch,
  )
  if (merged.length === 0) fail(`no merged pull request into ${branch} explains ${sha}`)
  if (merged.length > 1)
    fail(`more than one merged pull request explains ${sha}: ${merged.map((p) => `#${p.number}`).join(', ')}`)
  const [pr] = merged as [PullRequest]
  const head = pr.head.sha
  if (!SHA.test(head)) fail(`#${pr.number} has no head commit`)

  // The same tree as the head the pull request ran on.
  if (treeOf(gh, repo, sha) !== treeOf(gh, repo, head))
    fail(`the tree of ${sha} is not the tree of #${pr.number}'s head ${head}`)

  // The pull request's run tested its merge ref, which has the head's tree when the base
  // was an ancestor of the head. The branch moves only forward, so the base at the time
  // of the run was an ancestor of the tip before the push.
  const { status } = api<{ status: string }>(gh, `repos/${repo}/compare/${before}...${head}`)
  if (status !== 'ahead' && status !== 'identical') {
    fail(`the previous tip ${before} of ${branch} is not an ancestor of #${pr.number}'s head (${status})`)
  }

  const runs = api<{ workflow_runs: WorkflowRun[] }>(
    gh,
    `repos/${repo}/actions/workflows/${input.workflow}/runs?head_sha=${head}&per_page=100`,
  ).workflow_runs
  const proof = runs.find((run) => runProves(gh, input, run))
  const level = input.step ? `, step ${input.step}` : ''
  if (!proof) fail(`no pull request run of ${input.workflow} on ${head} with ${input.jobs.join(', ')} green${level}`)
  return `the tree of ${sha} is #${pr.number}'s head ${head}, proved by ${proof.html_url ?? `run ${proof.id}`}`
}

export function proved(gh: Gh, input: ProvedInput): Proved {
  try {
    return { proved: true, reason: prove(gh, input) }
  } catch (error) {
    return { proved: false, reason: (error as Error).message }
  }
}
