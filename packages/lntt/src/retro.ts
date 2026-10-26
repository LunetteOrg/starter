// The candidate's retrospective comment: the comment holding the retrospective block
// that the candidate automation opens a candidate with, never rewritten by it. `lntt
// retro add` appends one item under one label as friction is met; `lntt check body` on a
// candidate checks that comment instead of the body, which the automation rebuilds at
// every squash. docs/process/delivery.md has the flow.

import {
  type CandidateConfig,
  candidateNumber,
  comments,
  type Gh,
  openCandidate,
  retrospectiveComment,
} from './ci/candidate.ts'
import { appendRetro, findLabel, type RetrospectiveRules, retroComment, retrospectiveBlock } from './pull-request.ts'

export interface RetroRun {
  gh: Gh
  repo: string
  // delivery.candidate; without it there is no open candidate to find, only --pr.
  config: CandidateConfig | null
  rules: RetrospectiveRules
  // A dry run writes nothing, so there is nothing to read back.
  dryRun?: boolean
}

// A refusal with a reason the person can act on: no label, no open candidate, an item
// that did not stay in the comment.
export class RetroError extends Error {}

// How many times an append is written when reading it back does not find it.
const ATTEMPTS = 3

export function isCandidate(config: CandidateConfig | null, headRef: string): boolean {
  return config !== null && candidateNumber(config, headRef) !== null
}

// Appends `item` under the label `wanted` names, on the pull request `pr` or the open
// candidate. A candidate opened before the automation wrote the comment gets one, with
// the item in it. The comment is rewritten whole, so two appends at the same moment
// could drop one: the comment is read back after the write and the append done again
// when the item is not in it. Returns the pull request, the label and whether the
// comment was created.
export function retroAdd(
  run: RetroRun,
  { pr, label: wanted, item }: { pr?: number; label: string; item: string },
): { pr: number; label: string; created: boolean } {
  const label = findLabel(run.rules, wanted)
  if (label === null) throw new RetroError(`no label "${wanted}": one of ${run.rules.lines.join(', ')}`)
  const sentence = item.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (sentence === '') throw new RetroError('the item is empty: one sentence')
  const { gh, repo, config } = run
  const number = pr ?? (config === null ? undefined : openCandidate({ ...run, config })?.number)
  if (number === undefined) {
    const where = config === null ? 'no delivery.candidate' : `${config.prefix}<N> into ${config.base}`
    throw new RetroError(`no open candidate (${where}): give the pull request with --pr <n>`)
  }
  // The item as appendRetro writes it: on the label's line, or a sub-bullet.
  const holds = (body: string) =>
    body.split(/\r?\n/).some((l) => l.endsWith(`**${label}:** ${sentence}`) || l.trim() === `- ${sentence}`)
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const found = retroComment(comments(gh, repo, number))
    if (found === null) {
      const empty = config === null ? retrospectiveBlock(run.rules) : retrospectiveComment(config)
      gh.write(
        ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'],
        appendRetro(empty, label, sentence, run.rules),
      )
      return { pr: number, label, created: true }
    }
    gh.write(
      ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${found.id}`, '--input', '-'],
      JSON.stringify({ body: appendRetro(found.body, label, sentence, run.rules) }),
    )
    if (run.dryRun) return { pr: number, label, created: false }
    if (holds(gh.read(['api', `repos/${repo}/issues/comments/${found.id}`, '--jq', '.body']))) {
      return { pr: number, label, created: false }
    }
  }
  throw new RetroError(
    `the item is not in the retrospective comment of #${number} after ${ATTEMPTS} writes: another append ran at the same time; run it again`,
  )
}
