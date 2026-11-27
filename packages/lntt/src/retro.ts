// The candidate's retrospective comment: the comment holding the retrospective block
// that the candidate automation opens a candidate with, never rewritten by it. `lntt
// retro add` appends one item under one label as friction is met; `lntt check body` on a
// candidate checks that comment instead of the body, which the automation rebuilds at
// every squash. docs/process/delivery.md has the flow.
//
// Plain logic, no node: module and no Effect: lntt check body reads isCandidate here. The
// append runs on Effect over the Gh service (src/retro/command.ts).

import { candidateNumber } from './base/names.ts'
import type { CandidateConfig } from './ci/candidate.ts'

// How many writes an append gets when reading it back does not find it.
export const ATTEMPTS = 3

export function isCandidate(config: CandidateConfig | null, headRef: string): boolean {
  return config !== null && candidateNumber(config.prefix, headRef) !== null
}

// The item as one sentence: its line breaks folded, trimmed.
export const sentenceOf = (item: string) => item.replace(/\s*\r?\n\s*/g, ' ').trim()

// How many times `sentence` is in a body under `label`, as appendRetro writes it: on the
// label's line, or a sub-bullet. An append is kept when the count grew.
export function itemCount(body: string, label: string, sentence: string): number {
  return body.split(/\r?\n/).filter((l) => l.endsWith(`**${label}:** ${sentence}`) || l.trim() === `- ${sentence}`)
    .length
}
