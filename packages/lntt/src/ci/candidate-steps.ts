// The candidate automation's steps on Effect (docs/process/delivery.md has the flow): what reads or
// writes GitHub and git, over the Gh service (the repository's token), Board (the Projects token's
// Gh, when the run has one) and Git (the local clone), each a typed operation (src/gh/gh.ts,
// src/git/git.ts). A dry run is a layer of each that prints the writes and the push instead of
// making them. The decisions, the bodies and the parsers are plain, in src/ci/candidate.ts, which
// loads no Effect for the commands that read them.

import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { openCandidateOf } from '../base/names.ts'
import { same } from '../board.ts'
import {
  holdsLine,
  issueOnBoardOf,
  issueQuery,
  itemsQuery,
  MOVE_TO_READY,
  NotOnBoard,
  waitingOf,
  waitingQuery,
} from '../board-ready.ts'
import { Gh, type GhOperations } from '../gh/gh.ts'
import { Git, type GitResult } from '../git/git.ts'
import { retroComment } from '../pull-request.ts'
import {
  announceComment,
  BOARD_MUTATION,
  BOARD_QUERY,
  type BoardItem,
  type CandidateConfig,
  type CandidatePr,
  candidateBody,
  candidateClosingReferences,
  candidateName,
  candidateNumber,
  carryOverDecision,
  closeDecision,
  closingReferences,
  type FollowFacts,
  type FollowResult,
  followConflictComment,
  followDecision,
  followedComment,
  followedMarker,
  followedPrComment,
  followMarker,
  followRefusedComment,
  isAnnounced,
  isCandidateMerge,
  issueNumber,
  list,
  localIssues,
  movedComment,
  NOT_PERMITTED,
  nextCandidateNumber,
  OPEN_PRS_QUERY,
  type OpenPullRequest,
  orphanCandidate,
  type PrNode,
  type PullRequest,
  pushError,
  type ReadyReport,
  readyComment,
  readyMarker,
  recordMerges,
  retargetDecision,
  retrospectiveComment,
  short,
  sweepDecision,
  workflowLine,
} from './candidate.ts'

// What fails a step is a CandidateFailed, or the GhError or GitError of the call that failed; a step
// that goes on past a failure reads its message.

// A step of the automation that failed, by its message.
export class CandidateFailed extends Data.TaggedError('CandidateFailed')<{ message: string }> {}

// The Projects token's client: null when the run has none, and the board is not moved.
export class Board extends Context.Service<Board, { readonly gh: GhOperations | null }>()(
  '@lntt/lntt/ci/candidate/Board',
) {
  static readonly none = Layer.succeed(Board)(Board.of({ gh: null }))

  // The board's client is the Gh that `gh` gives, apart from the repository's.
  static over<E, R>(gh: Layer.Layer<Gh, E, R>) {
    return Layer.effect(Board)(Effect.map(Gh, (client) => Board.of({ gh: client }))).pipe(Layer.provide(gh))
  }
}

// One run: the repository, the configuration, where its lines go, and whether it has the local
// clone to follow the base with (without it the follow step does nothing).
export interface Run {
  repo: string
  config: CandidateConfig
  log: (line: string) => void
  clone: boolean
}

const messageOf = (error: unknown) => (error as { message?: string })?.message ?? String(error)

const failed = (message: string) => Effect.fail(new CandidateFailed({ message }))

const openCandidates = Effect.fnUntraced(function* ({ repo, config }: Pick<Run, 'repo' | 'config'>) {
  const gh = yield* Gh
  const prs: CandidatePr[] = yield* gh.candidatePullRequests({ repo, base: config.base, prefix: config.prefix })
  return prs
    .filter((pr) => candidateNumber(config, pr.headRefName) !== null)
    .sort((a, b) => (candidateNumber(config, a.headRefName) ?? 0) - (candidateNumber(config, b.headRefName) ?? 0))
})

// The lowest open one, as the base reads it (src/base/names.ts).
export const openCandidate = (run: Pick<Run, 'repo' | 'config'>) =>
  Effect.map(openCandidates(run), (prs) => openCandidateOf(prs, run.config.prefix))

// Creates `<prefix><n>` from the base with a draft pull request. GitHub refuses a pull
// request between identical branches, so the branch starts with an empty commit. A
// branch an earlier run left without its pull request is reused, pull request only.
const createCandidate = Effect.fnUntraced(function* ({ repo, config, log }: Run) {
  const gh = yield* Gh
  const names = {
    branches: yield* gh.branchesUnder({ repo, prefix: config.prefix }),
    prHeads: yield* gh.pullRequestHeads({ repo, prefix: config.prefix }),
  }
  const orphan = orphanCandidate(config, names)
  const n = orphan
    ? (candidateNumber(config, orphan) as number)
    : nextCandidateNumber(config, [...names.branches, ...names.prHeads])
  const branch = `${config.prefix}${n}`
  const name = candidateName(config)
  if (orphan) {
    log(`candidate: no candidate open, ${branch} exists without a pull request: picking it up.`)
  } else {
    const head = yield* gh.commitOf({ repo, ref: config.base })
    log(`candidate: no candidate open, creating ${branch} from ${config.base} @ ${head.sha.slice(0, 8)}.`)
    const commit = yield* gh.createCommit({
      repo,
      message: `chore: open ${name} ${n}`,
      tree: head.tree,
      parent: head.sha,
    })
    yield* gh.createBranch({ repo, name: branch, sha: commit || '<sha of the empty commit>' })
  }
  const url = yield* gh.createDraft({
    repo,
    base: config.base,
    head: branch,
    title: `${name} ${n}`,
    body: candidateBody(config, n),
  })
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0)
  return { number, headRefName: branch, created: true } satisfies CandidatePr
})

// The candidate's retrospective comment, written when it has none: on the candidate just
// created, and on one a run left without it (a write that failed after `pr create`), so
// the next run repairs it. A failure is a warning, never a reason not to move the pull
// request: `lntt retro add` writes the comment too, and `lntt check body` reports it.
const ensureRetrospective = (run: Run, candidate: CandidatePr) =>
  Effect.gen(function* () {
    const gh = yield* Gh
    const { repo, config, log } = run
    if (!candidate.created && retroComment(yield* gh.issueComments({ repo, number: candidate.number })) !== null) return
    if (!candidate.created) log(`candidate: ${candidate.headRefName} has no retrospective comment: writing it.`)
    // A candidate a dry run created has no number yet.
    yield* gh.commentPullRequest({ repo, number: candidate.number || '<new>', body: retrospectiveComment(config) })
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() =>
        run.log(
          `::warning title=Retrospective comment::${candidate.headRefName}: not written (${workflowLine(messageOf(error))}); pnpm exec lntt retro add writes it`,
        ),
      ),
    ),
  )

const moveOnto = Effect.fnUntraced(function* ({ repo, config }: Run, number: number, candidate: CandidatePr) {
  const gh = yield* Gh
  yield* gh.retarget({ repo, number, base: candidate.headRefName })
  yield* gh.commentPullRequest({
    repo,
    number,
    body: movedComment(config, {
      number,
      candidateBranch: candidate.headRefName,
      candidatePr: candidate.number || '<new>',
    }),
  })
})

export const retarget = Effect.fnUntraced(function* (run: Run, pr: PullRequest) {
  const decision = retargetDecision(run.config, pr)
  run.log(
    `candidate: #${pr.number} (${pr.headRef} → ${pr.baseRef}): ${decision.move ? 'moving it' : 'it stays'}, ${decision.reason}.`,
  )
  if (!decision.move) return decision
  const candidate = (yield* openCandidate(run)) ?? (yield* createCandidate(run))
  run.log(`candidate: open candidate ${candidate.headRefName} (#${candidate.number || '<new>'}).`)
  yield* ensureRetrospective(run, candidate)
  yield* moveOnto(run, pr.number, candidate)
  return decision
})

// Every open pull request, with its last base change.
const openPrs = Effect.fnUntraced(function* ({ repo }: Pick<Run, 'repo'>) {
  const gh = yield* Gh
  const [owner = '', name = ''] = repo.split('/')
  const nodes = (yield* gh.graphqlNodes(
    OPEN_PRS_QUERY,
    { owner, name },
    '[.data.repository.pullRequests.nodes[]]',
  )) as PrNode[]
  return nodes.map((pr): OpenPullRequest => {
    const change = pr.timelineItems.nodes[0]
    return {
      number: pr.number,
      baseRef: pr.baseRefName,
      headRef: pr.headRefName,
      ...(pr.author?.login ? { author: pr.author.login } : {}),
      labels: pr.labels.nodes.map((label) => label.name),
      lastBaseChange: change
        ? {
            from: (change.previousRefName ?? change.oldBase) as string,
            to: (change.currentRefName ?? change.newBase) as string,
          }
        : null,
    }
  })
})

// The merged candidate leaves open pull requests behind: they go onto the next
// candidate, created only when there is at least one.
export const carryOver = Effect.fnUntraced(function* (run: Run, pr: PullRequest) {
  const candidateBranch = pr.headRef
  const { move } = carryOverDecision(run.config, { candidateBranch, openPrs: yield* openPrs(run) })
  if (move.length === 0) {
    run.log(
      `candidate: ${candidateBranch} merged, no open pull request to move: the next one creates the next candidate.`,
    )
    return { move }
  }
  const candidate = (yield* openCandidate(run)) ?? (yield* createCandidate(run))
  run.log(
    `candidate: ${candidateBranch} merged, moving ${move.map((n) => `#${n}`).join(', ')} onto ${candidate.headRefName}.`,
  )
  yield* ensureRetrospective(run, candidate)
  for (const number of move) yield* moveOnto(run, number, candidate)
  return { move }
})

const readIssue = Effect.fnUntraced(function* ({ repo }: Pick<Run, 'repo'>, number: number) {
  const issue = yield* (yield* Gh).issueState({ repo, number })
  return { number, state: issue.state, isPr: issue.isPr }
})

// Runs `step` on each number, going on past a failure; the failures are returned, so
// one wrong number does not leave the others behind.
// An answer GitHub shaped otherwise than expected throws where it is read: that counts as the
// step's failure too.
const eachIssue = <E, R>(numbers: number[], step: (number: number) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const failures: string[] = []
    for (const number of numbers) {
      const exit = yield* Effect.exit(step(number))
      if (Exit.isFailure(exit)) failures.push(`#${number}: ${messageOf(Cause.squash(exit.cause))}`)
    }
    return failures
  })

const failIfAny = (failures: string[], what: string) =>
  failures.length > 0 ? failed(`${what}: ${failures.join('; ')}`) : Effect.void

// The errors of steps that go on past each other, joined: the run fails after all of them.
const together = <E, R>(steps: Effect.Effect<unknown, E, R>[]) =>
  Effect.gen(function* () {
    const errors: string[] = []
    for (const step of steps) {
      const exit = yield* Effect.exit(step)
      if (Exit.isFailure(exit)) errors.push(messageOf(Cause.squash(exit.cause)))
    }
    if (errors.length > 0) return yield* failed(errors.join('; '))
  })

// Moves each issue to `status` on every Project it is on that has that status. An issue
// with no project that can take the status is told in a `::notice` and returned in
// `skipped`; one already at the status everywhere is in neither list; one moved on some
// projects and refused on a later one is in `moved`, with a notice for the refusal, and
// its remaining projects are not tried. Only a failure that is not a refusal of the
// token fails, after the other issues are done.
export const setBoardStatus = Effect.fnUntraced(function* (run: Run, issues: number[], status: string) {
  const moved: number[] = []
  const skipped: number[] = []
  const { repo, log } = run
  const board = (yield* Board).gh
  if (issues.length === 0) return { moved, skipped }
  if (!board) {
    log(
      `::notice title=Board not moved::no token with the Projects permission: ${list(issues)} stay on their status instead of "${status}" (docs/process/delivery.md)`,
    )
    return { moved, skipped: [...issues] }
  }
  const [owner, name] = repo.split('/')
  const moveOne = Effect.fnUntraced(function* (number: number) {
    const answer = yield* board.graphqlFields(BOARD_QUERY, { owner, name, number })
    const nodes = (answer as { repository: { issue: { projectItems: { nodes: BoardItem[] } } } }).repository.issue
      .projectItems.nodes
    if (nodes.length === 0) {
      log(`::notice title=Board not moved::#${number} is on no project: nothing to move to "${status}".`)
      skipped.push(number)
      return
    }
    let found = false
    for (const node of nodes) {
      const field = node.project.field
      if (!field?.id) {
        log(
          `::notice title=Board not moved::project "${node.project.title}" has no Status field: #${number} is not moved to "${status}".`,
        )
        continue
      }
      const option = field.options?.find((o) => o.name.toLowerCase() === status.toLowerCase())
      if (!option) {
        log(
          `::notice title=Board not moved::"${status}" is not an option of the Status field of project "${node.project.title}" (${(field.options ?? []).map((o) => o.name).join(', ')}): #${number} is not moved. Check delivery.candidate.status, or add it from the project's web UI (field menu, edit), never with updateProjectV2Field, which resets every item's status (the github-board skill, references/github-project.md, "Changing a field's options").`,
        )
        continue
      }
      found = true
      if (node.fieldValueByName?.optionId === option.id) continue
      yield* board.graphqlWrite(BOARD_MUTATION, {
        project: node.project.id,
        item: node.id,
        field: field.id,
        option: option.id,
      })
      if (!moved.includes(number)) moved.push(number)
    }
    if (!found) skipped.push(number)
  })
  const failures = yield* eachIssue(issues, (number) =>
    moveOne(number).pipe(
      Effect.catch((error) => {
        const message = messageOf(error)
        if (!NOT_PERMITTED.test(message)) return Effect.fail(error)
        return Effect.sync(() => {
          log(
            `::notice title=Board not moved::the token lacks the Projects permission on a project of #${number}, which is not moved to "${status}" there: ${message.split('\n')[0]}`,
          )
          // A project written before the refusal stays moved: the issue is in `moved` and
          // is not skipped.
          if (!moved.includes(number) && !skipped.includes(number)) skipped.push(number)
        })
      }),
    ),
  )
  log(`candidate: board "${status}": moved ${list(moved)}; skipped ${list(skipped)}.`)
  yield* failIfAny(failures, `issues not moved to "${status}"`)
  return { moved, skipped }
})

// The candidate is merged: the issues of its `Closes` lines still open close as
// completed.
export const closeCandidateIssues = Effect.fnUntraced(function* (run: Run, pr: PullRequest) {
  const gh = yield* Gh
  const numbers = localIssues(run, candidateClosingReferences(pr.body))
  const issues: Array<{ number: number; state: string; isPr: boolean }> = []
  const unread = yield* eachIssue(numbers, (number) =>
    Effect.map(readIssue(run, number), (issue) => void issues.push(issue)),
  )
  const decision = closeDecision(issues)
  run.log(
    `candidate: ${pr.headRef} merged: closing ${list(decision.close)}; already closed ${list(decision.alreadyClosed)}.`,
  )
  if (decision.notIssues.length > 0) {
    run.log(`candidate: ${list(decision.notIssues)} are pull requests, not issues: skipping them.`)
  }
  const unclosed = yield* eachIssue(decision.close, (number) => gh.closeIssue({ repo: run.repo, number }))
  // The issues closed before the merge count too: one closed by hand after reaching
  // `In release` has nothing else to move it to `Done`.
  yield* together([
    failIfAny([...unread, ...unclosed], `issues not closed by the merge of ${pr.headRef}`),
    setBoardStatus(run, [...decision.close, ...decision.alreadyClosed], run.config.status.done),
  ])
  return decision
})

// Tells each open issue that `prs` close that the candidate's merge will close it, once
// per issue and candidate: a comment carrying the candidate's marker is not written
// again.
const announceIssues = Effect.fnUntraced(function* (
  run: Run,
  candidate: CandidatePr,
  prs: Array<{ body: string | null }>,
) {
  const gh = yield* Gh
  const numbers = localIssues(
    run,
    prs.flatMap((pr) => closingReferences(pr.body)),
  )
  const announced: number[] = []
  const open: number[] = []
  const failures = yield* eachIssue(numbers, (number) =>
    Effect.gen(function* () {
      const issue = yield* readIssue(run, number)
      if (issue.isPr || issue.state.toLowerCase() === 'closed') return
      open.push(number)
      if (isAnnounced(yield* gh.issueCommentBodies({ repo: run.repo, number }), candidate.headRefName)) return
      yield* gh.commentIssue({
        repo: run.repo,
        number,
        body: announceComment(run.config, { candidateBranch: candidate.headRefName, candidatePr: candidate.number }),
      })
      announced.push(number)
    }),
  )
  run.log(
    `candidate: announcing ${candidate.headRefName} (#${candidate.number}) on ${list(announced)}, of ${list(numbers)}.`,
  )
  return { announced, open, failed: failures }
})

export const announce = Effect.fnUntraced(function* (run: Run, candidate: CandidatePr, prs: Array<{ body: string }>) {
  const { announced, open, failed: failures } = yield* announceIssues(run, candidate, prs)
  yield* failIfAny(failures, `issues without the announcement of ${candidate.headRefName}`)
  return { announced, open }
})

export const record = Effect.fnUntraced(function* (run: Run, pr: PullRequest) {
  const gh = yield* Gh
  const { repo, config, log } = run
  if (!pr.merged || candidateNumber(config, pr.baseRef) === null) {
    log(`candidate: #${pr.number} is not a merge into a candidate, nothing to record.`)
    return { recorded: false }
  }
  const prs = yield* gh.pullRequestsFrom({ repo, head: pr.baseRef, base: config.base })
  const candidate = prs[0]
  if (!candidate) {
    return yield* failed(
      `no open pull request from ${pr.baseRef} into ${config.base}: the issues of #${pr.number} (${closingReferences(pr.body).join(', ') || 'none'}) are not recorded.`,
    )
  }
  // Every pull request merged into the candidate, in merge order: a run the
  // concurrency group dropped is caught up by the next one.
  const merged = [...(yield* gh.mergedInto({ repo, base: pr.baseRef, fields: 'number,title,body,mergedAt' }))].sort(
    (a, b) => ((a.mergedAt ?? '') < (b.mergedAt ?? '') ? -1 : (a.mergedAt ?? '') > (b.mergedAt ?? '') ? 1 : 0),
  )
  const all: Array<{ number: number; title?: string; body: string | null }> = merged.some((m) => m.number === pr.number)
    ? merged
    : [...merged, pr]
  const body = recordMerges(
    candidate.body,
    all.map((m) => ({ number: m.number, title: m.title ?? '', closes: closingReferences(m.body) })),
  )
  const recorded = body !== candidate.body
  if (recorded) {
    log(
      `candidate: recording in #${candidate.number} the pull requests merged into ${pr.baseRef} (${list(all.map((m) => m.number))}).`,
    )
    yield* gh.editBody({ repo, number: candidate.number, body })
  } else {
    log(`candidate: #${pr.number} is already in #${candidate.number}.`)
  }
  // The board moves for the issues announced or not, and a failing comment is reported
  // after it: the next run finds both done.
  const { open, failed: failures } = yield* announceIssues(
    run,
    { number: candidate.number, headRefName: pr.baseRef },
    all,
  )
  yield* together([
    failIfAny(failures, `issues without the announcement of ${pr.baseRef}`),
    setBoardStatus(run, open, config.status.inRelease),
  ])
  return { recorded }
})

export const sweep = Effect.fnUntraced(function* (run: Run) {
  const candidates = yield* openCandidates(run)
  const { move } = sweepDecision(run.config, {
    openPrs: yield* openPrs(run),
    openCandidates: candidates.map((c) => c.headRefName),
  })
  if (move.length === 0) return { move }
  const candidate = candidates[0] ?? (yield* createCandidate(run))
  run.log(
    `candidate: ${move.map((n) => `#${n}`).join(', ')} stranded on a closed candidate: moving onto ${candidate.headRefName}.`,
  )
  yield* ensureRetrospective(run, candidate)
  for (const number of move) yield* moveOnto(run, number, candidate)
  return { move }
})

// Writes `body` on `number` unless a comment there already carries `marker`.
const commentOnce = Effect.fnUntraced(function* (run: Run, number: number, marker: string, body: string) {
  const gh = yield* Gh
  if ((yield* gh.issueComments({ repo: run.repo, number })).some((c) => (c.body ?? '').includes(marker))) {
    run.log(`candidate: #${number} already has this comment.`)
    return
  }
  yield* gh.commentPullRequest({ repo: run.repo, number, body })
})

// The candidate's new head, or the files in conflict: its commits rebased on the base in a
// worktree of their own, in a temporary folder, removed with the scope.
const rebased = (oldHead: string, base: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs
        .makeTempDirectoryScoped({ prefix: 'lntt-follow-' })
        .pipe(Effect.flatMap((d) => fs.realPath(d)))
      yield* Effect.addFinalizer(() => Effect.ignore(git.removeWorktree(dir)))
      const add = yield* git.addWorktree({ dir, rev: oldHead })
      if (add.status !== 0) return yield* failed(`git worktree add failed: ${pushError(add.stderr)}`)
      // The candidate opens with an empty commit, kept; merges of the base in its
      // history are dropped, their commits being in the base.
      const rebase = yield* git.rebaseIn({ dir, onto: base })
      if (rebase.status === 0)
        return { head: (yield* git.headIn(dir)).stdout } as { head: string } | { files: string[] }
      const files = (yield* git.conflictsIn(dir)).stdout.split('\n').filter((line) => line !== '')
      yield* git.abortRebaseIn(dir)
      if (files.length === 0) return yield* failed(`git rebase failed: ${pushError(rebase.stderr)}`)
      return { files }
    }),
  )

// The merge commit of the base into the candidate (parents: the candidate's head, then
// the base), or the files in conflict.
const merged = Effect.fnUntraced(function* (facts: FollowFacts, base: string) {
  const git = yield* Git
  const tree = yield* git.mergeTree({ ours: facts.oldHead, theirs: facts.base })
  const lines = tree.stdout.split('\n').filter((line) => line !== '')
  if (tree.status === 1) return { files: [...new Set(lines.slice(1))] } as { head: string } | { files: string[] }
  if (tree.status !== 0) return yield* failed(`git merge-tree failed: ${pushError(tree.stderr)}`)
  const commit = yield* git.commitTree({
    tree: lines[0] ?? '',
    parents: [facts.oldHead, facts.base],
    messages: [`Merge ${base} into ${facts.candidate}`, `${base} at ${facts.base}.`],
  })
  if (commit.status !== 0) return yield* failed(`git commit-tree failed: ${pushError(commit.stderr)}`)
  return { head: commit.stdout }
})

// The open candidate follows the base when the base moved (followDecision): its commits
// rebased on the base and pushed with a lease on the head as read, or the base merged
// into it and pushed plainly. A conflict or a refused push leaves the candidate as it
// is, comments on its pull request what an admin does, and warns: it does not fail the
// run. A comment that fails after the push is a warning too. Every comment is written
// once (followMarker, followedMarker). In a dry run the fetch, the merge and the rebase
// still run on the local clone and a temporary worktree; only the push and the comments
// are printed.
export const follow = Effect.fnUntraced(function* (run: Run) {
  const gh = yield* Gh
  const { repo, config, log } = run
  if (!run.clone) {
    log(
      `candidate: follow ${config.base}: no git client in this run, the candidate is left as it is (from a terminal, pnpm exec lntt ci candidate --follow follows it).`,
    )
    return { path: 'none', reason: 'no git client', outcome: 'no-git' } as FollowResult
  }
  const git = yield* Git
  const candidate = yield* openCandidate(run)
  let behindBy = 0
  let base = ''
  let prsInto: number[] = []
  if (candidate) {
    const compare = yield* gh.behind({ repo, base: config.base, head: candidate.headRefName })
    behindBy = compare.behindBy
    base = compare.base
    if (behindBy > 0) {
      prsInto = (yield* openPrs(run))
        .filter((pr) => pr.baseRef === candidate.headRefName)
        .map((pr) => pr.number)
        .sort((a, b) => a - b)
    }
  }
  const decision = followDecision(config, { candidate: candidate?.headRefName ?? null, behindBy, prsInto })
  log(`candidate: follow ${config.base}: ${decision.reason}`)
  if (decision.path === 'none' || !candidate) return { ...decision, outcome: 'none' } as FollowResult

  const name = candidate.headRefName
  const must = (what: string, result: GitResult) =>
    result.status === 0 ? Effect.succeed(result.stdout) : failed(`git ${what} failed: ${pushError(result.stderr)}`)
  const shallow = (yield* must('rev-parse', yield* git.isShallow)) === 'true'
  yield* must('fetch', yield* git.fetchBranches({ branches: [config.base, name], unshallow: shallow }))
  const fetched = yield* git.verify(`refs/remotes/origin/${name}`)
  if (fetched === null) return yield* failed(`git rev-parse failed: no refs/remotes/origin/${name} after the fetch`)
  const oldHead = candidate.headRefOid ?? fetched
  if (fetched !== oldHead || (yield* git.verify(`${base}^{commit}`)) === null) {
    log(
      `candidate: ${name} moved between the read (${short(oldHead)}) and the fetch (${short(fetched)}): left as it is, the next run follows ${config.base}.`,
    )
    return { ...decision, outcome: 'moved-meanwhile' } as FollowResult
  }

  const facts: FollowFacts = { candidate: name, base, oldHead, path: decision.path, prsInto }
  const result = decision.path === 'rebase' ? yield* rebased(oldHead, base) : yield* merged(facts, config.base)
  if ('files' in result) {
    log(
      `::warning title=Candidate not updated::${name}: the ${decision.path} on ${config.base} ${short(base)} stops on a conflict in ${workflowLine(result.files.join(', '))}; nothing pushed, what to do is on #${candidate.number}`,
    )
    yield* commentOnce(
      run,
      candidate.number,
      followMarker(base, oldHead),
      followConflictComment(config, facts, result.files),
    )
    return { ...decision, outcome: 'conflict', files: result.files } as FollowResult
  }

  const head = result.head
  const push = yield* git.pushBranch({
    sha: head,
    branch: name,
    ...(decision.path === 'rebase' ? { expected: oldHead } : {}),
  })
  if (push.status !== 0) {
    const error = pushError(push.stderr)
    log(
      `::warning title=Candidate not updated::${name}: the push of the ${decision.path} on ${config.base} ${short(base)} was refused (${workflowLine(error)}); what to do is on #${candidate.number}`,
    )
    yield* commentOnce(run, candidate.number, followMarker(base, oldHead), followRefusedComment(config, facts, error))
    return { ...decision, outcome: 'refused', head } as FollowResult
  }
  log(
    `candidate: ${name} ${decision.path === 'rebase' ? 'rebased on' : 'merged with'} ${config.base} ${short(base)}: ${short(oldHead)} → ${short(head)}.`,
  )
  // The candidate is updated: a comment that fails is a warning, and does not stop the
  // comments on the other pull requests.
  const tell = (number: number, body: string) =>
    commentOnce(run, number, followedMarker(head), body).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          log(
            `::warning title=Candidate updated, comment not written::${name} is at ${short(head)}; the comment on #${number} failed (${workflowLine(messageOf(error))})`,
          ),
        ),
      ),
    )
  yield* tell(candidate.number, followedComment(config, facts, head))
  if (decision.path === 'merge') {
    for (const number of prsInto) yield* tell(number, followedPrComment(config, facts, head))
  }
  return { ...decision, outcome: 'updated', head } as FollowResult
})

// The follow step inside a pull_request run: a failure is a warning, so the event is
// still handled.
const followOrWarn = (run: Run) =>
  follow(run).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.sync(() =>
        run.log(
          `::warning title=Candidate not updated::following ${run.config.base} failed (${workflowLine(messageOf(error))}); the next run tries again`,
        ),
      ),
    ),
  )

// --- The Ready check on the candidate's merge --------------------------------------

// Which pull request closed which issue: those merged into the candidate; an issue none
// of them names is the candidate's own. The list is only evidence: when it cannot be
// read, every issue is the candidate's own and the moves go on.
const closers = Effect.fnUntraced(function* ({ repo, log }: Run, pr: PullRequest) {
  const gh = yield* Gh
  const merged = yield* gh.mergedInto({ repo, base: pr.headRef, fields: 'number,body' }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        log(
          `::notice title=Ready check evidence::the pull requests merged into ${pr.headRef} could not be read, the comment names #${pr.number}: ${messageOf(error).split('\n')[0]}`,
        )
        return []
      }),
    ),
  )
  return (issue: number) =>
    merged.find((m) => closingReferences(m.body).some((ref) => issueNumber(ref, repo) === issue))?.number ?? pr.number
})

// The candidate is merged, so its issues are closed: the issues blocked by one of them
// that meet the criteria move from the first status to Ready, and the candidate's pull
// request says what moved and what is missing for the rest. An issue already at Ready is
// listed there, and one further along is someone's already and is left alone. The Projects token's refusals and a
// Project without the statuses are notices, as for every board move here.
export const readyAfterMerge = Effect.fnUntraced(function* (run: Run, pr: PullRequest) {
  const gh = yield* Gh
  const board = (yield* Board).gh
  const { repo, log, config } = run
  const rules = config.ready
  if (!rules?.blockedBy) return null
  const notice = (message: string) => log(`::notice title=Board not moved::${message}`)
  if (!board) {
    notice(
      'no token with the Projects permission: the Ready check of this merge did not run (docs/process/delivery.md)',
    )
    return null
  }
  const waiting = new Map<number, number[]>()
  const failures = yield* eachIssue(localIssues(run, candidateClosingReferences(pr.body)), (number) =>
    Effect.gen(function* () {
      const asked = waitingQuery(repo, number)
      const { closed, blocked, more } = waitingOf(yield* gh.graphqlFields(asked.query, asked.variables), repo)
      if (!closed) return
      if (more)
        log(
          `::notice title=Ready check partial::#${number} blocks more issues than one read holds: lntt board ready lists the rest.`,
        )
      for (const issue of blocked) waiting.set(issue, [...(waiting.get(issue) ?? []), number])
    }),
  )
  const report: ReadyReport = { moved: [], already: [], left: [] }
  if (waiting.size > 0) {
    const closer = yield* closers(run, pr)
    const evidence = (blockers: number[]) => blockers.map((b) => `#${b} closed by #${closer(b)}`).join(', ')
    const issues = [...waiting.keys()].sort((a, b) => a - b)
    failures.push(
      ...(yield* eachIssue(issues, (number) => {
        const why = evidence(waiting.get(number) ?? [])
        return Effect.gen(function* () {
          const issueAsked = issueQuery(rules, repo, number)
          const itemsAsked = itemsQuery(rules, repo, number)
          const issueAnswer = yield* gh.graphqlFields(issueAsked.query, issueAsked.variables)
          const itemsAnswer = yield* board.graphqlFields(itemsAsked.query, itemsAsked.variables)
          const { verdict, status, target } = yield* Effect.try({
            try: () => issueOnBoardOf(issueAnswer, itemsAnswer, rules, repo),
            catch: (error) => error,
          })
          if (!target) {
            log(`candidate: #${number} is not on the board, the Ready check leaves it.`)
          } else if (same(status ?? '', rules.status.ready)) {
            report.already.push({ number, evidence: why })
          } else if (!same(status ?? '', rules.status.initial)) {
            log(`candidate: #${number} is at ${status ?? 'no status'}, the Ready check leaves it.`)
          } else if (verdict.kind === 'eligible') {
            yield* board.graphqlWrite(MOVE_TO_READY, { ...target })
            report.moved.push({ number, evidence: why })
          } else if (verdict.kind === 'holds') {
            report.left.push({ number, evidence: why, why: holdsLine(verdict.open) })
          } else {
            report.left.push({ number, evidence: why, why: `missing ${verdict.missing.join(', ')}` })
          }
        }).pipe(
          Effect.catch((error) => {
            const message = messageOf(error)
            if (!(error instanceof NotOnBoard) && !NOT_PERMITTED.test(message)) return Effect.fail(error)
            return Effect.sync(() =>
              notice(`#${number} is not moved to "${rules.status.ready}": ${message.split('\n')[0]}`),
            )
          }),
        )
      })),
    )
  }
  log(
    `candidate: Ready check: moved ${list(report.moved.map((i) => i.number))}; left ${list(report.left.map((i) => i.number))}.`,
  )
  if (report.moved.length + report.already.length + report.left.length > 0) {
    yield* commentOnce(run, pr.number, readyMarker(pr.headRef), readyComment(rules, pr.headRef, report))
  }
  yield* failIfAny(failures, `issues the Ready check could not read or move`)
  return report
})

// The candidate is merged: its issues close, the pull requests it left behind move, and
// the issues that waited on the closed ones are checked. One failing does not stop the
// others; the run fails after all of them.
export const candidateMerged = (run: Run, pr: PullRequest) =>
  together([closeCandidateIssues(run, pr), carryOver(run, pr), readyAfterMerge(run, pr)])

// What the event asks for: move, record, or close and carry over; first, the sweep of
// pull requests a dropped event left behind and the candidate following the base. Both
// run on every event: the concurrency group drops a pending run when a newer one
// arrives, and the newer one catches up.
export const handle = Effect.fnUntraced(function* (run: Run, action: string, pr: PullRequest) {
  yield* sweep(run)
  yield* followOrWarn(run)
  if (action === 'opened' || action === 'ready_for_review') yield* retarget(run, pr)
  else if (action === 'closed' && isCandidateMerge(run.config, pr)) yield* candidateMerged(run, pr)
  else if (action === 'closed') yield* record(run, pr)
  else run.log(`candidate: event ${action}, nothing to do.`)
})

// A push to the base, or `--follow` from a terminal: the sweep, then the candidate
// following the base. An error escapes on purpose: following is the whole job of
// this run, so a failure turns it red (inside a pull_request run it is a warning).
export const handlePush = Effect.fnUntraced(function* (run: Run) {
  yield* sweep(run)
  return yield* follow(run)
})

// A pull request as gh reads it, by its number.
export const prFromGh = Effect.fnUntraced(function* (repo: string, number: number) {
  const pr = yield* (yield* Gh).pullRequestView({ repo, number })
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    labels: pr.labels.map((label) => label.name),
    merged: Boolean(pr.mergedAt),
    ...(pr.author?.login ? { author: pr.author.login } : {}),
    ...(pr.isCrossRepository !== undefined ? { fromFork: pr.isCrossRepository } : {}),
  } satisfies PullRequest
})
