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

// How many writes an append gets when reading it back does not find it.
const ATTEMPTS = 3

export function isCandidate(config: CandidateConfig | null, headRef: string): boolean {
  return config !== null && candidateNumber(config, headRef) !== null
}

// Appends `item` under the label `wanted` names, on the pull request `pr` or the open
// candidate. A candidate opened before the automation wrote the comment gets one, with
// the item in it. The comment is rewritten whole, so two appends at the same moment
// could drop one, and two creations make two comments: the comments are read again after
// the write, and the append done again on the retrospective comment when the item is
// not in it. Returns the pull request, the label and whether the comment was created.
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
  // How many times the item is in a body, as appendRetro writes it: on the label's line,
  // or a sub-bullet. An append is kept when the count grew.
  const count = (body: string) =>
    body.split(/\r?\n/).filter((l) => l.endsWith(`**${label}:** ${sentence}`) || l.trim() === `- ${sentence}`).length
  let created = false
  let before = 0
  // Each pass reads the comment: the first checks nothing, each later one checks the
  // write before it, and writes again when the item was dropped.
  for (let pass = 0; pass <= ATTEMPTS; pass++) {
    const found = retroComment(comments(gh, repo, number))
    if (pass > 0 && found !== null && count(found.body) > before) return { pr: number, label, created }
    if (pass === ATTEMPTS) break
    if (found === null) {
      const empty = config === null ? retrospectiveBlock(run.rules) : retrospectiveComment(config)
      gh.write(
        ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'],
        appendRetro(empty, label, sentence, run.rules),
      )
      created = true
      before = 0
    } else {
      before = count(found.body)
      gh.write(
        ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${found.id}`, '--input', '-'],
        JSON.stringify({ body: appendRetro(found.body, label, sentence, run.rules) }),
      )
    }
    if (run.dryRun) return { pr: number, label, created }
  }
  throw new RetroError(
    `the item is not in the retrospective comment of #${number} after ${ATTEMPTS} writes: another append ran at the same time; run it again`,
  )
}
