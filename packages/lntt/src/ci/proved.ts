// `lntt ci proved`: whether a push's tree is one a pull request's CI has already proved
// green, read from the GitHub API (docs/process/ci.md#a-tree-already-proved). It answers
// *proved* only when every condition holds; anything else, an API error included, is
// *not proved*, and the caller runs the whole job.

import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import { Gh, type WorkflowRun } from '../gh/gh.ts'

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

// Why the tree is not proved.
class NotProved extends Data.TaggedError('NotProved')<{ message: string }> {}

const fail = (reason: string) => Effect.fail(new NotProved({ message: reason }))

const treeOf = Effect.fnUntraced(function* (repo: string, sha: string) {
  const tree = yield* (yield* Gh).treeOf({ repo, sha })
  if (typeof tree !== 'string' || !SHA.test(tree)) return yield* fail(`no tree for ${sha}`)
  return tree
})

// The run's jobs are all green, and each ran the marker step green.
const runProves = Effect.fnUntraced(function* (input: ProvedInput, run: WorkflowRun) {
  // An element of another shape proves nothing.
  if (!PR_EVENTS.has(run?.event) || run?.status !== 'completed') return false
  const jobs = yield* (yield* Gh).runJobs({ repo: input.repo, run: run.id })
  return input.jobs.every((name) => {
    const job = jobs.find((j) => j?.name === name)
    if (job?.conclusion !== 'success') return false
    if (input.step === undefined) return true
    return (job?.steps ?? []).some((s) => s?.name === input.step && s?.conclusion === 'success')
  })
})

const prove = Effect.fnUntraced(function* (input: ProvedInput) {
  const gh = yield* Gh
  const { repo, sha, before, branch } = input
  if (!SHA.test(sha)) return yield* fail(`the pushed sha is not a commit id: ${sha}`)
  if (input.jobs.length === 0) return yield* fail('no job named: give --job')
  if (!SHA.test(before) || NO_COMMIT.test(before)) return yield* fail(`no previous tip of ${branch} to compare with`)

  const merged = (yield* gh.commitPullRequests({ repo, sha })).filter(
    (pr) => pr?.merged_at != null && pr?.base?.ref === branch,
  )
  if (merged.length === 0) return yield* fail(`no merged pull request into ${branch} explains ${sha}`)
  if (merged.length > 1)
    return yield* fail(
      `more than one merged pull request explains ${sha}: ${merged.map((p) => `#${p.number}`).join(', ')}`,
    )
  const [pr] = merged as [(typeof merged)[number]]
  const head = String(pr.head?.sha)
  if (!SHA.test(head)) return yield* fail(`#${pr.number} has no head commit`)

  // The same tree as the head the pull request ran on.
  if ((yield* treeOf(repo, sha)) !== (yield* treeOf(repo, head)))
    return yield* fail(`the tree of ${sha} is not the tree of #${pr.number}'s head ${head}`)

  // The pull request's run tested its merge ref, which has the head's tree when the base
  // was an ancestor of the head. The branch moves only forward, so the base at the time
  // of the run was an ancestor of the tip before the push.
  const status = yield* gh.compareStatus({ repo, base: before, head })
  if (status !== 'ahead' && status !== 'identical') {
    return yield* fail(`the previous tip ${before} of ${branch} is not an ancestor of #${pr.number}'s head (${status})`)
  }

  const runs = yield* gh.workflowRuns({ repo, workflow: input.workflow, sha: head })
  let proof: WorkflowRun | undefined
  for (const run of runs) {
    if (yield* runProves(input, run)) {
      proof = run
      break
    }
  }
  const level = input.step ? `, step ${input.step}` : ''
  if (!proof)
    return yield* fail(
      `no pull request run of ${input.workflow} on ${head} with ${input.jobs.join(', ')} green${level}`,
    )
  return `the tree of ${sha} is #${pr.number}'s head ${head}, proved by ${proof.html_url ?? `run ${proof.id}`}`
})

// Whether the tree is proved, with the reason; any failure, a read included, is not proved.
export const proved = (input: ProvedInput) =>
  prove(input).pipe(
    Effect.map((reason): Proved => ({ proved: true, reason })),
    // A refused call, an answer of another shape (Gh's GhError) and a refusal of the checks alike.
    Effect.catch((error) => Effect.succeed<Proved>({ proved: false, reason: error.message })),
  )
