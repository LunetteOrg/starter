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

import { type Automated, matchAutomated } from '../automated.ts'
import { candidateNumber as numberOf } from '../base/names.ts'
import type { ReadyRules } from '../board-ready.ts'

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

// --- Plain pieces the steps use (src/ci/candidate-steps.ts) ----------------------

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
export const workflowLine = (text: string) => text.replaceAll('%', '%25').replace(/\r?\n/g, ' ')

export interface Comment {
  id: number
  body: string
}

export const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $endCursor: String) {
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

export interface PrNode {
  number: number
  baseRefName: string
  headRefName: string
  author?: { login: string } | null
  labels: { nodes: Array<{ name: string }> }
  timelineItems: {
    nodes: Array<{ previousRefName?: string; currentRefName?: string; oldBase?: string; newBase?: string }>
  }
}

export const list = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ') || 'none'

// --- The board ------------------------------------------------------------------

export const BOARD_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
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

export interface BoardItem {
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

export const short = (sha: string) => sha.slice(0, 8)

// The markers that keep a rerun from repeating a comment: a conflict or a refusal once
// per base and candidate head, an update once per new head.
export function followMarker(base: string, oldHead: string): string {
  return `<!-- candidate:follow:${base}:${oldHead} -->`
}

export function followedMarker(newHead: string): string {
  return `<!-- candidate:followed:${newHead} -->`
}

export interface FollowFacts {
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
export function pushError(stderr: string): string {
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

// Every comment of a pull request, in order, read page by page, through a synchronous client of gh
// (lntt check body, src/check-cli.ts).
export function comments(gh: { read: (args: string[]) => string }, repo: string, number: number): Comment[] {
  return gh
    .read(['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '.[] | {id, body}'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Comment)
}

// The issues of this repository that `refs` name, once each; another repository's is skipped,
// with a line.
export function localIssues({ repo, log }: { repo: string; log: (line: string) => void }, refs: string[]): number[] {
  const numbers: number[] = []
  for (const ref of refs) {
    const number = issueNumber(ref, repo)
    if (number === null) log(`candidate: ${ref} is in another repository, skipping it.`)
    else if (!numbers.includes(number)) numbers.push(number)
  }
  return numbers
}
