// The candidate's retrospective comment: the comment holding the retrospective block
// that the candidate automation opens a candidate with, never rewritten by it. `lntt
// retro add` appends one item under one label as friction is met; `lntt check body` on a
// candidate checks that comment instead of the body, which the automation rebuilds at
// every squash. docs/process/delivery.md has the flow.

import { type CandidateConfig, candidateNumber, type Gh, openCandidate, retrospectiveComment } from './ci/candidate.ts'
import { appendRetro, findLabel, RETRO_START, type RetrospectiveRules, retrospectiveBlock } from './pull-request.ts'

export interface Comment {
  id: number
  body: string
}

export interface RetroRun {
  gh: Gh
  repo: string
  // delivery.candidate; without it there is no open candidate to find, only --pr.
  config: CandidateConfig | null
  rules: RetrospectiveRules
}

// A refusal with a reason the person can act on: no label, no open candidate.
export class RetroError extends Error {}

export function isCandidate(config: CandidateConfig | null, headRef: string): boolean {
  return config !== null && candidateNumber(config, headRef) !== null
}

// Every comment of the pull request, in order, read page by page.
export function comments(gh: Gh, repo: string, number: number): Comment[] {
  return gh
    .read(['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '.[] | {id, body}'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Comment)
}

// The retrospective comment: the first one holding the start marker on a line of its own,
// the one the automation wrote. A comment quoting the marker in prose is not it.
export function retroComment(all: Comment[]): Comment | null {
  return all.find((c) => (c.body ?? '').split(/\r?\n/).some((l) => l.trim() === RETRO_START)) ?? null
}

// Appends `item` under the label `wanted` names, on the pull request `pr` or the open
// candidate. A candidate opened before the automation wrote the comment gets one, with
// the item in it. Returns the pull request, the label and whether the comment was created.
export function retroAdd(
  run: RetroRun,
  { pr, label: wanted, item }: { pr?: number; label: string; item: string },
): { pr: number; label: string; created: boolean } {
  const label = findLabel(run.rules, wanted)
  if (label === null) throw new RetroError(`no label "${wanted}": one of ${run.rules.lines.join(', ')}`)
  const sentence = item.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (sentence === '') throw new RetroError('the item is empty: one sentence')
  const { config } = run
  const number = pr ?? (config === null ? undefined : openCandidate({ ...run, config })?.number)
  if (number === undefined) {
    const where = config === null ? 'no delivery.candidate' : `${config.prefix}<N> into ${config.base}`
    throw new RetroError(`no open candidate (${where}): give the pull request with --pr <n>`)
  }
  const found = retroComment(comments(run.gh, run.repo, number))
  if (found === null) {
    run.gh.write(
      ['pr', 'comment', String(number), '--repo', run.repo, '--body-file', '-'],
      appendRetro(
        config === null ? retrospectiveBlock(run.rules) : retrospectiveComment(config),
        label,
        sentence,
        run.rules,
      ),
    )
    return { pr: number, label, created: true }
  }
  run.gh.write(
    ['api', '-X', 'PATCH', `repos/${run.repo}/issues/comments/${found.id}`, '--input', '-'],
    JSON.stringify({ body: appendRetro(found.body, label, sentence, run.rules) }),
  )
  return { pr: number, label, created: false }
}
