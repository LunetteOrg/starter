// The candidate: every pull request into the base lands on the open candidate branch
// (`<prefix><N>`), and the candidate's pull request (`<prefix><N>` → base) carries in
// its body the pull requests merged into it and their `Closes` lines. Run by the
// candidate workflow on `pull_request` events, or from a terminal with --pr;
// docs/process/delivery.md has the flow and the reasons.
//
// - `opened` / `ready_for_review` on a pull request into the base: unless it is a
//   candidate or a hotfix (branch prefix or label from delivery.candidate.hotfix),
//   find the open candidate, or create `<prefix><N+1>` from the base with a draft
//   pull request, then move the pull request onto it and comment. A candidate without
//   its retrospective comment (the empty block) gets it before anything moves onto it.
// - `closed` and merged into a candidate: rebuild the two lists of the candidate's
//   body from every pull request merged into it, and tell each open issue they close,
//   once per candidate, that the candidate's merge will close it.
// - `closed` and merged, the candidate itself: close the issues of its `Closes` lines
//   still open, then move the pull requests still open on it (GitHub moves them onto
//   the base when it deletes the branch) onto the next candidate, created only when
//   there are some. The issues that waited on what closed move to Ready when they meet
//   the criteria (src/board-ready.ts), and the candidate's pull request says which,
//   with what is missing for the rest.
// - every run, and alone on a push to the base (`handlePush`): when the base moved
//   while a candidate is open, the candidate follows it. Nobody on it (no pull request
//   open into it): its commits are rebased on the base and pushed with a lease on the
//   head as read. Pull requests open into it: the base is merged into it, no rewrite,
//   so their branches stay valid. A conflict or a refused push leaves it as it is and
//   tells the candidate's pull request what an admin does.
//
// The board follows: an open issue a pull request closes moves to `In release` when the
// pull request is squashed into a candidate, and its status becomes `Done` when the
// candidate merges. A Project without that status, a token without the Projects
// permission, an issue on no Project: a notice and no move, never an error and never an
// option created (adding one through the API resets every item's status).
//
// Closing keywords in a pull request body link an issue only when the pull request
// targets the default branch and a person wrote them: those written into the
// candidate's body by the automation link nothing, so the merge closes them here.
//
// Adapted from DiscenTech/pelion `scripts/ci/release-candidate.mjs`; the branch
// prefix, base and hotfix markers come from the configuration.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { type Automated, matchAutomated } from '../automated.ts'
import { candidateNumber as numberOf, openCandidateOf } from '../base/names.ts'
import { same } from '../board.ts'
import {
  holdsLine,
  issueOnBoardOf,
  issueQuery,
  itemsQuery,
  MOVE_TO_READY,
  NotOnBoard,
  type ReadyRules,
  waitingOf,
  waitingQuery,
} from '../board-ready.ts'
import { Gh, type GhOperations } from '../gh/gh.ts'
import { Git, type GitResult } from '../git/git.ts'
import { retroComment } from '../pull-request.ts'

export interface CandidateConfig {
  // The branch candidates merge into (main).
  base: string
  // The candidate branch prefix: `candidate/` gives candidate/1, candidate/2, …
  prefix: string
  // A pull request whose branch starts with `prefix` or that carries `label` stays on
  // the base.
  hotfix: { prefix: string; label: string }
  // The board statuses the automation sets: `inRelease` when a pull request is squashed
  // into a candidate, `done` when the candidate merges.
  status: { inRelease: string; done: string }
  // The empty retrospective block (`lntt pr block`): the comment a new candidate opens
  // with, which `lntt retro add` fills as the batch goes.
  retrospective: string
  // The bots' pull requests (delivery.automated): they stay on the base.
  automated: Automated[]
  // The Ready check run on the candidate's merge; none when the project has no board.
  ready?: ReadyRules
}

export interface PullRequest {
  number: number
  title: string
  body: string
  baseRef: string
  headRef: string
  labels: string[]
  merged: boolean
  // The login of who opened it, when the source has it.
  author?: string
  // Its head is in another repository (a fork), when the source says so.
  fromFork?: boolean
}

export interface OpenPullRequest {
  number: number
  baseRef: string
  headRef: string
  author?: string
  labels: string[]
  lastBaseChange: { from: string; to: string } | null
}

const PRS_START = '<!-- candidate:prs:start -->'
const PRS_END = '<!-- candidate:prs:end -->'
const CLOSES_START = '<!-- candidate:closes:start -->'
const CLOSES_END = '<!-- candidate:closes:end -->'

// `candidate/` → `candidate`: the word titles and messages use.
export function candidateName(config: CandidateConfig): string {
  return config.prefix.replace(/[/\-_.]+$/, '') || config.prefix
}

// The candidate number of a branch name, or null.
export function candidateNumber(config: CandidateConfig, name: string | undefined): number | null {
  return numberOf(config.prefix, name)
}

// The highest candidate number among `names`, plus one.
export function nextCandidateNumber(config: CandidateConfig, names: string[]): number {
  let highest = 0
  for (const name of names) {
    const n = candidateNumber(config, name)
    if (n !== null && n > highest) highest = n
  }
  return highest + 1
}

export function isHotfix(config: CandidateConfig, { headRef, labels = [] }: { headRef?: string; labels?: string[] }) {
  return (
    (headRef ?? '').startsWith(config.hotfix.prefix) ||
    labels.some((label) => label.toLowerCase() === config.hotfix.label.toLowerCase())
  )
}

// Whether a pull request just opened or marked ready moves onto the candidate.
export function retargetDecision(
  config: CandidateConfig,
  {
    baseRef,
    headRef,
    labels = [],
    author,
  }: { baseRef: string; headRef: string; labels?: string[]; author?: string | undefined },
): { move: boolean; reason: string } {
  if (baseRef !== config.base) return { move: false, reason: `it targets ${baseRef}, not ${config.base}` }
  if (headRef.startsWith(config.prefix)) return { move: false, reason: `${headRef} is a candidate` }
  if (isHotfix(config, { headRef, labels })) return { move: false, reason: `a hotfix stays on ${config.base}` }
  if (matchAutomated(config.automated, { author, headRef }))
    return { move: false, reason: `a pull request of ${author} (delivery.automated) stays on ${config.base}` }
  return { move: true, reason: `it targets ${config.base}` }
}

// The guard on pull requests into the base (`lntt ci candidate --guard`, the
// `candidate guard` check): a pull request into the base is the candidate, a hotfix or
// a bot's (delivery.automated), or the automation did not move it (an event GitHub dropped, a fork) and
// the check fails with the remedy. Required by the base's ruleset, a check that never
// reports blocks the merge too, so the guard holds when Actions drops every event.
// A branch name counts only from this repository, where pushing one takes write
// access: a fork can name its branch `candidate/1`, `hotfix/x` or a bot's. The hotfix label
// counts from anywhere: only a person with triage access puts it on. A head whose
// repository the source does not give counts as a fork.
export function guardDecision(
  config: CandidateConfig,
  pr: { number: number; baseRef: string; headRef: string; labels?: string[]; author?: string; fromFork?: boolean },
): { pass: boolean; reason: string } {
  if (pr.baseRef !== config.base) return { pass: true, reason: `it targets ${pr.baseRef}, not ${config.base}` }
  const own = pr.fromFork === false
  if (own && pr.headRef.startsWith(config.prefix)) return { pass: true, reason: `${pr.headRef} is the candidate` }
  if (isHotfix(config, { headRef: own ? pr.headRef : '', labels: pr.labels ?? [] }))
    return { pass: true, reason: `a hotfix stays on ${config.base}` }
  if (own && matchAutomated(config.automated, pr))
    return { pass: true, reason: `a pull request of ${pr.author} (delivery.automated) stays on ${config.base}` }
  return {
    pass: false,
    reason:
      `#${pr.number} targets ${config.base} and is neither the candidate nor a hotfix: the candidate automation did not move it ` +
      `(an event GitHub dropped, a fork). Move it with \`pnpm exec lntt ci candidate --pr ${pr.number}\`, ` +
      `or keep it on ${config.base} as a hotfix with the \`${config.hotfix.label}\` label. docs/process/delivery.md.`,
  }
}

const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+((?:[\w.-]+\/[\w.-]+)?#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)\b/gi

// The issues a body closes, as written after the keyword (`#12`, `owner/repo#12`, or an
// issue URL, given as `owner/repo#12`), in order and once each. Fenced code, inline code and HTML comments do not count, as on
// GitHub.
export function closingReferences(body: string | null | undefined): string[] {
  const text = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
  const refs: string[] = []
  for (const match of text.matchAll(CLOSING)) {
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/i.exec(match[1])
    const ref = url ? `${url[1]}#${url[2]}` : match[1]
    if (!refs.includes(ref)) refs.push(ref)
  }
  return refs
}

function between(body: string, start: string, end: string): string[] | null {
  const from = body.indexOf(start)
  const to = body.indexOf(end)
  if (from < 0 || to < from) return null
  return body
    .slice(from + start.length, to)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function replaceBetween(body: string, start: string, end: string, lines: string[]): string {
  const block = [start, ...lines, end].join('\n')
  const from = body.indexOf(start)
  const to = body.indexOf(end)
  if (from < 0 || to < from) return `${body.trimEnd()}\n\n${block}\n`
  return body.slice(0, from) + block + body.slice(to + end.length)
}

// A candidate branch with no pull request, open or closed, newer than every
// candidate pull request: a creation that stopped between the branch and its pull
// request. The next candidate picks it up instead of skipping a number.
export function orphanCandidate(
  config: CandidateConfig,
  { branches, prHeads }: { branches: string[]; prHeads: string[] },
): string | null {
  const newestPr = Math.max(0, ...prHeads.map((name) => candidateNumber(config, name) ?? 0))
  const orphans = branches
    .filter((name) => (candidateNumber(config, name) ?? 0) > newestPr && !prHeads.includes(name))
    .sort((a, b) => (candidateNumber(config, b) ?? 0) - (candidateNumber(config, a) ?? 0))
  return orphans[0] ?? null
}

// The merged candidate pull request: `<prefix><N>` → base.
export function isCandidateMerge(config: CandidateConfig, pr: Pick<PullRequest, 'merged' | 'baseRef' | 'headRef'>) {
  return pr.merged && pr.baseRef === config.base && candidateNumber(config, pr.headRef) !== null
}

// The open pull requests a merged candidate leaves behind: those still on it, and
// those on the base whose last base change came from it (GitHub's own move when it
// deletes the merged branch). Hotfixes, candidates and the bots' (delivery.automated) stay.
export function carryOverDecision(
  config: CandidateConfig,
  { candidateBranch, openPrs }: { candidateBranch: string; openPrs: OpenPullRequest[] },
): { move: number[] } {
  const move = openPrs
    .filter((pr) => {
      const leftBehind =
        pr.baseRef === candidateBranch || (pr.baseRef === config.base && pr.lastBaseChange?.from === candidateBranch)
      return leftBehind && retargetDecision(config, { ...pr, baseRef: config.base }).move
    })
    .map((pr) => pr.number)
    .sort((a, b) => a - b)
  return { move }
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// Open pull requests stranded on a candidate that is no longer open: still based on
// it, or moved onto the base by GitHub when it was deleted. A dropped event (the
// concurrency group keeps one pending run) or a candidate closed without merging
// leaves them there; every run sweeps them onto the open candidate.
export function sweepDecision(
  config: CandidateConfig,
  { openPrs, openCandidates }: { openPrs: OpenPullRequest[]; openCandidates: string[] },
): { move: number[] } {
  const stranded = (branch: string | undefined) =>
    branch !== undefined && candidateNumber(config, branch) !== null && !openCandidates.includes(branch)
  const move = openPrs
    .filter(
      (pr) =>
        (stranded(pr.baseRef) || (pr.baseRef === config.base && stranded(pr.lastBaseChange?.from))) &&
        retargetDecision(config, { ...pr, baseRef: config.base }).move,
    )
    .map((pr) => pr.number)
    .sort((a, b) => a - b)
  return { move }
}

// How the open candidate follows the base when the base moved: rebased when nobody
// stands on it, the base merged into it when pull requests are open into it, so their
// branches keep the candidate's commits. `behindBy` is the number of the base's commits
// the candidate lacks.
export function followDecision(
  config: CandidateConfig,
  { candidate, behindBy, prsInto }: { candidate: string | null; behindBy: number; prsInto: number[] },
): { path: 'none' | 'rebase' | 'merge'; reason: string } {
  if (candidate === null) return { path: 'none', reason: 'no candidate open' }
  if (behindBy === 0) return { path: 'none', reason: `${config.base} is an ancestor of ${candidate}` }
  if (prsInto.length === 0) {
    return { path: 'rebase', reason: `${config.base} moved and no pull request is open into ${candidate}: rebase` }
  }
  const prs = [...prsInto].sort((a, b) => a - b)
  return {
    path: 'merge',
    reason: `${config.base} moved and ${prs.map((n) => `#${n}`).join(', ')} ${prs.length === 1 ? 'is' : 'are'} open into ${candidate}: merge ${config.base} into it, no rewrite`,
  }
}

export function candidateBody(config: CandidateConfig, n: number): string {
  return [
    `${sentence(candidateName(config))} ${n}: pull requests into \`${config.base}\` land here, and merging this pull request brings them to \`${config.base}\` together, one commit each (rebase merge).`,
    'The automation keeps the two lists below up to date at every merge into the candidate (docs/process/delivery.md).',
    '',
    '## Pull requests',
    '',
    PRS_START,
    PRS_END,
    '',
    '## Issues closed on merge',
    '',
    CLOSES_START,
    CLOSES_END,
    '',
  ].join('\n')
}

// The comment a new candidate opens with: the batch's retrospective block, empty, filled
// with `lntt retro add` as friction is met and checked by `lntt check body` before the
// candidate is marked ready. The automation never rewrites it, unlike the body.
export function retrospectiveComment(config: CandidateConfig): string {
  return [
    `The retrospective of this ${candidateName(config)}: the friction that belongs to the batch and to no single pull request, appended as it is met with \`pnpm exec lntt retro add --label <label> "<one sentence>"\` (the \`retrospective\` skill). Every label holds a value or none before the ${candidateName(config)} is marked ready (\`pnpm exec lntt check body --pr <n>\`).`,
    '',
    config.retrospective,
  ].join('\n')
}

// The two lists rebuilt from `prs`, in the order given (merge order): `- #<pr> <title>`
// per pull request, then the `Closes <ref>` lines they bring. A line no pull request
// accounts for (written by hand) stays, after the rebuilt ones.
export function recordMerges(
  body: string | null | undefined,
  prs: Array<{ number: number; title: string; closes: string[] }>,
): string {
  let next = body ?? ''
  const isLineOf = (line: string, number: number) => line.startsWith(`- #${number} `) || line === `- #${number}`
  const prLines = prs.map(({ number, title }) => `- #${number} ${title}`.trimEnd())
  const otherPrLines = (between(next, PRS_START, PRS_END) ?? []).filter(
    (line) => !prs.some(({ number }) => isLineOf(line, number)),
  )
  next = replaceBetween(next, PRS_START, PRS_END, [...prLines, ...otherPrLines])
  const closes: string[] = []
  for (const ref of prs.flatMap((pr) => pr.closes)) {
    const line = `Closes ${ref}`
    if (!closes.includes(line)) closes.push(line)
  }
  const otherCloses = (between(next, CLOSES_START, CLOSES_END) ?? []).filter((line) => !closes.includes(line))
  return replaceBetween(next, CLOSES_START, CLOSES_END, [...closes, ...otherCloses])
}

// The issue number of a reference in `repo`: `#12`, or `owner/repo#12` with the same
// repo in any case. A reference to another repository is null.
export function issueNumber(ref: string, repo: string): number | null {
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/.exec(ref ?? '')
  if (!match) return null
  if (match[1] !== undefined && match[1].toLowerCase() !== repo.toLowerCase()) return null
  return Number(match[2])
}

export function announceMarker(candidateBranch: string): string {
  return `<!-- candidate:${candidateBranch} -->`
}

export function announceComment(
  config: CandidateConfig,
  { candidateBranch, candidatePr }: { candidateBranch: string; candidatePr: number },
): string {
  return [
    announceMarker(candidateBranch),
    `The merge of ${candidateName(config)} ${candidateNumber(config, candidateBranch)} (#${candidatePr}) will close this issue: the work is on \`${candidateBranch}\` and reaches \`${config.base}\` with it (docs/process/delivery.md).`,
  ].join('\n')
}

export function isAnnounced(comments: Array<string | null>, candidateBranch: string): boolean {
  const marker = announceMarker(candidateBranch)
  return comments.some((body) => (body ?? '').includes(marker))
}

// What the candidate's merge does to the issues of its body: open ones close, closed
// ones and pull requests stay.
export function closeDecision(issues: Array<{ number: number; state: string; isPr: boolean }>) {
  const decision = { close: [] as number[], alreadyClosed: [] as number[], notIssues: [] as number[] }
  for (const issue of issues) {
    if (issue.isPr) decision.notIssues.push(issue.number)
    else if (issue.state.toLowerCase() === 'closed') decision.alreadyClosed.push(issue.number)
    else decision.close.push(issue.number)
  }
  return decision
}

export function movedComment(
  config: CandidateConfig,
  { number, candidateBranch, candidatePr }: { number: number; candidateBranch: string; candidatePr: number | string },
): string {
  return [
    `This pull request now targets \`${candidateBranch}\`, the open candidate (#${candidatePr}): it reaches \`${config.base}\` with the candidate's merge, which also closes its issues.`,
    '',
    `A hotfix stays on \`${config.base}\`: add the \`${config.hotfix.label}\` label and move it back with \`gh pr edit ${number} --base ${config.base}\` (or name the branch \`${config.hotfix.prefix}…\`). docs/process/delivery.md.`,
  ].join('\n')
}

// The closing references of a candidate body: its `Closes` block only, so a title in
// the pull request list (`fix: #12 …`) closes nothing. A body without the block counts
// whole.
export function candidateClosingReferences(body: string | null | undefined): string[] {
  const closes = between(body ?? '', CLOSES_START, CLOSES_END)
  return closingReferences(closes === null ? body : closes.join('\n'))
}

// --- Plain pieces the steps use --------------------------------------------------

// In Actions, git authenticates to github.com with the token through its environment
// (an extra header, as actions/checkout sets it), never through its arguments, so the
// token shows in no command line and no log.
export function gitAuthEnv(env: Record<string, string | undefined>): Record<string, string> {
  const token = env.GH_TOKEN
  if (!env.GITHUB_ACTIONS || !token) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

// The client for the board: the Projects token when the workflow has one, none inside
// a workflow without it (the board is left as it is, with a notice), the operator's own
// client in a terminal.
export function pickBoard<T>(token: string | undefined, inWorkflow: boolean, own: T, withToken: (t: string) => T) {
  if (token) return withToken(token)
  return inWorkflow ? undefined : own
}

export interface CandidatePr {
  number: number
  headRefName: string
  // The candidate's head when it was read.
  headRefOid?: string
  body?: string
  // Created by this run: it has no comment yet.
  created?: boolean
}

// One line: a workflow command ends at the first newline, and `%` starts an escape.
const workflowLine = (text: string) => text.replaceAll('%', '%25').replace(/\r?\n/g, ' ')

export interface Comment {
  id: number
  body: string
}

// Every comment of a pull request, in order, read page by page.

const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number baseRefName headRefName
        author { login }
        labels(first: 50) { nodes { name } }
        timelineItems(last: 1, itemTypes: [BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT]) {
          nodes {
            __typename
            ... on BaseRefChangedEvent { previousRefName currentRefName }
            ... on AutomaticBaseChangeSucceededEvent { oldBase newBase }
          }
        }
      }
    }
  }
}`

interface PrNode {
  number: number
  baseRefName: string
  headRefName: string
  author?: { login: string } | null
  labels: { nodes: Array<{ name: string }> }
  timelineItems: {
    nodes: Array<{ previousRefName?: string; currentRefName?: string; oldBase?: string; newBase?: string }>
  }
}

const list = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ') || 'none'

// --- The board ------------------------------------------------------------------

const BOARD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      projectItems(first: 50) {
        nodes {
          id
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } }
          project {
            id
            title
            field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
          }
        }
      }
    }
  }
}`

export const BOARD_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`

interface BoardItem {
  id: string
  fieldValueByName?: { optionId?: string } | null
  project: { id: string; title: string; field?: { id?: string; options?: Array<{ id: string; name: string }> } | null }
}

export const NOT_PERMITTED = /resource not accessible|forbidden|insufficient|required scope|has not been granted/i

// --- Following the base ---------------------------------------------------------

export interface FollowResult {
  path: 'none' | 'rebase' | 'merge'
  reason: string
  // Nothing to do; no git in this run; the candidate or the base moved between the API
  // read and the fetch (the next run sees it); a conflict; a refused push; updated.
  outcome: 'none' | 'no-git' | 'moved-meanwhile' | 'conflict' | 'refused' | 'updated'
  // The candidate's new head, pushed (or, in a dry run, the one that would be).
  head?: string
  // The files in conflict.
  files?: string[]
}

const short = (sha: string) => sha.slice(0, 8)

// The markers that keep a rerun from repeating a comment: a conflict or a refusal once
// per base and candidate head, an update once per new head.
export function followMarker(base: string, oldHead: string): string {
  return `<!-- candidate:follow:${base}:${oldHead} -->`
}

export function followedMarker(newHead: string): string {
  return `<!-- candidate:followed:${newHead} -->`
}

interface FollowFacts {
  candidate: string
  base: string
  oldHead: string
  path: 'rebase' | 'merge'
  prsInto: number[]
}

const followWhy = (facts: FollowFacts) =>
  facts.path === 'rebase'
    ? 'no pull request is open into it'
    : `${facts.prsInto.map((n) => `#${n}`).join(', ')} ${facts.prsInto.length === 1 ? 'is' : 'are'} open into it`

function manualSteps(config: CandidateConfig, { candidate }: FollowFacts): string[] {
  return [
    '```sh',
    'git fetch origin',
    `git switch ${candidate}`,
    `git merge origin/${config.base}   # or, with no pull request open into it: git rebase origin/${config.base}`,
    '# resolve the conflicts, then commit (or git rebase --continue)',
    'git push                  # after a rebase: git push --force-with-lease',
    '```',
  ]
}

export function followConflictComment(config: CandidateConfig, facts: FollowFacts, files: string[]): string {
  const step = facts.path === 'rebase' ? `the rebase on it` : `the merge of it`
  return [
    followMarker(facts.base, facts.oldHead),
    `\`${config.base}\` moved to \`${short(facts.base)}\` and \`${facts.candidate}\` cannot follow it by itself: ${step} (${followWhy(facts)}) stops on a conflict in:`,
    '',
    ...files.map((file) => `- \`${file}\``),
    '',
    `Nothing was pushed: \`${facts.candidate}\` stays at \`${short(facts.oldHead)}\`. An admin brings it up to date, as only the ruleset's bypass actors push to it directly (docs/process/delivery.md):`,
    '',
    ...manualSteps(config, facts),
  ].join('\n')
}

export function followRefusedComment(config: CandidateConfig, facts: FollowFacts, error: string): string {
  const done = facts.path === 'rebase' ? 'rebased on it' : `merged with it`
  return [
    followMarker(facts.base, facts.oldHead),
    `\`${config.base}\` moved to \`${short(facts.base)}\`: \`${facts.candidate}\` was ${done} (${followWhy(facts)}), and the push was refused:`,
    '',
    `> ${error}`,
    '',
    `Nothing was pushed: \`${facts.candidate}\` stays at \`${short(facts.oldHead)}\`. GitHub refuses a push of the app that changes a workflow file (it has no Workflows permission), and the lease refuses one when someone pushed to the candidate meanwhile. An admin brings it up to date, as only the ruleset's bypass actors push to it directly (docs/process/delivery.md):`,
    '',
    ...manualSteps(config, facts),
  ].join('\n')
}

export function followedComment(config: CandidateConfig, facts: FollowFacts, newHead: string): string {
  const what =
    facts.path === 'rebase'
      ? `\`${facts.candidate}\` was rebased on it, as ${followWhy(facts)}`
      : `it was merged into \`${facts.candidate}\`, as ${followWhy(facts)}: no commit of the candidate was rewritten`
  return [
    followedMarker(newHead),
    `\`${config.base}\` moved to \`${short(facts.base)}\`: ${what}. Head: \`${short(facts.oldHead)}\` → \`${short(newHead)}\`.`,
    '',
    `The candidate's CI runs on the new head once the candidate is ready for review; a draft runs no cloud CI, so \`pnpm ci:local\` runs on it (docs/process/delivery.md).`,
  ].join('\n')
}

export function followedPrComment(config: CandidateConfig, facts: FollowFacts, newHead: string): string {
  return [
    followedMarker(newHead),
    `\`${config.base}\` moved to \`${short(facts.base)}\` and was merged into \`${facts.candidate}\`, the base of this pull request (\`${short(facts.oldHead)}\` → \`${short(newHead)}\`). This branch follows with a merge or a rebase of \`${facts.candidate}\` of its own: \`git fetch origin\`, then \`git merge origin/${facts.candidate}\` (or \`git rebase origin/${facts.candidate}\` and \`git push --force-with-lease\`).`,
  ].join('\n')
}

// The line of git's error that says why: the rejected ref, else the first error.
function pushError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return (
    lines.find((line) => line.startsWith('!')) ??
    lines.find((line) => /^(error|fatal|remote):/.test(line)) ??
    lines[0] ??
    'no message'
  )
}

export function readyMarker(candidateBranch: string): string {
  return `<!-- candidate:ready:${candidateBranch} -->`
}

export interface ReadyReport {
  moved: Array<{ number: number; evidence: string }>
  already: Array<{ number: number; evidence: string }>
  left: Array<{ number: number; evidence: string; why: string }>
}

export function readyComment(rules: ReadyRules, candidateBranch: string, report: ReadyReport): string {
  const { initial, ready } = rules.status
  const section = (title: string, lines: string[]) => (lines.length > 0 ? ['', title, '', ...lines] : [])
  return [
    readyMarker(candidateBranch),
    `The merge of \`${candidateBranch}\` closed issues that others were waiting on (the Ready check, docs/process/board.md).`,
    ...section(
      `Moved to ${ready}:`,
      report.moved.map(({ number, evidence }) => `- #${number}: ${evidence}.`),
    ),
    ...section(
      `Already at ${ready}:`,
      report.already.map(({ number, evidence }) => `- #${number}: ${evidence}.`),
    ),
    ...section(
      `Left at ${initial}:`,
      report.left.map(({ number, evidence, why }) => `- #${number}: ${why} (${evidence}).`),
    ),
  ].join('\n')
}

interface EventPullRequest {
  number: number
  title: string
  body: string | null
  base: { ref: string; repo?: { full_name: string } | null }
  head: { ref: string; repo?: { full_name: string } | null }
  labels?: Array<{ name: string }>
  merged?: boolean
  user?: { login: string } | null
}

export function prFromEvent(event: { pull_request: EventPullRequest }): PullRequest {
  const pr = event.pull_request
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    labels: (pr.labels ?? []).map((label) => label.name),
    merged: Boolean(pr.merged),
    ...(pr.user?.login ? { author: pr.user.login } : {}),
    // A head repository GitHub deleted (a fork removed) is null: not this repository.
    ...(pr.base.repo ? { fromFork: pr.head.repo?.full_name !== pr.base.repo.full_name } : {}),
  }
}

// --- I/O ------------------------------------------------------------------------
//
// What reads or writes GitHub and git is an Effect over the Gh service (the repository's token),
// Board (the Projects token's Gh, when the run has one) and Git (the local clone), each a typed
// operation (src/gh/gh.ts, src/git/git.ts). A dry run is a layer of each that prints the writes and
// the push instead of making them. What fails a step is a CandidateFailed, or the GhError or
// GitError of the call that failed; a step that goes on past a failure reads its message.

// A step of the automation that failed, by its message.
export class CandidateFailed extends Data.TaggedError('CandidateFailed')<{ message: string }> {}

// The Projects token's client: null when the run has none, and the board is not moved.
export class Board extends Context.Service<Board, { readonly gh: GhOperations | null }>()(
  '@lntt/lntt/ci/candidate/Board',
) {
  static readonly none = Layer.succeed(Board)(Board.of({ gh: null }))
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

export interface Comment {
  id: number
  body: string
}

// Every comment of a pull request, in order, read page by page, through a synchronous client of gh
// (lntt check body, src/check-cli.ts).
export function comments(gh: { read: (args: string[]) => string }, repo: string, number: number): Comment[] {
  return gh
    .read(['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '.[] | {id, body}'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Comment)
}

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
    yield* gh.commentPullRequest({ repo, number: candidate.number, body: retrospectiveComment(config) })
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

function localIssues({ repo, log }: Pick<Run, 'repo' | 'log'>, refs: string[]): number[] {
  const numbers: number[] = []
  for (const ref of refs) {
    const number = issueNumber(ref, repo)
    if (number === null) log(`candidate: ${ref} is in another repository, skipping it.`)
    else if (!numbers.includes(number)) numbers.push(number)
  }
  return numbers
}

// Runs `step` on each number, going on past a failure; the failures are returned, so
// one wrong number does not leave the others behind.
const eachIssue = <E, R>(numbers: number[], step: (number: number) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const failures: string[] = []
    for (const number of numbers) {
      const result = yield* Effect.result(step(number))
      if (result._tag === 'Failure') failures.push(`#${number}: ${messageOf(result.failure)}`)
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
      const result = yield* Effect.result(step)
      if (result._tag === 'Failure') errors.push(messageOf(result.failure))
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
