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
//   there are some.
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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Automated, matchAutomated } from '../automated.ts'
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

export interface Gh {
  read: (args: string[]) => string
  write: (args: string[], input?: string) => string
}

// git on the local clone. `run` always executes (it only touches the clone and its
// worktrees); `push` is the one command that writes to the remote, so a dry run logs
// it instead.
export interface Git {
  run: (args: string[]) => { status: number; stdout: string; stderr: string }
  push: (args: string[]) => { status: number; stderr: string }
}

export interface Run {
  gh: Gh
  // The local clone, for following the base; without it the follow step does nothing.
  git?: Git
  // The same commands with a token that has the Projects permission; without it the
  // board is not moved.
  board?: Gh
  repo: string
  config: CandidateConfig
  log: (line: string) => void
}

const PRS_START = '<!-- candidate:prs:start -->'
const PRS_END = '<!-- candidate:prs:end -->'
const CLOSES_START = '<!-- candidate:closes:start -->'
const CLOSES_END = '<!-- candidate:closes:end -->'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// `candidate/` → `candidate`: the word titles and messages use.
export function candidateName(config: CandidateConfig): string {
  return config.prefix.replace(/[/\-_.]+$/, '') || config.prefix
}

// The candidate number of a branch name, or null.
export function candidateNumber(config: CandidateConfig, name: string | undefined): number | null {
  const match = new RegExp(`^${escapeRegExp(config.prefix)}(\\d+)$`).exec(name ?? '')
  return match ? Number(match[1]) : null
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

// --- I/O ------------------------------------------------------------------------

export function makeGh({ dryRun, log, token }: { dryRun: boolean; log: (line: string) => void; token?: string }): Gh {
  // gh's own refusal text (a token without a permission) is in stderr, so it goes into
  // the error: callers tell a refused token from a broken connection by it.
  const run = (args: string[], input?: string) => {
    const result = spawnSync('gh', args, {
      encoding: 'utf8',
      input,
      ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
    })
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) throw result.error
    if (result.status !== 0) {
      const detail = result.stderr.trim()
      throw new Error(`Command failed: gh ${args.slice(0, 2).join(' ')}${detail ? `: ${detail}` : ''}`)
    }
    return result.stdout.trim()
  }
  return {
    read: (args) => run(args),
    write: (args, input) => {
      if (dryRun) {
        log(`[dry-run] gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
        if (input !== undefined) log(`[dry-run] stdin:\n${input}`)
        return ''
      }
      return run(args, input)
    },
  }
}

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

// The project's hooks do not run on the automation's own rebase and push.
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

export function makeGit({
  dryRun,
  log,
  cwd,
  env,
}: {
  dryRun: boolean
  log: (line: string) => void
  cwd: string
  env: Record<string, string | undefined>
}): Git {
  const childEnv = { ...env, ...gitAuthEnv(env) }
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd, env: childEnv, encoding: 'utf8' })
    if (result.error) throw result.error
    return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr }
  }
  return {
    run,
    push: (args) => {
      if (dryRun) {
        log(`[dry-run] git push ${args.join(' ')}`)
        return { status: 0, stderr: '' }
      }
      return run([...NO_HOOKS, 'push', ...args])
    },
  }
}

// The client for the board: the Projects token when the workflow has one, none inside
// a workflow without it (the board is left as it is, with a notice), the operator's own
// client in a terminal.
export function pickBoard<T>(token: string | undefined, inWorkflow: boolean, own: T, withToken: (t: string) => T) {
  if (token) return withToken(token)
  return inWorkflow ? undefined : own
}

interface CandidatePr {
  number: number
  headRefName: string
  // The candidate's head when it was read.
  headRefOid?: string
  body?: string
  // Created by this run: it has no comment yet.
  created?: boolean
}

function openCandidates({ gh, repo, config }: Pick<Run, 'gh' | 'repo' | 'config'>): CandidatePr[] {
  const prs = JSON.parse(
    gh.read([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--base',
      config.base,
      '--search',
      `head:${config.prefix}`,
      '--json',
      'number,headRefName,headRefOid,body',
    ]),
  ) as CandidatePr[]
  return prs
    .filter((pr) => candidateNumber(config, pr.headRefName) !== null)
    .sort((a, b) => (candidateNumber(config, a.headRefName) ?? 0) - (candidateNumber(config, b.headRefName) ?? 0))
}

export function openCandidate(run: Pick<Run, 'gh' | 'repo' | 'config'>): CandidatePr | null {
  return openCandidates(run)[0] ?? null
}

function candidateNames({ gh, repo, config }: Run) {
  const refs = JSON.parse(gh.read(['api', `repos/${repo}/git/matching-refs/heads/${config.prefix}`])) as Array<{
    ref: string
  }>
  const prs = JSON.parse(
    gh.read([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--search',
      `head:${config.prefix}`,
      '--limit',
      '100',
      '--json',
      'headRefName',
    ]),
  ) as Array<{ headRefName: string }>
  return {
    branches: refs.map((ref) => ref.ref.replace(/^refs\/heads\//, '')),
    prHeads: prs.map((pr) => pr.headRefName),
  }
}

// Creates `<prefix><n>` from the base with a draft pull request. GitHub refuses a pull
// request between identical branches, so the branch starts with an empty commit. A
// branch an earlier run left without its pull request is reused, pull request only.
function createCandidate(run: Run): CandidatePr {
  const { gh, repo, config, log } = run
  const names = candidateNames(run)
  const orphan = orphanCandidate(config, names)
  const n = orphan
    ? (candidateNumber(config, orphan) as number)
    : nextCandidateNumber(config, [...names.branches, ...names.prHeads])
  const branch = `${config.prefix}${n}`
  const name = candidateName(config)
  if (orphan) {
    log(`candidate: no candidate open, ${branch} exists without a pull request: picking it up.`)
  } else {
    const head = JSON.parse(gh.read(['api', `repos/${repo}/commits/${config.base}`])) as {
      sha: string
      commit: { tree: { sha: string } }
    }
    log(`candidate: no candidate open, creating ${branch} from ${config.base} @ ${head.sha.slice(0, 8)}.`)
    const commit = gh.write([
      'api',
      `repos/${repo}/git/commits`,
      '-f',
      `message=chore: open ${name} ${n}`,
      '-f',
      `tree=${head.commit.tree.sha}`,
      '-f',
      `parents[]=${head.sha}`,
      '--jq',
      '.sha',
    ])
    gh.write([
      'api',
      `repos/${repo}/git/refs`,
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${commit || '<sha of the empty commit>'}`,
    ])
  }
  const url = gh.write(
    [
      'pr',
      'create',
      '--repo',
      repo,
      '--draft',
      '--base',
      config.base,
      '--head',
      branch,
      '--title',
      `${name} ${n}`,
      '--body-file',
      '-',
    ],
    candidateBody(config, n),
  )
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0)
  return { number, headRefName: branch, created: true }
}

// One line: a workflow command ends at the first newline, and `%` starts an escape.
const workflowLine = (text: string) => text.replaceAll('%', '%25').replace(/\r?\n/g, ' ')

export interface Comment {
  id: number
  body: string
}

// Every comment of a pull request, in order, read page by page.
export function comments(gh: Gh, repo: string, number: number): Comment[] {
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
function ensureRetrospective(run: Run, candidate: CandidatePr) {
  const { gh, repo, config, log } = run
  try {
    if (!candidate.created && retroComment(comments(gh, repo, candidate.number)) !== null) return
    if (!candidate.created) log(`candidate: ${candidate.headRefName} has no retrospective comment: writing it.`)
    gh.write(
      ['pr', 'comment', candidate.number ? String(candidate.number) : '<new>', '--repo', repo, '--body-file', '-'],
      retrospectiveComment(config),
    )
  } catch (error) {
    log(
      `::warning title=Retrospective comment::${candidate.headRefName}: not written (${workflowLine((error as Error).message)}); pnpm exec lntt retro add writes it`,
    )
  }
}

function moveOnto({ gh, repo, config }: Run, number: number, candidate: CandidatePr) {
  gh.write(['pr', 'edit', String(number), '--repo', repo, '--base', candidate.headRefName])
  gh.write(
    ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'],
    movedComment(config, { number, candidateBranch: candidate.headRefName, candidatePr: candidate.number || '<new>' }),
  )
}

export function retarget(run: Run, pr: PullRequest) {
  const decision = retargetDecision(run.config, pr)
  run.log(
    `candidate: #${pr.number} (${pr.headRef} → ${pr.baseRef}): ${decision.move ? 'moving it' : 'it stays'}, ${decision.reason}.`,
  )
  if (!decision.move) return decision
  const candidate = openCandidate(run) ?? createCandidate(run)
  run.log(`candidate: open candidate ${candidate.headRefName} (#${candidate.number || '<new>'}).`)
  ensureRetrospective(run, candidate)
  moveOnto(run, pr.number, candidate)
  return decision
}

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

// Every open pull request, with its last base change.
function openPrs({ gh, repo }: Run): OpenPullRequest[] {
  const [owner, name] = repo.split('/')
  const out = gh.read([
    'api',
    'graphql',
    '--paginate',
    '-f',
    `query=${OPEN_PRS_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '--jq',
    '[.data.repository.pullRequests.nodes[]]',
  ])
  return out
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => JSON.parse(line) as PrNode[])
    .map((pr) => {
      const change = pr.timelineItems.nodes[0]
      return {
        number: pr.number,
        baseRef: pr.baseRefName,
        headRef: pr.headRefName,
        author: pr.author?.login,
        labels: pr.labels.nodes.map((label) => label.name),
        lastBaseChange: change
          ? {
              from: (change.previousRefName ?? change.oldBase) as string,
              to: (change.currentRefName ?? change.newBase) as string,
            }
          : null,
      }
    })
}

// The merged candidate leaves open pull requests behind: they go onto the next
// candidate, created only when there is at least one.
export function carryOver(run: Run, pr: PullRequest) {
  const candidateBranch = pr.headRef
  const { move } = carryOverDecision(run.config, { candidateBranch, openPrs: openPrs(run) })
  if (move.length === 0) {
    run.log(
      `candidate: ${candidateBranch} merged, no open pull request to move: the next one creates the next candidate.`,
    )
    return { move }
  }
  const candidate = openCandidate(run) ?? createCandidate(run)
  run.log(
    `candidate: ${candidateBranch} merged, moving ${move.map((n) => `#${n}`).join(', ')} onto ${candidate.headRefName}.`,
  )
  ensureRetrospective(run, candidate)
  for (const number of move) moveOnto(run, number, candidate)
  return { move }
}

function readIssue({ gh, repo }: Run, number: number) {
  const issue = JSON.parse(
    gh.read(['api', `repos/${repo}/issues/${number}`, '--jq', '{state: .state, isPr: (.pull_request != null)}']),
  ) as { state: string; isPr: boolean }
  return { number, state: issue.state, isPr: issue.isPr }
}

function issueComments({ gh, repo }: Run, number: number): string[] {
  return gh
    .read(['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '[.[].body]'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => JSON.parse(line) as string[])
}

function localIssues({ repo, log }: Run, refs: string[]): number[] {
  const numbers: number[] = []
  for (const ref of refs) {
    const number = issueNumber(ref, repo)
    if (number === null) log(`candidate: ${ref} is in another repository, skipping it.`)
    else if (!numbers.includes(number)) numbers.push(number)
  }
  return numbers
}

const list = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ') || 'none'

// Runs `step` on each number, going on past a failure; the failures are returned, so
// one wrong number does not leave the others behind.
function eachIssue(numbers: number[], step: (number: number) => void): string[] {
  const failed: string[] = []
  for (const number of numbers) {
    try {
      step(number)
    } catch (error) {
      failed.push(`#${number}: ${(error as Error).message}`)
    }
  }
  return failed
}

function failIfAny(failed: string[], what: string) {
  if (failed.length > 0) throw new Error(`${what}: ${failed.join('; ')}`)
}

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

// Moves each issue to `status` on every Project it is on that has that status. An issue
// with no project that can take the status is told in a `::notice` and returned in
// `skipped`; one already at the status everywhere is in neither list; one moved on some
// projects and refused on a later one is in `moved`, with a notice for the refusal, and
// its remaining projects are not tried. Only a failure that is not a refusal of the
// token throws, after the other issues are done.
export function setBoardStatus(run: Run, issues: number[], status: string) {
  const moved: number[] = []
  const skipped: number[] = []
  const { board, repo, log } = run
  if (issues.length === 0) return { moved, skipped }
  if (!board) {
    log(
      `::notice title=Board not moved::no token with the Projects permission: ${list(issues)} stay on their status instead of "${status}" (docs/process/delivery.md)`,
    )
    return { moved, skipped: [...issues] }
  }
  const [owner, name] = repo.split('/')
  const moveOne = (number: number) => {
    const out = JSON.parse(
      board.read([
        'api',
        'graphql',
        '-f',
        `query=${BOARD_QUERY}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ]),
    ) as { data: { repository: { issue: { projectItems: { nodes: BoardItem[] } } } } }
    const nodes = out.data.repository.issue.projectItems.nodes
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
      board.write([
        'api',
        'graphql',
        '-f',
        `query=${BOARD_MUTATION}`,
        '-f',
        `project=${node.project.id}`,
        '-f',
        `item=${node.id}`,
        '-f',
        `field=${field.id}`,
        '-f',
        `option=${option.id}`,
      ])
      if (!moved.includes(number)) moved.push(number)
    }
    if (!found) skipped.push(number)
  }
  const failed = eachIssue(issues, (number) => {
    try {
      moveOne(number)
    } catch (error) {
      const message = (error as Error).message
      if (!NOT_PERMITTED.test(message)) throw error
      log(
        `::notice title=Board not moved::the token lacks the Projects permission on a project of #${number}, which is not moved to "${status}" there: ${message.split('\n')[0]}`,
      )
      // A project written before the refusal stays moved: the issue is in `moved` and
      // is not skipped.
      if (!moved.includes(number) && !skipped.includes(number)) skipped.push(number)
    }
  })
  log(`candidate: board "${status}": moved ${list(moved)}; skipped ${list(skipped)}.`)
  failIfAny(failed, `issues not moved to "${status}"`)
  return { moved, skipped }
}

// The candidate is merged: the issues of its `Closes` lines still open close as
// completed.
export function closeCandidateIssues(run: Run, pr: PullRequest) {
  const numbers = localIssues(run, candidateClosingReferences(pr.body))
  const issues: Array<{ number: number; state: string; isPr: boolean }> = []
  const unread = eachIssue(numbers, (number) => issues.push(readIssue(run, number)))
  const decision = closeDecision(issues)
  run.log(
    `candidate: ${pr.headRef} merged: closing ${list(decision.close)}; already closed ${list(decision.alreadyClosed)}.`,
  )
  if (decision.notIssues.length > 0) {
    run.log(`candidate: ${list(decision.notIssues)} are pull requests, not issues: skipping them.`)
  }
  const unclosed = eachIssue(decision.close, (number) =>
    run.gh.write(['issue', 'close', String(number), '--repo', run.repo, '--reason', 'completed']),
  )
  // The issues closed before the merge count too: one closed by hand after reaching
  // `In release` has nothing else to move it to `Done`.
  const errors: string[] = []
  try {
    failIfAny([...unread, ...unclosed], `issues not closed by the merge of ${pr.headRef}`)
  } catch (error) {
    errors.push((error as Error).message)
  }
  try {
    setBoardStatus(run, [...decision.close, ...decision.alreadyClosed], run.config.status.done)
  } catch (error) {
    errors.push((error as Error).message)
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
  return decision
}

// Tells each open issue that `prs` close that the candidate's merge will close it, once
// per issue and candidate: a comment carrying the candidate's marker is not written
// again.
function announceIssues(run: Run, candidate: CandidatePr, prs: Array<{ body: string }>) {
  const numbers = localIssues(
    run,
    prs.flatMap((pr) => closingReferences(pr.body)),
  )
  const announced: number[] = []
  const open: number[] = []
  const failed = eachIssue(numbers, (number) => {
    const issue = readIssue(run, number)
    if (issue.isPr || issue.state.toLowerCase() === 'closed') return
    open.push(number)
    if (isAnnounced(issueComments(run, number), candidate.headRefName)) return
    run.gh.write(
      ['issue', 'comment', String(number), '--repo', run.repo, '--body-file', '-'],
      announceComment(run.config, { candidateBranch: candidate.headRefName, candidatePr: candidate.number }),
    )
    announced.push(number)
  })
  run.log(
    `candidate: announcing ${candidate.headRefName} (#${candidate.number}) on ${list(announced)}, of ${list(numbers)}.`,
  )
  return { announced, open, failed }
}

export function announce(run: Run, candidate: CandidatePr, prs: Array<{ body: string }>) {
  const { announced, open, failed } = announceIssues(run, candidate, prs)
  failIfAny(failed, `issues without the announcement of ${candidate.headRefName}`)
  return { announced, open }
}

export function record(run: Run, pr: PullRequest) {
  const { gh, repo, config, log } = run
  if (!pr.merged || candidateNumber(config, pr.baseRef) === null) {
    log(`candidate: #${pr.number} is not a merge into a candidate, nothing to record.`)
    return { recorded: false }
  }
  const prs = JSON.parse(
    gh.read([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--head',
      pr.baseRef,
      '--base',
      config.base,
      '--json',
      'number,body',
    ]),
  ) as Array<{ number: number; body: string }>
  const candidate = prs[0]
  if (!candidate) {
    throw new Error(
      `no open pull request from ${pr.baseRef} into ${config.base}: the issues of #${pr.number} (${closingReferences(pr.body).join(', ') || 'none'}) are not recorded.`,
    )
  }
  // Every pull request merged into the candidate, in merge order: a run the
  // concurrency group dropped is caught up by the next one.
  const merged = (
    JSON.parse(
      gh.read([
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--base',
        pr.baseRef,
        '--limit',
        '500',
        '--json',
        'number,title,body,mergedAt',
      ]),
    ) as Array<{ number: number; title: string; body: string; mergedAt: string }>
  ).sort((a, b) => (a.mergedAt < b.mergedAt ? -1 : a.mergedAt > b.mergedAt ? 1 : 0))
  const all: Array<{ number: number; title: string; body: string }> = merged.some((m) => m.number === pr.number)
    ? merged
    : [...merged, pr]
  const body = recordMerges(
    candidate.body,
    all.map((m) => ({ number: m.number, title: m.title, closes: closingReferences(m.body) })),
  )
  const recorded = body !== candidate.body
  if (recorded) {
    log(
      `candidate: recording in #${candidate.number} the pull requests merged into ${pr.baseRef} (${list(all.map((m) => m.number))}).`,
    )
    gh.write(['pr', 'edit', String(candidate.number), '--repo', repo, '--body-file', '-'], body)
  } else {
    log(`candidate: #${pr.number} is already in #${candidate.number}.`)
  }
  // The board moves for the issues announced or not, and a failing comment is reported
  // after it: the next run finds both done.
  const { open, failed } = announceIssues(run, { number: candidate.number, headRefName: pr.baseRef }, all)
  const errors: string[] = []
  try {
    failIfAny(failed, `issues without the announcement of ${pr.baseRef}`)
  } catch (error) {
    errors.push((error as Error).message)
  }
  try {
    setBoardStatus(run, open, config.status.inRelease)
  } catch (error) {
    errors.push((error as Error).message)
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { recorded }
}

export function sweep(run: Run) {
  const candidates = openCandidates(run)
  const { move } = sweepDecision(run.config, {
    openPrs: openPrs(run),
    openCandidates: candidates.map((c) => c.headRefName),
  })
  if (move.length === 0) return { move }
  const candidate = candidates[0] ?? createCandidate(run)
  run.log(
    `candidate: ${move.map((n) => `#${n}`).join(', ')} stranded on a closed candidate: moving onto ${candidate.headRefName}.`,
  )
  ensureRetrospective(run, candidate)
  for (const number of move) moveOnto(run, number, candidate)
  return { move }
}

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

// Writes `body` on `number` unless a comment there already carries `marker`.
function commentOnce(run: Run, number: number, marker: string, body: string) {
  if (comments(run.gh, run.repo, number).some((c) => (c.body ?? '').includes(marker))) {
    run.log(`candidate: #${number} already has this comment.`)
    return
  }
  run.gh.write(['pr', 'comment', String(number), '--repo', run.repo, '--body-file', '-'], body)
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

// The candidate's new head, or the files in conflict.
function rebased(git: Git, oldHead: string, base: string): { head: string } | { files: string[] } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-follow-')))
  try {
    const add = git.run([...NO_HOOKS, 'worktree', 'add', '--detach', dir, oldHead])
    if (add.status !== 0) throw new Error(`git worktree add failed: ${pushError(add.stderr)}`)
    // The candidate opens with an empty commit, kept; merges of the base in its
    // history are dropped, their commits being in the base.
    const rebase = git.run(['-C', dir, ...NO_HOOKS, 'rebase', '--keep-empty', base])
    if (rebase.status === 0) return { head: git.run(['-C', dir, 'rev-parse', 'HEAD']).stdout }
    const files = git
      .run(['-C', dir, 'diff', '--name-only', '--diff-filter=U'])
      .stdout.split('\n')
      .filter((line) => line !== '')
    git.run(['-C', dir, ...NO_HOOKS, 'rebase', '--abort'])
    if (files.length === 0) throw new Error(`git rebase failed: ${pushError(rebase.stderr)}`)
    return { files }
  } finally {
    git.run(['worktree', 'remove', '--force', dir])
    rmSync(dir, { recursive: true, force: true })
  }
}

// The merge commit of the base into the candidate (parents: the candidate's head, then
// the base), or the files in conflict.
function merged(git: Git, facts: FollowFacts, base: string): { head: string } | { files: string[] } {
  const tree = git.run(['merge-tree', '--write-tree', '--name-only', '--no-messages', facts.oldHead, facts.base])
  const lines = tree.stdout.split('\n').filter((line) => line !== '')
  if (tree.status === 1) return { files: [...new Set(lines.slice(1))] }
  if (tree.status !== 0) throw new Error(`git merge-tree failed: ${pushError(tree.stderr)}`)
  const commit = git.run([
    'commit-tree',
    lines[0] ?? '',
    '-p',
    facts.oldHead,
    '-p',
    facts.base,
    '-m',
    `Merge ${base} into ${facts.candidate}`,
    '-m',
    `${base} at ${facts.base}.`,
  ])
  if (commit.status !== 0) throw new Error(`git commit-tree failed: ${pushError(commit.stderr)}`)
  return { head: commit.stdout }
}

// The open candidate follows the base when the base moved (followDecision): its commits
// rebased on the base and pushed with a lease on the head as read, or the base merged
// into it and pushed plainly. A conflict or a refused push leaves the candidate as it
// is, comments on its pull request what an admin does, and warns: it does not fail the
// run. A comment that fails after the push is a warning too. Every comment is written
// once (followMarker, followedMarker). In a dry run the fetch, the merge and the rebase
// still run on the local clone and a temporary worktree; only the push and the comments
// are printed.
export function follow(run: Run): FollowResult {
  const { gh, repo, config, log, git } = run
  if (!git) {
    log(
      `candidate: follow ${config.base}: no git client in this run, the candidate is left as it is (from a terminal, pnpm exec lntt ci candidate --follow follows it).`,
    )
    return { path: 'none', reason: 'no git client', outcome: 'no-git' }
  }
  const candidate = openCandidate(run)
  let behindBy = 0
  let base = ''
  let prsInto: number[] = []
  if (candidate) {
    const compare = JSON.parse(
      gh.read([
        'api',
        `repos/${repo}/compare/${config.base}...${candidate.headRefName}`,
        '--jq',
        '{behindBy: .behind_by, base: .base_commit.sha}',
      ]),
    ) as { behindBy: number; base: string }
    behindBy = compare.behindBy
    base = compare.base
    if (behindBy > 0) {
      prsInto = openPrs(run)
        .filter((pr) => pr.baseRef === candidate.headRefName)
        .map((pr) => pr.number)
        .sort((a, b) => a - b)
    }
  }
  const decision = followDecision(config, { candidate: candidate?.headRefName ?? null, behindBy, prsInto })
  log(`candidate: follow ${config.base}: ${decision.reason}`)
  if (decision.path === 'none' || !candidate) return { ...decision, outcome: 'none' }

  const name = candidate.headRefName
  const must = (args: string[]) => {
    const result = git.run(args)
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${pushError(result.stderr)}`)
    return result.stdout
  }
  const shallow = must(['rev-parse', '--is-shallow-repository']) === 'true'
  must([
    'fetch',
    '--no-tags',
    ...(shallow ? ['--unshallow'] : []),
    'origin',
    `+refs/heads/${config.base}:refs/remotes/origin/${config.base}`,
    `+refs/heads/${name}:refs/remotes/origin/${name}`,
  ])
  const fetched = must(['rev-parse', `refs/remotes/origin/${name}`])
  const oldHead = candidate.headRefOid ?? fetched
  if (fetched !== oldHead || git.run(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    log(
      `candidate: ${name} moved between the read (${short(oldHead)}) and the fetch (${short(fetched)}): left as it is, the next run follows ${config.base}.`,
    )
    return { ...decision, outcome: 'moved-meanwhile' }
  }

  const facts: FollowFacts = { candidate: name, base, oldHead, path: decision.path, prsInto }
  const result = decision.path === 'rebase' ? rebased(git, oldHead, base) : merged(git, facts, config.base)
  if ('files' in result) {
    log(
      `::warning title=Candidate not updated::${name}: the ${decision.path} on ${config.base} ${short(base)} stops on a conflict in ${workflowLine(result.files.join(', '))}; nothing pushed, what to do is on #${candidate.number}`,
    )
    commentOnce(run, candidate.number, followMarker(base, oldHead), followConflictComment(config, facts, result.files))
    return { ...decision, outcome: 'conflict', files: result.files }
  }

  const head = result.head
  const push = git.push(
    decision.path === 'rebase'
      ? [`--force-with-lease=refs/heads/${name}:${oldHead}`, 'origin', `${head}:refs/heads/${name}`]
      : ['origin', `${head}:refs/heads/${name}`],
  )
  if (push.status !== 0) {
    const error = pushError(push.stderr)
    log(
      `::warning title=Candidate not updated::${name}: the push of the ${decision.path} on ${config.base} ${short(base)} was refused (${workflowLine(error)}); what to do is on #${candidate.number}`,
    )
    commentOnce(run, candidate.number, followMarker(base, oldHead), followRefusedComment(config, facts, error))
    return { ...decision, outcome: 'refused', head }
  }
  log(
    `candidate: ${name} ${decision.path === 'rebase' ? 'rebased on' : 'merged with'} ${config.base} ${short(base)}: ${short(oldHead)} → ${short(head)}.`,
  )
  // The candidate is updated: a comment that fails is a warning, and does not stop the
  // comments on the other pull requests.
  const tell = (number: number, body: string) => {
    try {
      commentOnce(run, number, followedMarker(head), body)
    } catch (error) {
      log(
        `::warning title=Candidate updated, comment not written::${name} is at ${short(head)}; the comment on #${number} failed (${workflowLine((error as Error).message)})`,
      )
    }
  }
  tell(candidate.number, followedComment(config, facts, head))
  if (decision.path === 'merge') {
    for (const number of prsInto) tell(number, followedPrComment(config, facts, head))
  }
  return { ...decision, outcome: 'updated', head }
}

// The follow step inside a pull_request run: a failure is a warning, so the event is
// still handled.
function followOrWarn(run: Run) {
  try {
    follow(run)
  } catch (error) {
    run.log(
      `::warning title=Candidate not updated::following ${run.config.base} failed (${workflowLine((error as Error).message)}); the next run tries again`,
    )
  }
}

// The candidate is merged: its issues close, and the pull requests it left behind
// move. One failing does not stop the other; the run fails after both.
export function candidateMerged(run: Run, pr: PullRequest) {
  const errors: string[] = []
  for (const step of [closeCandidateIssues, carryOver]) {
    try {
      step(run, pr)
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
}

// What the event asks for: move, record, or close and carry over; first, the sweep of
// pull requests a dropped event left behind and the candidate following the base. Both
// run on every event: the concurrency group drops a pending run when a newer one
// arrives, and the newer one catches up.
export function handle(run: Run, action: string, pr: PullRequest) {
  sweep(run)
  followOrWarn(run)
  if (action === 'opened' || action === 'ready_for_review') retarget(run, pr)
  else if (action === 'closed' && isCandidateMerge(run.config, pr)) candidateMerged(run, pr)
  else if (action === 'closed') record(run, pr)
  else run.log(`candidate: event ${action}, nothing to do.`)
}

// A push to the base, or `--follow` from a terminal: the sweep, then the candidate
// following the base. An error escapes on purpose: following is the whole job of
// this run, so a failure turns it red (inside a pull_request run it is a warning).
export function handlePush(run: Run) {
  sweep(run)
  return follow(run)
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

export function prFromGh(gh: Gh, repo: string, number: number): PullRequest {
  const pr = JSON.parse(
    gh.read([
      'pr',
      'view',
      String(number),
      '--repo',
      repo,
      '--json',
      'number,title,body,baseRefName,headRefName,labels,mergedAt,author,isCrossRepository',
    ]),
  ) as {
    number: number
    title: string
    body: string | null
    baseRefName: string
    headRefName: string
    labels: Array<{ name: string }>
    mergedAt: string | null
    author?: { login: string } | null
    isCrossRepository?: boolean
  }
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
  }
}
